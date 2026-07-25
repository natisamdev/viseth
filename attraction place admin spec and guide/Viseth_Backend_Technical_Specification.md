# Viseth — Backend Technical Specification

**Audience:** the backend developer(s) building the Viseth API and data layer.
**Status:** build-ready. Everything needed to implement the backend is in this document.
**Companion doc:** `Viseth_Frontend_Integration_Guide.md` — how app/web clients call this API (write after/alongside backend).
**Surfaces served:** Customer App (Flutter), Staff App (Flutter), Attraction Admin (React web), Platform Admin (React web).
**Third parties (v1):** Chapa (payments), WisprFlow (STT), ElevenLabs (TTS), Fal (recs/summaries/cards), Firecrawl (+ Exa) (enrichment).

> Product in one line: Viseth is Ethiopia's verified digital travel passport. A traveller buys a ticket, scans a QR at the gate, and that scan — not a social post — becomes the proof they visited. Diaspora can buy tickets as gifts for family at home.

---

## Table of contents

1. [Architecture and conventions](#1-architecture-and-conventions)
2. [Identity, roles and authorisation](#2-identity-roles-and-authorisation)
3. [Data model](#3-data-model)
4. [Core invariants — read before writing code](#4-core-invariants--read-before-writing-code)
5. [API — Auth and profile](#5-api--auth-and-profile)
6. [API — Discovery and attractions](#6-api--discovery-and-attractions)
7. [API — Tickets, payments and gifting](#7-api--tickets-payments-and-gifting)
8. [API — Gate verification (Staff app)](#8-api--gate-verification-staff-app)
9. [API — Passport, visits and sharing](#9-api--passport-visits-and-sharing)
10. [API — Guides and bookings](#10-api--guides-and-bookings)
11. [API — Attraction Admin](#11-api--attraction-admin)
12. [API — Platform Admin](#12-api--platform-admin)
13. [API — Notifications and media](#13-api--notifications-and-media)
14. [Third-party integrations](#14-third-party-integrations)
15. [Screen → endpoint map (all four surfaces)](#15-screen--endpoint-map-all-four-surfaces)
16. [Scheduled jobs and triggers](#16-scheduled-jobs-and-triggers)
17. [Security rules, indexes, rate limits](#17-security-rules-indexes-rate-limits)
18. [Error catalogue](#18-error-catalogue)
19. [Environment, deployment and build order](#19-environment-deployment-and-build-order)

---

## 1. Architecture and conventions

### 1.1 Components

| Component | Technology | Responsibility |
|---|---|---|
| Custom API | Node 20 + Express (or Fastify), TypeScript, hosted on **Render** | All writes that require trust: payments, gate verification, account creation, AI calls, third-party keys |
| Auth | **Firebase Auth** (email/password, Google, phone OTP) | Identity + custom claims (`role`, `attractionId`, `staffId`) |
| Database | **Cloud Firestore** (native mode) | All documents |
| Object storage | **Firebase Cloud Storage** | Cover photos, post media, generated narration audio |
| Web clients | React + Vite on **Netlify** | Attraction Admin, Platform Admin |
| Mobile clients | Flutter | Customer App, Staff App |

**Read path:** clients may read Firestore directly where security rules allow (fast, realtime, offline cache).
**Write path:** everything that carries money, proof, or privilege goes through the custom API. Firestore rules deny those writes to clients outright.

### 1.2 Base URL and versioning

```
Production   https://api.viseth.et/v1
Staging      https://viseth-api-staging.onrender.com/v1
```

All paths in this document are relative to the versioned base. Breaking changes ship as `/v2`; additive fields never break a client.

### 1.3 Request conventions

- **Content type:** `application/json; charset=utf-8` (multipart only on the two upload endpoints).
- **Auth header:** `Authorization: Bearer <Firebase ID token>`. Verify with the Admin SDK on every request; never trust a `uid` in a body.
- **Locale header:** `Accept-Language: en` or `am`. Controls which localised fields are returned in `*Localised` helpers and which language notifications are sent in. Default `en`.
- **Idempotency:** `Idempotency-Key: <uuid>` is **required** on `POST /tickets`, `POST /tickets/{id}/pay`, and `POST /visits/verify`. Store the key with the response for 24h and replay the stored response on repeat.
- **Timestamps:** ISO 8601 UTC strings with `Z` (`2026-07-25T14:03:00Z`). Never local time, never Firestore `Timestamp` in JSON.
- **Money:** `amountEtb` is an **integer number of Birr** (no cents). Providers that need cents get `amount * 100` inside the adapter only.
- **IDs:** string, prefixed by type — `usr_`, `atr_`, `tkt_`, `vst_`, `gk_`, `gd_`, `bkg_`, `pst_`, `pay_`. Generate with `nanoid(16)` plus prefix. Never expose Firestore auto-IDs raw.
- **Language pairs:** any operator-authored text has an `X` and an `XAm` field (`name`/`nameAm`, `description`/`descriptionAm`). Amharic may be empty string; clients fall back to English.

### 1.4 Response envelope

Success returns the resource (or `{ items, nextCursor }` for lists) at the top level — no wrapper.

```json
{ "id": "tkt_9fA2...", "status": "paid", "amountEtb": 250 }
```

Lists are cursor-paginated:

```json
{
  "items": [ /* ... */ ],
  "nextCursor": "eyJjcmVhdGVkQXQiOiIyMDI2LTA3LTIwIn0=",
  "hasMore": true
}
```

Query params: `?limit=20&cursor=<opaque>`. `limit` max 100, default 20.

Errors always use this shape — clients read `code`, humans read `message`:

```json
{
  "error": {
    "code": "TICKET_ALREADY_USED",
    "message": "This ticket was already scanned at 09:14.",
    "messageAm": "ይህ ትኬት አስቀድሞ ተቃኝቷል።",
    "details": { "visitId": "vst_71bc", "verifiedAt": "2026-07-25T09:14:02Z" },
    "requestId": "req_01J2..."
  }
}
```

`requestId` is logged server-side and echoed in the `X-Request-Id` response header on every request, error or not.

### 1.5 HTTP status usage

| Status | Used for |
|---|---|
| 200 | Successful read / update |
| 201 | Resource created |
| 202 | Accepted async job (AI generation, enrichment) |
| 400 | Validation failure (`VALIDATION_FAILED` + `details.fields`) |
| 401 | Missing/invalid/expired token |
| 403 | Authenticated but wrong role or wrong `attractionId` scope |
| 404 | Not found, or found but out of the caller's scope (never leak existence) |
| 409 | Conflict — already used, already registered, capacity full |
| 422 | Provider rejected (payment declined) |
| 429 | Rate limited (`Retry-After` header set) |
| 500 | Unhandled — log with `requestId`, never leak stack traces |
| 503 | Third-party dependency down and no fallback available |

---

## 2. Identity, roles and authorisation

### 2.1 Roles

| Role | Created by | Signs in on | Scope |
|---|---|---|---|
| `visitor` | Self sign-up (phone OTP / Google) | Customer App | Own data only |
| `guide` | Attraction admin registers them | Staff App | Own profile + own bookings at their `attractionId` |
| `gatekeeper` | Attraction admin registers them | Staff App | Scan verification at their `attractionId` |
| `attraction_admin` | **Platform admin (super admin) creates the account** | Attraction Admin web | Exactly one `attractionId` |
| `super_admin` | Manually, by another super admin | Platform Admin web | Everything |

### 2.2 Custom claims

Set with `admin.auth().setCustomUserClaims(uid, {...})` at account creation. Claims are the **only** source of authorisation — never a field the client sends.

```json
{
  "role": "attraction_admin",
  "attractionId": "atr_adwa",
  "staffId": null
}
```

| Claim | Present for | Meaning |
|---|---|---|
| `role` | everyone | One of the five roles above |
| `attractionId` | `attraction_admin`, `gatekeeper`, `guide` | The single site the account may touch |
| `staffId` | `gatekeeper`, `guide` | The `gk_*` / `gd_*` document id, so the Staff app can load its own desk |

**Claim propagation:** claims land in the client's ID token only after refresh. Any endpoint that creates an account must return the created document, and the client must call `getIdToken(true)` after its own first sign-in. Document this in the integration guide.

### 2.3 Authorisation middleware (implement once, apply everywhere)

```ts
requireAuth()                       // verifies ID token, attaches req.auth
requireRole('attraction_admin')     // 403 if claim mismatch
requireStaff()                      // gatekeeper OR guide
requireSameAttraction(param)        // 403 unless req.auth.attractionId === resolved attractionId
requireSelf(param)                  // 403 unless uid matches, super_admin bypasses
```

Order matters: `requireAuth` → `requireRole` → `requireSameAttraction` → handler. Every endpoint table below names the exact middleware chain.

### 2.4 Account creation rules

- An attraction admin **must not** call `createUserWithEmailAndPassword` from the browser — the Firebase client SDK would swap the operator's own session for the new account. Staff accounts are created **server-side only** through `POST /gatekeepers` and `POST /guides`.
- Passwords reach Firebase Auth and are **never** written to Firestore. Reject any payload that tries to persist one.
- Temporary passwords are flagged: set `mustChangePassword: true` on the staff document; the Staff app forces a change on first sign-in via `POST /auth/change-password`.

---

## 3. Data model

Firestore, native mode. Field types are TypeScript for clarity; store dates as ISO strings so every surface reads them identically.

### 3.1 `users/{uid}`

| Field | Type | Notes |
|---|---|---|
| `uid` | string | Firebase Auth uid, equals doc id |
| `displayName` | string | |
| `phone` | string \| null | E.164, `+2519...` |
| `email` | string \| null | |
| `photoUrl` | string \| null | Storage URL |
| `role` | `'visitor' \| 'guide' \| 'gatekeeper' \| 'attraction_admin' \| 'super_admin'` | Mirrors the claim for querying |
| `locale` | `'en' \| 'am'` | Default `'en'` |
| `country` | string | ISO-3166 alpha-2; `ET` or diaspora country |
| `isDiaspora` | boolean | `country !== 'ET'`, recomputed on profile update |
| `passport` | `Passport` | Denormalised, see below — recomputed on every verified visit |
| `pushTokens` | string[] | FCM tokens, max 10, de-duplicated |
| `createdAt` / `lastActiveAt` | string | |
| `disabled` | boolean | Set by super admin; also disable in Auth |

```ts
type Passport = {
  heritageScore: number;        // 0-1000, see §9.4 formula
  title: string;                // derived, e.g. 'Highland Wanderer'
  visitCount: number;           // verified visits only
  regionsVisited: string[];     // distinct attraction.region
  streakDays: number;           // consecutive months with >=1 visit, see §16.3
  longestStreakDays: number;
  lastVisitAt: string | null;
};
```

### 3.2 `attractions/{id}`

Owned by super admin; the operator edits a restricted field set.

| Field | Type | Editable by attraction admin |
|---|---|---|
| `id` | string | – |
| `name` | string | **No — super admin only** |
| `nameAm` | string | Yes |
| `description` | string | Yes |
| `descriptionAm` | string | Yes |
| `region` | string | Yes |
| `category` | `'museum' \| 'park' \| 'historical' \| 'resort' \| 'natural'` | Yes |
| `priceEtb` | number | Yes |
| `childPriceEtb` | number \| null | Yes |
| `hours` | string (free text) | Yes |
| `closedDays` | string | Yes |
| `entryNotes` | string | Yes |
| `phone` / `address` / `website` | string | Yes |
| `imageUrl` | string \| null | Yes (via upload endpoint) |
| `location` | `{ lat: number, lng: number }` | Yes |
| `status` | `'live' \| 'draft'` | Yes |
| `requiresTicket` | boolean | Yes — when false, entry is a free but still QR-verified check-in |
| `peoplePerTicket` | number | Yes |
| `dailyCapacity` | number (0 = unlimited) | Yes |
| `ticketValidDays` | number | Yes |
| `visitDurationMinutes` | number | Yes |
| `allowsGifting` | boolean | Yes |
| `ownerUid` | string | **No** |
| `enrichedFacts` | `{ summary, sourceUrl, fetchedAt }` \| null | **No — Firecrawl/Exa job only** |
| `narration` | `{ [locale]: { audioUrl, voiceId, generatedAt } }` | **No — ElevenLabs job only** |
| `searchKeywords` | string[] | **No — derived server-side** on write |
| `createdAt` / `updatedAt` / `createdBy` | | |

### 3.3 `tickets/{id}`

| Field | Type | Notes |
|---|---|---|
| `id` | string | `tkt_*` |
| `attractionId` | string | |
| `buyerUid` | string | Who paid |
| `recipientUid` | string \| null | Set once a gifted ticket is claimed |
| `recipientHandle` | string \| null | Phone or @handle typed by the diaspora buyer |
| `recipientName` | string \| null | Used for the named greeting at the gate |
| `giftMessage` | string \| null | Max 240 chars |
| `keycodeHash` | string | **SHA-256 of the keycode. Never store the plaintext.** |
| `keycodeLast4` | string | For human-readable display in admin tables |
| `amountEtb` | number | 0 when `requiresTicket === false` |
| `partySize` | number | ≤ `attraction.peoplePerTicket` |
| `status` | `'pending' \| 'paid' \| 'used' \| 'expired' \| 'refunded' \| 'cancelled'` | |
| `paymentId` | string \| null | → `payments/{id}` |
| `visitDate` | string (date only) \| null | Optional booked date |
| `expiresAt` | string | `paidAt + attraction.ticketValidDays` |
| `createdAt` / `paidAt` / `usedAt` | string \| null | |

**Status machine.** `pending → paid → used`; `pending → cancelled` (abandoned/failed payment); `paid → expired` (job, §16.1); `paid → refunded` (super admin only). No other transition is legal — enforce in a single `transitionTicket()` helper, not scattered across handlers.

### 3.4 `visits/{id}` — append-only, the proof record

| Field | Type |
|---|---|
| `id` | string `vst_*` |
| `ticketId` | string |
| `attractionId` | string |
| `visitorUid` | string |
| `gatekeeperUid` | string |
| `gateLabel` | string |
| `partySize` | number |
| `verifiedAt` | string |
| `deviceId` | string — Staff app install id, for audit |

**No update. No delete. Ever.** Rules deny it, the API exposes no such route, and a correction is a new `visitCorrections` entry reviewed by a super admin.

### 3.5 `gatekeepers/{id}` and `guides/{id}`

```ts
type Gatekeeper = {
  id: string; uid: string;            // uid links to Firebase Auth
  name: string; phone: string; email: string;
  employeeId: string; attractionId: string;
  gateLabel: string; shift: 'Morning' | 'Afternoon' | 'Full day';
  active: boolean; scanCount: number;
  mustChangePassword: boolean; createdAt: string;
};

type Guide = {
  id: string; uid: string;
  name: string; nameAm: string; phone: string; email: string;
  licenceNumber: string; licenceExpiry: string;   // ISO date
  yearsExperience: number; languages: string[];
  bio: string; bioAm: string; photoUrl: string | null;
  attractionId: string;                            // registered per site
  status: 'active' | 'suspended';
  ratingAvg: number; ratingCount: number;
  mustChangePassword: boolean; registeredAt: string;
};
```

### 3.6 `guideBookings/{id}`

| Field | Type |
|---|---|
| `id` | `bkg_*` |
| `guideId` / `attractionId` / `visitorUid` | string |
| `ticketId` | string \| null — links the tour to a real ticket when there is one |
| `date` | string (date only) |
| `partySize` | number |
| `language` | string |
| `priceEtb` | number |
| `status` | `'requested' \| 'confirmed' \| 'declined' \| 'completed' \| 'cancelled'` |
| `note` | string |
| `createdAt` / `updatedAt` | string |

### 3.7 `posts/{id}` — proof-backed sharing

A post **must** reference a verified visit. That is the whole product thesis: no visit, no post.

| Field | Type |
|---|---|
| `id` | `pst_*` |
| `visitId` | string — required, must belong to `authorUid` |
| `attractionId` | string |
| `authorUid` | string |
| `caption` | string (max 500) |
| `mediaUrls` | string[] (max 6) |
| `voiceStory` | `{ audioUrl, transcript, transcriptAm, durationSec, narratedAudioUrl } \| null` |
| `visibility` | `'public' \| 'followers' \| 'private'` |
| `likeCount` / `commentCount` | number (denormalised counters) |
| `status` | `'active' \| 'hidden' \| 'removed'` — moderation |
| `createdAt` | string |

Supporting collections: `likes/{postId}_{uid}`, `comments/{id}`, `follows/{followerUid}_{followeeUid}`.

### 3.8 `payments/{id}` — provider ledger

| Field | Type |
|---|---|
| `id` | `pay_*` |
| `ticketId` | string |
| `payerUid` | string |
| `provider` | `'chapa'` |
| `providerRef` | string — Chapa `reference` (their id) |
| `merchantOrderId` | string — our `tx_ref` sent to Chapa, unique (`VISETH-{ticketId}-{attempt}`) |
| `amountEtb` | number |
| `status` | `'initiated' \| 'succeeded' \| 'failed' \| 'refunded'` |
| `rawInitResponse` / `rawCallback` | map — store verbatim for reconciliation |
| `createdAt` / `settledAt` | string |

### 3.9 Supporting collections

| Collection | Purpose |
|---|---|
| `notifications/{id}` | `{ uid, kind, title, titleAm, body, bodyAm, href, read, createdAt }` |
| `auditLogs/{id}` | `{ actorUid, actorRole, action, targetType, targetId, before, after, ip, createdAt }` — written for every privileged write |
| `enrichmentJobs/{id}` | Firecrawl/Exa job state |
| `aiJobs/{id}` | Transcription / narration / image job state |
| `idempotencyKeys/{key}` | `{ uid, endpoint, responseBody, statusCode, createdAt }`, TTL 24h |
| `config/app` | Single doc: feature flags, `giftingEnabled`, `minAppVersion`, maintenance banner |

---

## 4. Core invariants — read before writing code

These are the rules a technical judge will probe. Break one and the product's claim of "proof" collapses.

1. **A visit is created only by the gate-verification endpoint**, only after the server re-hashes the scanned keycode and matches it against `tickets.keycodeHash`. The scan payload is never trusted as evidence of anything.
2. **`visits` is append-only.** Clients cannot create, update, or delete. Rules: `allow create, update, delete: if false`.
3. **The plaintext keycode never leaves the buyer's device store.** The server stores only `keycodeHash` and `keycodeLast4`.
4. **Every query is scoped by the caller's `attractionId` claim**, not by an id in the request body. An attraction admin asking for another site gets 404, not 403 — do not confirm existence.
5. **The English attraction `name` is immutable to operators.** Strip it from any `PATCH /attractions/{id}` body coming from an `attraction_admin`.
6. **Payment success is confirmed by the Chapa webhook (HMAC-verified) plus optional verify API**, never by the mobile client returning to the app. The client only polls our own ticket status.
7. **Money and party size are validated server-side** against the live attraction document: `amountEtb` is recomputed, never accepted from the client.
8. **Capacity is enforced at scan time**, not at purchase time — a site with `dailyCapacity` full returns `CAPACITY_REACHED` on verify, and the admin sees it on the dashboard.
9. **Third-party API keys exist only on the server.** No Flutter or React bundle ever contains a Chapa, WisprFlow, ElevenLabs, Fal, Firecrawl, or Exa key.
10. **Every privileged write emits an `auditLogs` entry** with actor, before, and after.

---

## 5. API — Auth and profile

### 5.1 `POST /auth/session`

Called once after any Firebase sign-in to create or refresh the `users` document.

**Auth:** `requireAuth()` (any role)

Request:
```json
{ "displayName": "Eyerusalem Mekonnen", "locale": "am", "country": "ET", "pushToken": "fcm_..." }
```

Response `200`:
```json
{
  "uid": "usr_8Fk2",
  "displayName": "Eyerusalem Mekonnen",
  "role": "visitor",
  "attractionId": null,
  "staffId": null,
  "locale": "am",
  "isDiaspora": false,
  "mustChangePassword": false,
  "passport": { "heritageScore": 340, "title": "Highland Wanderer", "visitCount": 7,
                "regionsVisited": ["Addis Ababa","Amhara"], "streakDays": 3, "lastVisitAt": "2026-07-20T09:12:00Z" }
}
```

Behaviour: upsert the user doc; if the account has no `role` claim yet, set `role: 'visitor'`. Return the resolved claims so the client knows which app shell to render.

### 5.2 `GET /auth/me`

**Auth:** `requireAuth()` — returns the same body as above. Clients call this on cold start.

### 5.3 `POST /auth/change-password`

**Auth:** `requireAuth()`. For staff on first sign-in.

Request: `{ "newPassword": "..." }` (min 8 chars, must differ from the temp password)
Response `204`. Side effect: clears `mustChangePassword` on the staff document, writes an audit log.

### 5.4 `PATCH /users/me`

**Auth:** `requireAuth()`

Request (all optional): `{ "displayName", "photoUrl", "locale", "country", "phone" }`
Response `200`: the updated user. Recomputes `isDiaspora`.

### 5.5 `POST /users/me/push-tokens` · `DELETE /users/me/push-tokens/{token}`

**Auth:** `requireAuth()`. Adds/removes an FCM token. Response `204`.

---

## 6. API — Discovery and attractions

### 6.1 `GET /attractions`

**Auth:** public (no token required — the catalogue is browsable before sign-up).

Query params:

| Param | Type | Notes |
|---|---|---|
| `q` | string | Free text; matches `searchKeywords`, name, nameAm |
| `region` | string | Exact |
| `category` | string | Exact |
| `maxPriceEtb` | number | |
| `freeOnly` | boolean | `requiresTicket === false` |
| `nearLat`,`nearLng`,`radiusKm` | number | Geo filter (geohash prefix query) |
| `sort` | `'popular' \| 'nearest' \| 'priceAsc' \| 'newest'` | Default `popular` |
| `limit`,`cursor` | | |

Only `status === 'live'` is ever returned to visitors.

Response `200`:
```json
{
  "items": [{
    "id": "atr_adwa",
    "name": "Adwa Victory Memorial Museum",
    "nameAm": "የአድዋ ድል መታሰቢያ ሙዚየም",
    "region": "Addis Ababa",
    "category": "museum",
    "priceEtb": 250,
    "requiresTicket": true,
    "imageUrl": "https://storage.../cover.jpg",
    "visitDurationMinutes": 90,
    "verifiedVisitCount": 1284,
    "distanceKm": 3.2
  }],
  "nextCursor": null,
  "hasMore": false
}
```

`verifiedVisitCount` is a denormalised counter on the attraction, incremented by the visit trigger (§16.4). Never aggregate `visits` at read time.

### 6.2 `GET /attractions/{id}`

**Auth:** public. Returns the full document plus:

```json
{
  "enrichedFacts": { "summary": "Commemorates the 1896 Battle of Adwa...", "sourceUrl": "https://...", "fetchedAt": "2026-07-21T09:12:00Z" },
  "narration": { "am": { "audioUrl": "https://storage.../narration-am.mp3", "generatedAt": "2026-07-22T11:00:00Z" } },
  "guides": [{ "id": "gd_01", "name": "Feven Getnet", "languages": ["Amharic","English"], "ratingAvg": 4.8, "yearsExperience": 6 }],
  "todayCapacity": { "dailyCapacity": 45, "peopleToday": 31, "capacityPct": 69 }
}
```

Only `status: 'active'` guides are included. `404` if the attraction is `draft` and the caller is not its operator or a super admin.

### 6.3 `GET /attractions/{id}/availability?date=2026-07-28`

**Auth:** public. Response:
```json
{ "date": "2026-07-28", "open": true, "remainingCapacity": 14, "closedReason": null, "hours": "Tue–Sun, 8:30am – 5:30pm" }
```
`open: false` with `closedReason: "Mondays · public holidays"` when the date matches `closedDays`.

### 6.4 `POST /attractions/{id}/narration`

**Auth:** `requireRole('attraction_admin' | 'super_admin')` + `requireSameAttraction`. Triggers ElevenLabs generation (§14.3). Response `202` with `{ "jobId": "aij_..." }`.

---

## 7. API — Tickets, payments and gifting

This is the money path. Follow it exactly.

### 7.1 `POST /tickets` — create a pending ticket

**Auth:** `requireAuth()`, role `visitor`. **Idempotency-Key required.**

Request:
```json
{
  "attractionId": "atr_adwa",
  "partySize": 3,
  "visitDate": "2026-07-28",
  "gift": {
    "recipientHandle": "+251911204118",
    "recipientName": "Almaz Wolde",
    "message": "Enjoy this, Mum. See you in December."
  }
}
```
`gift` is omitted for a normal purchase.

**Server validation:**
1. Attraction exists and is `live`. → `404`
2. `partySize` ≥ 1 and ≤ `peoplePerTicket`. → `400 VALIDATION_FAILED`
3. `gift` present ⇒ `attraction.allowsGifting` is true and `config/app.giftingEnabled` is true. → `409 GIFTING_DISABLED`
4. `visitDate` is not a closed day and is within `ticketValidDays` of today. → `400`
5. Recompute price: `amountEtb = requiresTicket ? priceEtb * partySize : 0`. **Never read a price from the request.**
6. Generate keycode: 8 chars, Crockford base32, uppercase (e.g. `7QK4M2XB`). Store `keycodeHash = sha256(keycode + PEPPER)` and `keycodeLast4`.

Response `201`:
```json
{
  "id": "tkt_9fA2kd",
  "status": "pending",
  "amountEtb": 750,
  "partySize": 3,
  "keycode": "7QK4M2XB",
  "qrPayload": "viseth://t/tkt_9fA2kd/7QK4M2XB",
  "expiresAt": "2026-08-27T00:00:00Z",
  "requiresPayment": true
}
```

The **plaintext keycode and `qrPayload` are returned exactly once, here**. The client stores them in secure storage and renders the QR offline. Subsequent `GET /tickets/{id}` returns only `keycodeLast4`.

When `requiresTicket === false`, the ticket is created directly as `paid` with `amountEtb: 0` and `requiresPayment: false` — a free but still verified check-in.

### 7.2 `POST /tickets/{id}/pay` — start Chapa payment

**Auth:** `requireAuth()` + ticket owner. **Idempotency-Key required.**

Request: `{ "returnUrl": "viseth://payment/return" }`

Server: creates `payments/{id}` with `status: 'initiated'` and a unique `merchantOrderId` (= Chapa `tx_ref`), calls the Chapa adapter (§14.1), stores `rawInitResponse`.

Response `200`:
```json
{
  "paymentId": "pay_3Kd8",
  "checkoutUrl": "https://checkout.chapa.co/checkout/payment/xyz...",
  "merchantOrderId": "VISETH-tkt_9fA2kd-01",
  "expiresAt": "2026-07-25T14:18:00Z"
}
```

The client opens `checkoutUrl` in a webview/browser. **The client's return from that webview means nothing** — it only triggers polling of `GET /tickets/{id}`.

### 7.3 `POST /webhooks/chapa` — payment webhook

**Auth:** none (public), but **HMAC signature-verified** (`Chapa-Signature` / `x-chapa-signature`). Reject anything failing verification with `401` and log it.

1. Verify signature per §14.1.
2. Look up `payments` by `merchantOrderId` (= payload `tx_ref`). Unknown → `200` with `{ "ignored": true }` (never 500 at a provider).
3. Idempotent: if already `succeeded`, return `200` without side effects.
4. On success (`status === 'success'`): optionally re-verify via `GET https://api.chapa.co/v1/transaction/verify/{tx_ref}`, then set `payments.status = 'succeeded'`, `settledAt`, `providerRef`, then in a **Firestore transaction** set the ticket `status: 'paid'`, `paidAt`, `expiresAt = paidAt + ticketValidDays`.
5. Fire notifications: buyer → "Ticket confirmed"; if gifted and the recipient handle maps to a user → "You've received a gift visit".
6. On failure: `payments.status = 'failed'`, ticket → `cancelled`, notify buyer.

Always respond `200` within 5 seconds; do heavy work after acknowledging.

### 7.4 `GET /tickets/{id}`

**Auth:** buyer, recipient, the attraction's admin, or super admin.

```json
{
  "id": "tkt_9fA2kd", "attractionId": "atr_adwa", "attractionName": "Adwa Victory Memorial Museum",
  "status": "paid", "amountEtb": 750, "partySize": 3, "keycodeLast4": "2XB",
  "visitDate": "2026-07-28", "expiresAt": "2026-08-27T00:00:00Z",
  "gift": { "recipientName": "Almaz Wolde", "recipientHandle": "+2519...118", "claimed": true },
  "visit": { "id": "vst_71bc", "verifiedAt": "2026-07-28T09:14:02Z", "gateLabel": "Main Entrance" }
}
```

### 7.5 `GET /tickets` — the wallet

**Auth:** `requireAuth()`. Returns the caller's tickets (bought **and** received as gifts).
Query: `?status=paid|used|expired|all&role=buyer|recipient&limit=&cursor=`

### 7.6 `POST /tickets/{id}/claim`

**Auth:** `requireAuth()`. A gifted ticket whose `recipientHandle` matches the caller's verified phone binds `recipientUid` to them. `409 ALREADY_CLAIMED` if bound to someone else.

### 7.7 `POST /tickets/{id}/cancel`

**Auth:** buyer, only while `status === 'pending'`. Response `200` with the cancelled ticket.

### 7.8 `POST /tickets/{id}/refund`

**Auth:** `requireRole('super_admin')` only. Calls the Chapa refund/transfer path (or marks refunded after manual Chapa dashboard action + reconcile), sets ticket `refunded`, writes audit log. Refunds are **never** available to attraction admins.

---

## 8. API — Gate verification (Staff app)

The single most important endpoint in the product.

### 8.1 `POST /visits/verify`

**Auth:** `requireAuth()` + `requireRole('gatekeeper')`. **Idempotency-Key required.**

Request:
```json
{ "qrPayload": "viseth://t/tkt_9fA2kd/7QK4M2XB", "deviceId": "and_9f2b3c", "scannedAt": "2026-07-28T09:14:01Z" }
```

Manual fallback when a QR will not scan:
```json
{ "ticketId": "tkt_9fA2kd", "keycode": "7QK4M2XB", "deviceId": "and_9f2b3c" }
```

**Verification sequence — do not reorder:**

1. Parse `qrPayload` into `ticketId` + `keycode`. Malformed → `400 QR_MALFORMED`.
2. Load the ticket. Missing → `404 TICKET_NOT_FOUND`.
3. `ticket.attractionId === auth.attractionId`, else `403 WRONG_SITE` (a ticket for Lalibela must fail at Adwa's gate).
4. Gatekeeper document is `active`, else `403 GATEKEEPER_DISABLED`.
5. `sha256(keycode + PEPPER) === ticket.keycodeHash`, else `403 KEYCODE_MISMATCH` — this is the line that makes a scan proof rather than a claim.
6. `status === 'paid'`. `used` → `409 TICKET_ALREADY_USED` (include the existing visit). `expired` → `409 TICKET_EXPIRED`. `pending` → `409 TICKET_UNPAID`.
7. `expiresAt` is in the future, else transition to `expired` and return `409 TICKET_EXPIRED`.
8. Capacity: if `dailyCapacity > 0` and `peopleToday + partySize > dailyCapacity` → `409 CAPACITY_REACHED`.
9. **Transaction:** create the `visits` document, set ticket `status: 'used'` + `usedAt`, increment `gatekeepers.scanCount`, increment the attraction's daily counter and `verifiedVisitCount`.
10. After commit: recompute the visitor's passport (§9.4), push "Visit verified" to the visitor, and — if gifted — push "Your gift was used" to the buyer.

Response `201`:
```json
{
  "visitId": "vst_71bc",
  "verifiedAt": "2026-07-28T09:14:02Z",
  "visitor": { "displayName": "Almaz Wolde", "photoUrl": null, "isGiftRecipient": true },
  "greeting": { "line": "Welcome, Almaz.", "lineAm": "እንኳን ደህና መጡ፣ አልማዝ።", "giftedByLabel": "Gift from family abroad" },
  "ticket": { "partySize": 3, "amountEtb": 750, "attractionName": "Adwa Victory Memorial Museum" },
  "capacity": { "peopleToday": 34, "dailyCapacity": 45 }
}
```

`greeting` exists so the gatekeeper can call a diaspora-gifted visitor by name — the moment the product is built around. Return it for every visit; for non-gifted visits `giftedByLabel` is `null`.

### 8.2 `GET /staff/me`

**Auth:** `requireStaff()`. Returns the gatekeeper or guide document plus the attraction summary, so the Staff app can render the right desk without knowing the role in advance.

```json
{
  "role": "gatekeeper",
  "profile": { "id": "gk_01", "name": "Girma Tadesse", "gateLabel": "Main Entrance", "shift": "Morning", "active": true, "scanCount": 214, "mustChangePassword": false },
  "attraction": { "id": "atr_adwa", "name": "Adwa Victory Memorial Museum", "nameAm": "የአድዋ ድል መታሰቢያ ሙዚየም" }
}
```

### 8.3 `GET /staff/gate/today`

**Auth:** `requireRole('gatekeeper')`. Today's numbers for the signed-in gate.

```json
{ "date": "2026-07-28", "scansByMe": 41, "peopleToday": 34, "dailyCapacity": 45,
  "capacityPct": 76, "lastScanAt": "2026-07-28T09:14:02Z" }
```

### 8.4 `GET /staff/gate/expected`

**Auth:** `requireRole('gatekeeper')`. Paid, unused, gifted tickets for today at this site — the named-greeting queue.

```json
{ "items": [{ "ticketId": "tkt_9fA2kd", "recipientName": "Almaz Wolde", "partySize": 3,
              "keycodeLast4": "2XB", "giftedByLabel": "Gift from family abroad" }] }
```

---

## 9. API — Passport, visits and sharing

### 9.1 `GET /passport/me`

**Auth:** `requireAuth()`

```json
{
  "heritageScore": 340,
  "title": "Highland Wanderer",
  "nextTitle": { "name": "Heritage Keeper", "atScore": 500 },
  "visitCount": 7,
  "regionsVisited": ["Addis Ababa", "Amhara", "Tigray"],
  "regionsTotal": 12,
  "streakDays": 3,
  "longestStreakDays": 5,
  "lastVisitAt": "2026-07-20T09:12:00Z",
  "recentVisits": [{ "visitId": "vst_71bc", "attractionName": "Adwa Victory Memorial Museum",
                     "attractionImageUrl": "https://...", "verifiedAt": "2026-07-20T09:12:00Z", "hasPost": true }]
}
```

### 9.2 `GET /users/{uid}/passport` — public passport

**Auth:** optional. Respects the owner's `visibility` preference; returns score, title, visit count, regions, and **public** posts only. This is what a shared passport link renders.

### 9.3 `GET /visits/me`

**Auth:** `requireAuth()`. Paginated verified visit history, newest first, each with attraction summary and the linked post if any.

### 9.4 Heritage score formula (implement exactly — the apps display it)

```
heritageScore =
    (verifiedVisits        × 30)
  + (distinctAttractions   × 20)
  + (distinctRegions       × 40)
  + (streakDays            × 15)
  + (postsWithVoiceStory   × 10)
capped at 1000
```

Titles by score band:

| Score | Title (en) | Title (am) |
|---|---|---|
| 0–99 | First Steps | የመጀመሪያ እርምጃ |
| 100–299 | Highland Wanderer | የደጋ ተጓዥ |
| 300–599 | Heritage Keeper | የቅርስ ጠባቂ |
| 600–899 | Chronicle Bearer | የታሪክ ተሸካሚ |
| 900–1000 | Guardian of Adwa | የአድዋ ዘብ |

Recompute in the post-visit trigger and after any post creation. Store the result on `users.passport`; never compute at read time.

### 9.5 `POST /posts`

**Auth:** `requireAuth()`. Creating a post requires a visit the caller owns.

Request:
```json
{
  "visitId": "vst_71bc",
  "caption": "Standing where 1896 was decided.",
  "mediaUrls": ["https://storage.../p1.jpg"],
  "voiceStory": { "audioUrl": "https://storage.../story.m4a" },
  "visibility": "public"
}
```

Server: verify `visits/{visitId}.visitorUid === auth.uid`, else `403 VISIT_NOT_YOURS`. One post per visit → `409 POST_EXISTS`. If `voiceStory.audioUrl` is present, enqueue transcription + narration (§14.2, §14.3) and return the post with `voiceStory.transcript: null` and `processing: true`.

Response `201`: the post document.

### 9.6 `GET /feed`

**Auth:** `requireAuth()`. Query `?scope=following|discover|attraction&attractionId=`. Returns proof-backed posts only, each carrying its verification badge:

```json
{
  "items": [{
    "id": "pst_4dK1",
    "author": { "uid": "usr_8Fk2", "displayName": "Eyerusalem M.", "photoUrl": null, "title": "Heritage Keeper" },
    "attraction": { "id": "atr_adwa", "name": "Adwa Victory Memorial Museum" },
    "verified": { "visitId": "vst_71bc", "verifiedAt": "2026-07-20T09:12:00Z" },
    "caption": "Standing where 1896 was decided.",
    "mediaUrls": ["https://..."],
    "voiceStory": { "narratedAudioUrl": "https://...", "transcript": "..." },
    "likeCount": 24, "likedByMe": false, "createdAt": "2026-07-20T10:02:00Z"
  }],
  "nextCursor": "..."
}
```

### 9.7 Social actions

| Endpoint | Auth | Notes |
|---|---|---|
| `POST /posts/{id}/like` · `DELETE /posts/{id}/like` | visitor | Idempotent, updates the counter transactionally |
| `POST /posts/{id}/comments` | visitor | `{ "body": "..." }`, max 300 chars |
| `GET /posts/{id}/comments` | visitor | Paginated |
| `POST /users/{uid}/follow` · `DELETE /users/{uid}/follow` | visitor | Cannot follow self |
| `POST /posts/{id}/report` | visitor | `{ "reason": "..." }` → moderation queue |
| `DELETE /posts/{id}` | author or super admin | Soft delete, `status: 'removed'` |

---

## 10. API — Guides and bookings

### 10.1 `GET /attractions/{id}/guides`

**Auth:** public. Active guides at the site, with `languages`, `ratingAvg`, `yearsExperience`, `photoUrl`, `bio`/`bioAm`. Never returns email, phone, or licence number to visitors.

### 10.2 `POST /bookings`

**Auth:** `requireAuth()`, role `visitor`.

Request: `{ "guideId": "gd_01", "date": "2026-07-28", "partySize": 3, "language": "Amharic", "ticketId": "tkt_9fA2kd", "note": "..." }`

Validation: guide is `active`, licence not expired on `date` (`409 GUIDE_LICENCE_EXPIRED`), guide belongs to the ticket's attraction. Response `201` with the booking in `requested`. Notifies the guide.

### 10.3 `GET /bookings/me`

**Auth:** `requireAuth()`. As visitor: their bookings. As guide (`requireStaff()`): bookings assigned to them. Query `?status=&from=&to=`.

### 10.4 `PATCH /bookings/{id}`

**Auth:** guide (own bookings) or the booking's visitor.

Request: `{ "status": "confirmed" }`

Allowed transitions: guide may `requested → confirmed | declined`, `confirmed → completed`; visitor may `requested | confirmed → cancelled`. Anything else → `409 INVALID_TRANSITION`. Notifies the counterparty.

### 10.5 `POST /bookings/{id}/rate`

**Auth:** the booking's visitor, only when `status === 'completed'`. `{ "rating": 5, "comment": "..." }`. Updates `guides.ratingAvg` / `ratingCount` transactionally. One rating per booking.

---

## 11. API — Attraction Admin

Every endpoint here is `requireRole('attraction_admin')` + `requireSameAttraction`, and every one resolves the site from the **claim**, not the URL. The paths carry `{attractionId}` only for clarity; a mismatch is a 404.

### 11.1 `GET /admin/attractions/{attractionId}`

Returns the full attraction document including `draft` status and operator-only fields.

### 11.2 `PATCH /admin/attractions/{attractionId}`

Request: any subset of the editable fields in §3.2.

```json
{ "nameAm": "የአድዋ ድል መታሰቢያ ሙዚየም", "descriptionAm": "...", "priceEtb": 250,
  "hours": "Tue–Sun, 8:30am – 5:30pm", "region": "Addis Ababa", "status": "live" }
```

Server: **delete `name`, `ownerUid`, `enrichedFacts`, `narration`, `verifiedVisitCount` from the patch before writing** — those are not operator-editable. Rebuild `searchKeywords`. Write `updatedAt` and an audit log. Response `200` with the full updated attraction.

### 11.3 `POST /admin/attractions/{attractionId}/cover` (multipart)

Field `file`. Max 5 MB, `image/*` only, else `400 INVALID_IMAGE`. Stores at `attractions/{attractionId}/cover-{ts}` and returns `{ "imageUrl": "https://..." }`. The URL is persisted only when the operator saves the listing — an abandoned upload never mutates the document.

### 11.4 `GET /admin/attractions/{attractionId}/summary?days=30`

The dashboard's single fetch. Return everything the stat cards, capacity bar, and chart need in one payload — do not make the client issue four reads.

```json
{
  "ticketsSold": 168, "revenueEtb": 41250, "verifiedVisits": 143, "uniqueVisitors": 121,
  "giftedTickets": 24, "expiredTickets": 11,
  "peopleToday": 34, "dailyCapacity": 45, "capacityPct": 76, "requiresTicket": true,
  "daily": [{ "date": "2026-06-26", "revenueEtb": 1250, "visits": 5, "people": 11 }]
}
```

`daily` always contains exactly `days` entries, zero-filled for days with no trading, oldest first.

### 11.5 `GET /admin/attractions/{attractionId}/visits?limit=20&cursor=`

Recent verified visits, newest first, joined with visitor and gatekeeper names:

```json
{ "items": [{ "id": "vst_71bc", "visitorName": "Almaz Wolde", "gatekeeperName": "Girma Tadesse",
              "gateLabel": "Main Entrance", "partySize": 3, "gifted": true,
              "verifiedAt": "2026-07-28T09:14:02Z" }] }
```

### 11.6 `GET /admin/attractions/{attractionId}/tickets`

Query: `?status=paid|used|expired|all&q=<keycodeLast4 or buyer name>&from=&to=&limit=&cursor=`
Each row: `id, buyerName, gifted, recipientName, keycodeLast4, amountEtb, partySize, status, createdAt`.

### 11.7 `GET /admin/attractions/{attractionId}/tickets.csv`

Same filters, returns `text/csv` with `Content-Disposition: attachment`. Stream it; do not build the whole file in memory.

### 11.8 Gatekeepers

| Endpoint | Purpose |
|---|---|
| `GET /admin/gatekeepers` | List for the claim's site |
| `POST /admin/gatekeepers` | **Creates the Auth account server-side**, sets claims, writes the document |
| `PATCH /admin/gatekeepers/{id}` | Edit `gateLabel`, `shift`, `phone` |
| `POST /admin/gatekeepers/{id}/active` | `{ "active": false }` — also disables the Auth user |

`POST /admin/gatekeepers` request:
```json
{ "name": "Girma Tadesse", "phone": "+251911204118", "email": "girma.tadesse@gmail.com",
  "password": "TempPass2026", "employeeId": "ADW-0142", "gateLabel": "Main Entrance", "shift": "Morning" }
```

Sequence: validate → `admin.auth().createUser()` → `setCustomUserClaims(uid, { role: 'gatekeeper', attractionId, staffId })` → write `gatekeepers/{id}` with `mustChangePassword: true` → audit log → `201` with the document (**never** echoing the password). Duplicate email → `409 EMAIL_TAKEN`.

### 11.9 Guides

| Endpoint | Purpose |
|---|---|
| `GET /admin/guides` | List for the claim's site |
| `POST /admin/guides` | Same server-side account creation as gatekeepers |
| `PATCH /admin/guides/{id}` | Edit licence, languages, bio |
| `POST /admin/guides/{id}/status` | `{ "status": "suspended" }` |

`POST /admin/guides` adds `licenceNumber`, `licenceExpiry` (must be a future date → `400`), `yearsExperience`, `languages[]`, `bio`. Duplicate licence → `409 LICENCE_TAKEN`.

### 11.10 `GET /admin/notifications`

Operational alerts for the site, computed server-side: guide licences expiring within 30 days or already expired, expired unused tickets, capacity ≥ 85%, suspended guides.

```json
{ "items": [{ "id": "n_lic_soon_gd_02", "kind": "licence", "title": "Tewodros Alemayehu's licence expires soon",
              "body": "Expires 8 Aug 2026.", "href": "/guides", "createdAt": "2026-07-25T00:00:00Z", "read": false }] }
```

`POST /admin/notifications/{id}/read` marks one read.

---

## 12. API — Platform Admin

All of these are `requireRole('super_admin')`. Every write is audited.

### 12.1 Attractions lifecycle

| Endpoint | Purpose |
|---|---|
| `POST /platform/attractions` | Create a site. Body: `name` (English, permanent), `region`, `category`, plus optional defaults. Returns the attraction |
| `PATCH /platform/attractions/{id}` | Edit **any** field including `name` and `ownerUid` |
| `DELETE /platform/attractions/{id}` | Soft delete: `status: 'archived'`, hidden from discovery. Hard delete is never exposed |
| `POST /platform/attractions/{id}/enrich` | Kick a Firecrawl/Exa enrichment job (§14.4). `202` with `jobId` |

### 12.2 `POST /platform/attraction-admins` — the account the operator signs in with

This is the first step of the whole operator journey: the super admin creates the attraction, then creates its admin.

Request:
```json
{ "attractionId": "atr_adwa", "name": "Eyerusalem Mekonnen",
  "organisation": "Adwa Heritage Operations", "email": "operations@adwamuseum.et",
  "password": "TempPass2026", "phone": "+251116678840" }
```

Sequence: `createUser` → `setCustomUserClaims(uid, { role: 'attraction_admin', attractionId })` → write `users/{uid}` with `mustChangePassword: true` → set `attractions/{id}.ownerUid` → audit log → `201`.

Response `201`:
```json
{ "uid": "usr_op7", "email": "operations@adwamuseum.et", "role": "attraction_admin",
  "attractionId": "atr_adwa", "mustChangePassword": true }
```

### 12.3 Users and roles

| Endpoint | Purpose |
|---|---|
| `GET /platform/users?role=&q=&limit=&cursor=` | Search all users |
| `GET /platform/users/{uid}` | Full profile, claims, ticket/visit counts |
| `POST /platform/users/{uid}/role` | `{ "role": "attraction_admin", "attractionId": "atr_adwa" }` — re-sets claims, mirrors to the user doc |
| `POST /platform/users/{uid}/disable` | `{ "disabled": true }` — disables in Auth and Firestore, revokes refresh tokens |

Guard: a super admin cannot remove their own `super_admin` role → `409 CANNOT_DEMOTE_SELF`.

### 12.4 Platform analytics

`GET /platform/analytics?from=&to=&region=&attractionId=`

```json
{
  "gmvEtb": 1284500, "ticketsSold": 5142, "verifiedVisits": 4380, "proofRatePct": 85,
  "activeUsers": 2210, "newUsers": 318, "diasporaGiftShare": 18,
  "topAttractions": [{ "attractionId": "atr_adwa", "name": "Adwa Victory Memorial Museum", "revenueEtb": 412500, "visits": 1284 }],
  "byRegion": [{ "region": "Addis Ababa", "revenueEtb": 512000, "visits": 1802 }],
  "daily": [{ "date": "2026-07-01", "revenueEtb": 41000, "visits": 142 }]
}
```

### 12.5 Payments and settlements

| Endpoint | Purpose |
|---|---|
| `GET /platform/payments?status=&provider=&from=&to=` | Ledger with `providerRef` for reconciliation |
| `GET /platform/payments/{id}` | Full record including raw provider payloads |
| `POST /platform/payments/{id}/reconcile` | Re-queries Chapa verify API and repairs a stuck record |
| `GET /platform/settlements?attractionId=&period=` | Amount owed per attraction for the period |

### 12.6 Moderation and config

| Endpoint | Purpose |
|---|---|
| `GET /platform/moderation/reports?status=open` | Reported posts queue |
| `POST /platform/posts/{id}/moderate` | `{ "action": "hide" \| "remove" \| "dismiss", "reason": "..." }` |
| `GET /platform/audit-logs?actorUid=&action=&from=&to=` | Paginated audit trail |
| `GET /platform/config` · `PATCH /platform/config` | Feature flags, `giftingEnabled`, `minAppVersion`, maintenance banner |

---

## 13. API — Notifications and media

### 13.1 Notifications

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /notifications?unreadOnly=true` | any | The caller's notifications, newest first |
| `POST /notifications/{id}/read` | owner | Mark read |
| `POST /notifications/read-all` | owner | Mark all read |

Push delivery uses FCM to `users.pushTokens`. Every notification is stored in Firestore first, then pushed — a failed push must never lose the record. Bodies are written in both languages; the device receives the one matching `users.locale`.

Notification kinds: `ticket_paid`, `gift_received`, `gift_used`, `visit_verified`, `booking_requested`, `booking_confirmed`, `booking_declined`, `licence_expiring`, `capacity_high`, `payout_ready`.

### 13.2 Media upload

`POST /media/upload` (multipart) — **Auth:** `requireAuth()`

| Field | Notes |
|---|---|
| `file` | Max 10 MB images, 25 MB audio |
| `purpose` | `'post' \| 'avatar' \| 'guide' \| 'voice-story'` |

Server validates MIME against `purpose`, strips EXIF GPS from images, stores under `{purpose}/{uid}/{ts}-{name}`, returns `{ "url": "https://..." }`. Reject anything not in the allow-list with `400 UNSUPPORTED_MEDIA_TYPE`.

---

## 14. Third-party integrations

**Rule for all five:** the key lives in the server environment, the call is made server-side, the response is persisted to Firestore, and every integration has a defined behaviour when the provider is down. No client ever holds a provider key.

### 14.1 Chapa — payments

**Purpose:** collect ticket payments in ETB (and diaspora cards where Chapa supports them), including gift purchases. Chapa is the only payment provider for Viseth v1.

> Naming note: product docs previously said “telebirr”; **implement Chapa**. telebirr may appear as a method *inside* Chapa checkout — our API never talks to telebirr directly.

**Where used:** `POST /tickets/{id}/pay`, `POST /webhooks/chapa`, `POST /tickets/{id}/refund`, `POST /platform/payments/{id}/reconcile`.

**Adapter interface** — keep Chapa field names inside the adapter only:

```ts
interface PaymentProvider {
  createOrder(input: {
    merchantOrderId: string; // → Chapa tx_ref
    amountEtb: number;
    subject: string;
    email: string;
    firstName?: string;
    lastName?: string;
    phone?: string;
    returnUrl: string;
    callbackUrl: string;     // webhook URL
  }): Promise<{ checkoutUrl: string; providerRef: string | null; raw: unknown }>;

  queryOrder(merchantOrderId: string): Promise<{
    status: 'initiated' | 'succeeded' | 'failed';
    providerRef: string;
    raw: unknown;
  }>;

  refund(providerRef: string, amountEtb: number): Promise<{ ok: boolean; raw: unknown }>;

  verifyWebhookSignature(headers: Record<string, string>, rawBody: string): boolean;
}
```

**Initialize (server → Chapa):**

```
POST https://api.chapa.co/v1/transaction/initialize
Authorization: Bearer <CHAPA_SECRET_KEY>
Content-Type: application/json

{
  "amount": "750",
  "currency": "ETB",
  "email": "buyer@example.com",
  "first_name": "Eyerusalem",
  "last_name": "Mekonnen",
  "phone_number": "0911234567",
  "tx_ref": "VISETH-tkt_9fA2kd-01",
  "callback_url": "https://api.viseth.et/v1/webhooks/chapa",
  "return_url": "viseth://payment/return",
  "customization": {
    "title": "Viseth Ticket",
    "description": "Adwa Victory Memorial Museum × 3"
  }
}
```

Success response (trimmed): `{ "status": "success", "data": { "checkout_url": "https://checkout.chapa.co/..." } }`.

**Verify (server → Chapa):**

```
GET https://api.chapa.co/v1/transaction/verify/{tx_ref}
Authorization: Bearer <CHAPA_SECRET_KEY>
```

Treat `data.status === 'success'` as paid. Store `data.reference` as `payments.providerRef`.

**Webhook:**

1. Read raw body. Compute `HMAC-SHA256(rawBody, CHAPA_WEBHOOK_SECRET)` (or secret key per Chapa dashboard setting).
2. Compare to `Chapa-Signature` or `x-chapa-signature` header (constant-time).
3. On match and `status === 'success'`, run the paid transition in §7.3. Prefer also calling verify before mutating money state.

**Flow:**

1. `createOrder` with unique `tx_ref` = `VISETH-{ticketId}-{attempt}`.
2. Client opens `checkoutUrl`.
3. Chapa hits webhook → we mark ticket paid (after signature + verify).
4. Client polls `GET /tickets/{id}` every 3 seconds for up to 3 minutes.
5. If no webhook within 5 minutes, reconcile job (§16.2) calls `queryOrder` (verify API) and repairs state.

**Credentials:** `CHAPA_SECRET_KEY`, `CHAPA_PUBLIC_KEY` (never required server-side for init — secret only), `CHAPA_WEBHOOK_SECRET`, `CHAPA_BASE_URL=https://api.chapa.co/v1`. Use Chapa **test** keys when `PAYMENTS_MODE=sandbox`.

**Failure behaviour:** provider unreachable → `503 PAYMENT_PROVIDER_DOWN`, ticket stays `pending`, client shows retry. Never mark a ticket paid without a verified webhook **or** a successful verify API response.

**Sandbox / demo:** with test keys, use Chapa’s test cards/wallets. Additionally expose `POST /webhooks/chapa/simulate` (`requireRole('super_admin')`, disabled when `PAYMENTS_MODE=live`) that fabricates a signed-success path so the demo survives if Chapa sandbox is slow.

### 14.2 WisprFlow (aka Whisperflow) — voice stories (speech to text)

**Purpose:** a traveller records a voice note about a visit; we transcribe it into the post's `voiceStory.transcript`. Product name in code/env: **WisprFlow**; the brief may say “Whisperflow” — same integration.

**Where used:** background job after `POST /posts` when `voiceStory.audioUrl` is present; also `POST /ai/transcribe` for a direct call.

Request we send: the stored audio URL (or bytes), `language: 'am' | 'en' | 'auto'`.
Response we persist: `{ transcript, language, durationSec, confidence }` onto the post.

**Amharic path:** when detected language is Amharic and confidence is below 0.6, retry through **Addis AI** (`ADDIS_AI_API_KEY`), which handles Amharic speech better, and keep whichever returns higher confidence. Record which engine produced the text in `aiJobs`.

**Failure behaviour:** the post publishes with `transcript: null` and `processing: false` after two retries. A missing transcript must never block the post — sharing is the point, transcription is the bonus.

`POST /ai/transcribe` — **Auth:** `requireAuth()`, rate limit 10/hour/user.
Request: `{ "audioUrl": "https://...", "language": "auto" }` → `202 { "jobId": "aij_..." }`
Poll `GET /ai/jobs/{jobId}` → `{ "status": "succeeded", "result": { "transcript": "...", "language": "am" } }`

### 14.3 ElevenLabs — narration (text to speech)

**Purpose:** two things. (a) Attraction narration: turn `enrichedFacts.summary` + `description` into an audio guide in Amharic and English. (b) Voice-story narration: read a traveller's transcript back in a consistent narrator voice for the feed.

**Where used:** `POST /attractions/{id}/narration` (admin/super admin), and the post pipeline after transcription.

Request we send: `{ text, voiceId, modelId, outputFormat: 'mp3_44100_128' }`.
Response handling: stream the MP3 straight to Cloud Storage at `narration/{attractionId}/{locale}-{ts}.mp3`, then write `attractions.narration[locale] = { audioUrl, voiceId, generatedAt }`. **Never** proxy audio bytes through the API on every playback — clients fetch the storage URL directly.

Guardrails: max 5 000 characters per request; cache by `sha256(text + voiceId)` in `aiJobs` and reuse the existing audio when the hash matches, so re-saving a listing does not re-bill.

**Credentials:** `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID_AM`, `ELEVENLABS_VOICE_ID_EN`.
**Failure behaviour:** the attraction simply has no `narration` entry; clients hide the play button. Non-fatal, always.

### 14.4 Firecrawl + Exa — discovery and enrichment

**Purpose:** populate `attractions.enrichedFacts` with a trustworthy summary and a source URL, so a listing is credible even before the operator writes good copy. Exa finds the authoritative page; Firecrawl extracts clean content from it.

**Where used:** `POST /platform/attractions/{id}/enrich` and the nightly refresh job (§16.5).

Pipeline:
1. **Exa** semantic search: query `"{attraction.name} {region} Ethiopia official"`, take the top 3 results, prefer `.gov.et`, `.et`, UNESCO, and the attraction's own `website`.
2. **Firecrawl** scrape the chosen URL → markdown.
3. Summarise to ≤ 60 words (Fal or Addis AI, §14.5), Amharic version too.
4. Write `enrichedFacts = { summary, summaryAm, sourceUrl, fetchedAt }` and append to `searchKeywords`.

**Never overwrite operator-authored `description`.** `enrichedFacts` is a separate, read-only field — a judge will ask who wrote what, and the answer must be unambiguous.

**Credentials:** `FIRECRAWL_API_KEY`, `EXA_API_KEY`.
**Failure behaviour:** job marked `failed` in `enrichmentJobs` with the error; the attraction keeps its previous facts. Retry with exponential backoff, max 3 attempts.

### 14.5 Fal (and Addis AI) — personalisation

**Purpose:**
- **Recommendations:** embed the user's visit history and rank `live` attractions they have not visited (`GET /recommendations`).
- **Summarisation:** condense Firecrawl markdown into the 60-word `enrichedFacts.summary` and its Amharic version.
- **Passport card image:** render a shareable card for a completed visit (`POST /visits/{id}/card`), returning a PNG URL for social sharing.

**Where used:** `GET /recommendations`, the enrichment pipeline, `POST /visits/{id}/card`.

`GET /recommendations` — **Auth:** `requireAuth()`
```json
{ "items": [{ "attractionId": "atr_lalibela", "name": "Lalibela Rock-Hewn Churches",
              "reason": "You've visited 2 historical sites in Amhara", "score": 0.82 }] }
```

Cache recommendations per user for 6 hours in `users.recommendationCache`. **Fallback when Fal is unavailable:** a deterministic heuristic — same category as the user's most-visited category, in a region they have not visited, ordered by `verifiedVisitCount`. The endpoint must always return items; personalisation degrades, it never errors.

**Credentials:** `FAL_API_KEY`, `ADDIS_AI_API_KEY`.

### 14.6 Integration summary

| Provider | Purpose | Called from | If it fails |
|---|---|---|---|
| **Chapa** | Ticket payments, refunds, verify | Payment endpoints, `/webhooks/chapa` | `503`, ticket stays `pending`, reconcile job repairs |
| **WisprFlow** (+ Addis AI) | Voice-story transcription | Post pipeline, `/ai/transcribe` | Post publishes without a transcript |
| **ElevenLabs** | Attraction + story narration | Narration job | No audio, clients hide the player |
| **Firecrawl** + Exa | Listing enrichment, discovery | Enrichment job | Keeps previous facts, retries 3× |
| **Fal** (+ Addis AI) | Recommendations, summaries, share cards | `/recommendations`, enrichment, card | Heuristic fallback, always returns |

---

## 15. Screen → endpoint map (all four surfaces)

### 15.1 Customer App (Flutter)

| Screen | Endpoints | Auth |
|---|---|---|
| Splash / version gate | `GET /platform/config` (public subset via `GET /config`) | none |
| Sign in / sign up (phone OTP, Google) | Firebase Auth SDK → `POST /auth/session` | none → visitor |
| Home / discovery | `GET /attractions?sort=popular`, `GET /recommendations` | optional |
| Search & filters | `GET /attractions?q=&region=&category=&maxPriceEtb=&freeOnly=` | optional |
| Map / nearby | `GET /attractions?nearLat=&nearLng=&radiusKm=` | optional |
| Attraction detail | `GET /attractions/{id}`, `GET /attractions/{id}/availability` | optional |
| Audio guide player | `attraction.narration[locale].audioUrl` (direct storage fetch) | optional |
| Guides at this site | `GET /attractions/{id}/guides` | optional |
| Buy ticket sheet | `POST /tickets` | visitor |
| Payment webview (Chapa checkout) | `POST /tickets/{id}/pay` → open `checkoutUrl` → poll `GET /tickets/{id}` | visitor |
| Gift a visit (diaspora) | `POST /tickets` with `gift`, then pay | visitor |
| Ticket wallet | `GET /tickets?status=paid` | visitor |
| Ticket / QR detail | `GET /tickets/{id}` + locally stored `qrPayload` | visitor |
| Claim a gifted ticket | `POST /tickets/{id}/claim` | visitor |
| Check-in success | Push `visit_verified`, then `GET /visits/me` | visitor |
| Passport | `GET /passport/me` | visitor |
| Visit history | `GET /visits/me` | visitor |
| Create post / voice story | `POST /media/upload`, `POST /posts`, poll `GET /ai/jobs/{id}` | visitor |
| Share card | `POST /visits/{id}/card` | visitor |
| Feed | `GET /feed?scope=following\|discover` | visitor |
| Post interactions | `POST /posts/{id}/like`, `/comments`, `/report` | visitor |
| Public passport (shared link) | `GET /users/{uid}/passport` | optional |
| Book a guide | `POST /bookings`, `GET /bookings/me` | visitor |
| Rate a guide | `POST /bookings/{id}/rate` | visitor |
| Notifications | `GET /notifications`, `POST /notifications/{id}/read` | visitor |
| Profile & settings | `PATCH /users/me`, `POST /users/me/push-tokens` | visitor |

### 15.2 Staff App (Flutter) — gatekeepers and guides

| Screen | Endpoints | Auth |
|---|---|---|
| Staff sign in | Firebase Auth → `POST /auth/session` → `GET /staff/me` | staff |
| Forced password change | `POST /auth/change-password` | staff |
| Gate scanner | `POST /visits/verify` | gatekeeper |
| Manual keycode entry | `POST /visits/verify` (ticketId + keycode form) | gatekeeper |
| Scan result — success | Response of `/visits/verify` (renders `greeting`) | gatekeeper |
| Scan result — failure | Error `code` from `/visits/verify` | gatekeeper |
| Today at my gate | `GET /staff/gate/today` | gatekeeper |
| Expected arrivals / named greetings | `GET /staff/gate/expected` | gatekeeper |
| Guide — my tours | `GET /bookings/me?status=confirmed` | guide |
| Guide — accept / decline | `PATCH /bookings/{id}` | guide |
| Guide — profile & licence | `GET /staff/me` | guide |
| Notifications | `GET /notifications` | staff |
| Settings (locale, theme, sign out) | `PATCH /users/me` | staff |

### 15.3 Attraction Admin (React web)

| Screen | Endpoints | Auth |
|---|---|---|
| Login — Admin tab | Firebase Auth → `POST /auth/session` (expects `role: attraction_admin`) | – |
| Login — Staff tab | Firebase Auth → `GET /staff/me`, redirect to the staff desk | – |
| Sales & Visitors | `GET /admin/attractions/{id}`, `/summary?days=30`, `/visits?limit=10`, `GET /admin/notifications` | attraction_admin |
| Tickets | `GET /admin/attractions/{id}/tickets`, `…/tickets.csv` | attraction_admin |
| Gatekeepers | `GET/POST /admin/gatekeepers`, `POST /admin/gatekeepers/{id}/active` | attraction_admin |
| Guides | `GET/POST /admin/guides`, `POST /admin/guides/{id}/status` | attraction_admin |
| Settings hub | – (client routing only) | attraction_admin |
| Listing settings | `GET /admin/attractions/{id}`, `PATCH …`, `POST …/cover` | attraction_admin |
| Account settings | `GET /auth/me`, `PATCH /users/me` | attraction_admin |
| Notifications bell | `GET /admin/notifications`, `POST /admin/notifications/{id}/read` | attraction_admin |

### 15.4 Platform Admin (React web)

| Screen | Endpoints | Auth |
|---|---|---|
| Login | Firebase Auth → `POST /auth/session` (expects `role: super_admin`) | – |
| Overview / analytics | `GET /platform/analytics` | super_admin |
| Attractions list | `GET /attractions?includeDraft=true` | super_admin |
| Create attraction | `POST /platform/attractions` | super_admin |
| Edit / archive attraction | `PATCH`, `DELETE /platform/attractions/{id}` | super_admin |
| Create attraction admin account | `POST /platform/attraction-admins` | super_admin |
| Users & roles | `GET /platform/users`, `POST /platform/users/{uid}/role`, `/disable` | super_admin |
| Payments ledger | `GET /platform/payments`, `POST /platform/payments/{id}/reconcile` | super_admin |
| Refunds | `POST /tickets/{id}/refund` | super_admin |
| Settlements | `GET /platform/settlements` | super_admin |
| Enrichment jobs | `POST /platform/attractions/{id}/enrich`, `GET /platform/jobs` | super_admin |
| Moderation queue | `GET /platform/moderation/reports`, `POST /platform/posts/{id}/moderate` | super_admin |
| Audit log | `GET /platform/audit-logs` | super_admin |
| Feature flags | `GET/PATCH /platform/config` | super_admin |

---

## 16. Scheduled jobs and triggers

Run scheduled work as Cloud Scheduler → HTTPS job endpoints on the API, protected by `X-Job-Token` matching `JOB_TOKEN`. Firestore triggers run as Cloud Functions.

| # | Job | Schedule | Behaviour |
|---|---|---|---|
| 16.1 | **Expire tickets** | Hourly | `status == 'paid' && expiresAt < now` → `expired`. Notify the buyer once |
| 16.2 | **Reconcile payments** | Every 10 min | `payments.status == 'initiated'` older than 5 min → `queryOrder`, repair ticket state |
| 16.3 | **Recompute streaks** | Daily 00:30 EAT | A streak is consecutive **calendar months** containing ≥ 1 verified visit. Break resets to 0, `longestStreakDays` keeps the max |
| 16.4 | **On visit created** (trigger) | Realtime | Increment `attractions.verifiedVisitCount` and the daily counter, recompute the visitor's passport, push `visit_verified` |
| 16.5 | **Refresh enrichment** | Weekly, Sunday 02:00 | Re-run Exa + Firecrawl for `live` attractions whose `fetchedAt` is older than 30 days |
| 16.6 | **Licence expiry alerts** | Daily 06:00 EAT | Guides expiring within 30 days → admin notification; already expired → auto-suspend and notify both parties |
| 16.7 | **Capacity alert** | Every 30 min during opening hours | `capacityPct >= 85` → one notification per site per day |
| 16.8 | **Idempotency sweep** | Daily | Delete `idempotencyKeys` older than 24h |
| 16.9 | **Daily rollups** | Daily 01:00 EAT | Write `analyticsDaily/{date}` per attraction so admin and platform dashboards never scan raw collections |

---

## 17. Security rules, indexes, rate limits

### 17.1 Firestore rules (authoritative extract)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{db}/documents {

    function role()  { return request.auth.token.role; }
    function siteId(){ return request.auth.token.attractionId; }

    match /users/{uid} {
      allow read:   if request.auth != null && (request.auth.uid == uid || role() == 'super_admin');
      allow update: if request.auth.uid == uid
                    && request.resource.data.diff(resource.data).affectedKeys()
                         .hasOnly(['displayName','photoUrl','locale','country','pushTokens','lastActiveAt']);
      allow create, delete: if false;   // API only
    }

    match /attractions/{id} {
      allow read:   if resource.data.status == 'live' || role() == 'super_admin' || siteId() == id;
      allow create, delete: if role() == 'super_admin';
      allow update: if role() == 'super_admin'
                    || (role() == 'attraction_admin' && siteId() == id
                        && request.resource.data.diff(resource.data).affectedKeys()
                             .hasOnly(['nameAm','description','descriptionAm','region','category','priceEtb',
                                       'childPriceEtb','hours','closedDays','entryNotes','phone','address','website',
                                       'status','imageUrl','location','requiresTicket','peoplePerTicket',
                                       'dailyCapacity','ticketValidDays','visitDurationMinutes','allowsGifting',
                                       'searchKeywords','updatedAt']));
    }

    match /tickets/{id} {
      allow read:  if request.auth.uid == resource.data.buyerUid
                   || request.auth.uid == resource.data.recipientUid
                   || (role() == 'attraction_admin' && siteId() == resource.data.attractionId)
                   || role() == 'super_admin';
      allow write: if false;            // API only — money never moves from a client write
    }

    match /visits/{id} {
      allow read:  if request.auth != null;
      allow create, update, delete: if false;   // proof is server-written, always
    }

    match /gatekeepers/{id} {
      allow read:  if (role() == 'attraction_admin' && siteId() == resource.data.attractionId)
                   || request.auth.uid == resource.data.uid || role() == 'super_admin';
      allow write: if false;            // API only (account creation)
    }

    match /guides/{id} {
      allow read:  if resource.data.status == 'active' || request.auth.uid == resource.data.uid
                   || (role() == 'attraction_admin' && siteId() == resource.data.attractionId)
                   || role() == 'super_admin';
      allow write: if false;
    }

    match /posts/{id} {
      allow read:   if resource.data.status == 'active' && resource.data.visibility == 'public';
      allow create, update, delete: if false;   // API only — a post must prove a visit
    }

    match /auditLogs/{id} { allow read: if role() == 'super_admin'; allow write: if false; }
  }
}
```

Storage rules:

```
match /attractions/{attractionId}/{file=**} {
  allow read: if true;
  allow write: if request.auth.token.attractionId == attractionId
               && request.resource.size < 5 * 1024 * 1024
               && request.resource.contentType.matches('image/.*');
}
match /post/{uid}/{file=**} {
  allow read: if true;
  allow write: if request.auth.uid == uid && request.resource.size < 25 * 1024 * 1024;
}
```

### 17.2 Composite indexes (create before the demo, not during it)

| Collection | Fields |
|---|---|
| `tickets` | `attractionId ASC, createdAt DESC` |
| `tickets` | `attractionId ASC, status ASC, createdAt DESC` |
| `tickets` | `buyerUid ASC, status ASC, createdAt DESC` |
| `tickets` | `recipientUid ASC, status ASC, createdAt DESC` |
| `tickets` | `status ASC, expiresAt ASC` (expiry job) |
| `visits` | `attractionId ASC, verifiedAt DESC` |
| `visits` | `visitorUid ASC, verifiedAt DESC` |
| `guides` | `attractionId ASC, status ASC` |
| `guideBookings` | `guideId ASC, date ASC` |
| `guideBookings` | `visitorUid ASC, createdAt DESC` |
| `posts` | `status ASC, visibility ASC, createdAt DESC` |
| `posts` | `attractionId ASC, createdAt DESC` |
| `attractions` | `status ASC, region ASC, verifiedVisitCount DESC` |
| `payments` | `status ASC, createdAt ASC` (reconcile job) |
| `notifications` | `uid ASC, read ASC, createdAt DESC` |

### 17.3 Rate limits (per uid, sliding window; per IP for public routes)

| Route group | Limit |
|---|---|
| `POST /tickets`, `POST /tickets/{id}/pay` | 10 / hour |
| `POST /visits/verify` | 600 / hour (a busy gate is legitimately fast) |
| `POST /ai/transcribe`, narration | 10 / hour |
| `POST /posts`, `POST /media/upload` | 30 / hour |
| Public `GET /attractions*` | 120 / minute per IP |
| Everything else authenticated | 300 / minute |

Return `429` with `Retry-After`. Never rate-limit `POST /webhooks/chapa`.

### 17.4 Validation and hardening

- Validate every body with a schema library (zod). Reject unknown fields rather than ignoring them.
- Strip HTML from all free text; store plain text only.
- Cap string lengths: caption 500, bio 1 000, description 2 000, gift message 240.
- CORS allow-list: the two Netlify origins plus `localhost:5173`. Mobile apps send no `Origin`.
- Helmet, `X-Request-Id` on every response, structured JSON logs with `requestId`, `uid`, `route`, `latencyMs`, and never a token or password in a log line.

---

## 18. Error catalogue

Clients switch on `code`. Adding a code is additive; changing one is breaking.

| Code | HTTP | Meaning |
|---|---|---|
| `UNAUTHENTICATED` | 401 | Missing or invalid ID token |
| `TOKEN_EXPIRED` | 401 | Refresh and retry once |
| `FORBIDDEN_ROLE` | 403 | Wrong role for this route |
| `WRONG_SITE` | 403 | Resource belongs to another `attractionId` |
| `VALIDATION_FAILED` | 400 | `details.fields` maps field → message |
| `NOT_FOUND` | 404 | Missing, or outside the caller's scope |
| `ATTRACTION_NOT_LIVE` | 409 | Draft/archived site cannot sell tickets |
| `GIFTING_DISABLED` | 409 | Site or platform has gifting off |
| `PARTY_SIZE_EXCEEDED` | 400 | Above `peoplePerTicket` |
| `CAPACITY_REACHED` | 409 | Daily capacity full at scan time |
| `PAYMENT_PROVIDER_DOWN` | 503 | Chapa unreachable |
| `PAYMENT_DECLINED` | 422 | Provider rejected the transaction |
| `TICKET_UNPAID` | 409 | Scanned before payment completed |
| `TICKET_ALREADY_USED` | 409 | `details.visitId`, `details.verifiedAt` |
| `TICKET_EXPIRED` | 409 | Past `expiresAt` |
| `KEYCODE_MISMATCH` | 403 | Hash did not match — forged or corrupted QR |
| `QR_MALFORMED` | 400 | Unparseable payload |
| `GATEKEEPER_DISABLED` | 403 | Account deactivated by the operator |
| `ALREADY_CLAIMED` | 409 | Gift already bound to another user |
| `EMAIL_TAKEN` | 409 | Auth account exists |
| `LICENCE_TAKEN` | 409 | Guide licence already registered |
| `GUIDE_LICENCE_EXPIRED` | 409 | Cannot book on an expired licence |
| `VISIT_NOT_YOURS` | 403 | Posting against someone else's visit |
| `POST_EXISTS` | 409 | One post per visit |
| `INVALID_TRANSITION` | 409 | Illegal status change |
| `CANNOT_DEMOTE_SELF` | 409 | Super admin self-demotion guard |
| `RATE_LIMITED` | 429 | `Retry-After` set |
| `UNSUPPORTED_MEDIA_TYPE` | 400 | Upload rejected |
| `INTERNAL` | 500 | Unhandled — `requestId` for the logs |

---

## 19. Environment, deployment and build order

### 19.1 Environment variables (API)

```bash
# Runtime
NODE_ENV=production
PORT=8080
API_BASE_URL=https://api.viseth.et
CORS_ORIGINS=https://admin.viseth.et,https://platform.viseth.et,http://localhost:5173

# Firebase Admin
FIREBASE_PROJECT_ID=
FIREBASE_CLIENT_EMAIL=
FIREBASE_PRIVATE_KEY=          # escaped newlines
FIREBASE_STORAGE_BUCKET=

# Secrets
KEYCODE_PEPPER=                # rotating this invalidates every unused ticket — never rotate mid-season
JOB_TOKEN=                     # scheduler → job endpoints

# Chapa
PAYMENTS_MODE=live             # live | sandbox
CHAPA_BASE_URL=https://api.chapa.co/v1
CHAPA_SECRET_KEY=
CHAPA_PUBLIC_KEY=
CHAPA_WEBHOOK_SECRET=

# AI / content
WISPRFLOW_API_KEY=
ADDIS_AI_API_KEY=
ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID_EN=
ELEVENLABS_VOICE_ID_AM=
FAL_API_KEY=
FIRECRAWL_API_KEY=
EXA_API_KEY=
```

Web clients only ever hold the Firebase web config plus `VITE_API_URL`. If a provider key appears in a client bundle, that is a release blocker.

### 19.2 Deployment

- API on **Render** — health check `GET /healthz` returning `{ "ok": true, "version": "...", "commit": "..." }`, autoscale min 1 instance so the payment webhook is never cold.
- Web on **Netlify** — two sites, `admin.viseth.et` and `platform.viseth.et`, SPA redirect `/* → /index.html 200`.
- Firestore rules and indexes deploy from the repo (`firebase deploy --only firestore:rules,firestore:indexes`) — never edit them in the console.
- Register the Chapa webhook URL (`/v1/webhooks/chapa`) per environment in the Chapa dashboard; staging must not point at production.

### 19.3 Seed data for the demo

Seed one fully populated site so the dashboard looks like a real operating museum on first load: **Adwa Victory Memorial Museum** (`atr_adwa`), 30 days of trading with weekend peaks, 120–200 tickets, ~85% converting to verified visits, a handful expired, a few diaspora gifts, 5 gatekeepers, 5 guides (one with a licence expiring inside 30 days so the alert renders), and 20 Ethiopian visitor names. Amounts in ETB, dates inside the demo window.

### 19.4 Build order

```
[ ] 1. Firebase project, Auth providers, Firestore, Storage, rules + indexes deployed
[ ] 2. API skeleton on Render: health check, error envelope, auth middleware, request logging
[ ] 3. users + /auth/session + /auth/me            → unblocks every client's sign-in
[ ] 4. attractions read APIs + seed script          → unblocks Customer discovery and Admin dashboard
[ ] 5. Platform admin: create attraction + create attraction_admin account
[ ] 6. Attraction admin: summary, tickets, listing PATCH, cover upload
[ ] 7. Staff account creation (gatekeepers, guides) + /staff/me
[ ] 8. Tickets: create, wallet, keycode hashing
[ ] 9. Chapa adapter (test keys) + webhook + verify + reconcile job
[ ] 10. /visits/verify — the proof path — plus capacity and idempotency
[ ] 11. Passport recompute trigger + /passport/me
[ ] 12. Posts, feed, social actions
[ ] 13. Guides + bookings
[ ] 14. Notifications + FCM
[ ] 15. AI: WisprFlow, ElevenLabs, Firecrawl/Exa, Fal — each behind its fallback
[ ] 16. Platform analytics, moderation, audit log
[ ] 17. Scheduled jobs
[ ] 18. Load-test /visits/verify at 10 rps and confirm double-scan returns 409, never a second visit
```

### 19.5 Acceptance tests that must pass before the demo

1. Two simultaneous scans of the same ticket produce **exactly one** visit; the loser gets `TICKET_ALREADY_USED`.
2. A ticket for site A scanned at site B returns `WRONG_SITE` and creates nothing.
3. A tampered QR (valid `ticketId`, wrong keycode) returns `KEYCODE_MISMATCH`.
4. A payment callback replayed three times marks the ticket paid once.
5. An attraction admin `PATCH` containing `"name"` succeeds but leaves `name` unchanged.
6. An attraction admin reading another site's tickets gets `404`, not a partial list.
7. Registering a gatekeeper from the browser does **not** change the operator's session.
8. Killing every AI provider key still lets a user buy, scan, post, and see their passport.

---

**Document owner:** Attraction Admin surface lead. Raise any contradiction between this document and `Viseth_Design_System_Night_Coffee.md` (design) or the Attraction Admin `README.md` (implemented routes) before writing code around it.
