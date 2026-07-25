# Viseth Backend Technical Specification

**Audience:** Backend / Integrations team  
**Version:** 1.0  
**Date:** 2026-07-25  
**Sources:** `Viseth_Full_Project_Description_v2.pdf`, design system, Super Admin console, guide/gatekeeper UI contracts  

This document is the single build contract for the Viseth backend. Every screen across Customer App, Staff App (Guide + Gatekeeper), Attraction Admin web, and Platform Admin (Super Admin) web is mapped to data, APIs, third-party calls, and auth rules. Do not invent alternate shapes without updating this document and notifying client teams.

---

## 1. Product summary

Viseth is a personal travel passport for Ethiopian heritage sites. Travellers buy tickets (Chapa), enter via QR scan by a gatekeeper, build a verified visit passport, send diaspora gifts (shared keycode + named greeting), book guides, post AI-enhanced recaps, and progress through streak badges and follower titles. Super Admin runs the platform; Place Admins run one attraction each.

---

## 2. Architecture (locked)

```
Flutter (Customer / Guide / Gatekeeper views)
        │
        ├─ Firebase Auth + Firestore  → accounts, attractions, tickets, visits,
        │                               posts, follows, streaks, titles, bookings
        │
        └─ Custom API (Node/Express or FastAPI on Railway/Render)
              → Chapa payment initiation & webhooks
              → Gift keycode generation
              → QR / keycode verification (scan)
              → Streak & title recalculation triggers
              → AI proxies: Whisperflow, ElevenLabs, Fal, Firecrawl
              → Platform Admin & Attraction Admin REST (recommended: same API)

Web Attraction Admin  ──┐
Web Platform Admin    ──┴── Custom API (+ Firebase Admin SDK server-side)
```

**Rules**

1. Mobile apps may read/write most Firestore collections with security rules scoped by role.
2. Anything involving money, secrets, AI vendor keys, or scan verification MUST go through the Custom API.
3. Admin webs MUST NOT hold Chapa/AI secrets; they call Custom API with admin tokens.
4. Currency is **ETB**. Amounts are decimal numbers with 2 places (e.g. `1200.00`), never floats without rounding.
5. All timestamps are ISO-8601 UTC strings in API responses.
6. IDs are opaque strings (`usr_…`, `atr_…`, `tkt_…`, etc.). Clients never invent IDs for durable entities.

**Base URL (staging example)**

```
https://api.viseth.et/v1
```

---

## 3. Roles & authentication

### 3.1 Roles

| Role | Surface | Scope |
|---|---|---|
| `traveler` | Customer app | Own profile, purchases, passport, social |
| `guide` | Customer/Staff app (guide mode) | Own guide profile, booking inbox |
| `gatekeeper` | Staff app (gatekeeper mode) | Scan at assigned attraction(s) only |
| `place_admin` | Attraction Admin web | Exactly one `attractionId` |
| `super_admin` | Platform Admin web | Whole platform |
| `partner` | External systems | API key scoped partner feed (read-only) |

A user account may hold one primary app role (`traveler` | `guide` | `gatekeeper`). Guides and gatekeepers are also platform users. Place admins and super admins are separate admin accounts (email/password).

### 3.2 Auth mechanisms

| Client | Mechanism |
|---|---|
| Flutter apps | Firebase Auth → ID token in `Authorization: Bearer <firebase_id_token>` |
| Attraction Admin / Platform Admin | Email/password → Custom API issues JWT access (15m) + refresh (30d) |
| Place console machine keys | `X-Api-Key: vk_live_…` (scope `place_admin`) |
| Webhooks (Chapa) | Signature header verification, no user token |
| Partner | `X-Api-Key: pk_…` (scope `partner`) |

### 3.3 Common headers

```
Authorization: Bearer <token>
Content-Type: application/json
Accept: application/json
X-Client: customer|staff|attraction_admin|platform_admin
X-Request-Id: <uuid>   # optional, echoed in logs
```

### 3.4 Standard error envelope

```json
{
  "error": {
    "code": "TICKET_ALREADY_USED",
    "message": "This ticket was already scanned.",
    "details": {}
  }
}
```

HTTP status: `400` validation, `401` unauthenticated, `403` forbidden, `404` not found, `409` conflict, `422` business rule, `429` rate limit, `502` upstream (Chapa/AI) failure.

---

## 4. Data model (persist these)

### 4.1 Collections / tables

#### `users`
| Field | Type | Notes |
|---|---|---|
| id | string | PK |
| email | string | unique, nullable for phone-only if needed |
| phone | string | E.164 preferred |
| displayName | string | |
| photoUrl | string? | |
| role | enum | `traveler` \| `guide` \| `gatekeeper` |
| status | enum | `active` \| `pending` \| `suspended` |
| followerCount | int | denormalized |
| followingCount | int | denormalized |
| streakMonths | int | consecutive months with ≥1 visit |
| streakBrokenAt | timestamp? | |
| currentBadgeId | string? | streak tier |
| currentTitleId | string? | follower title |
| heritageScore | number | 0–100 |
| regionsVisited | string[] | unique region codes |
| createdAt / updatedAt | timestamp | |

#### `guides` (1:1 with user where role=guide)
| Field | Type |
|---|---|
| userId | string |
| bio | string |
| languages | string[] |
| specialties | string[] |
| toursCompleted | int |
| rating | number? |
| attractionIds | string[] | sites they cover |
| active | bool |

#### `gatekeepers`
| Field | Type |
|---|---|
| userId | string |
| attractionIds | string[] | usually one site |
| active | bool |
| deviceIds | string[] | optional pairing |

#### `place_admins`
| Field | Type |
|---|---|
| id | string |
| name, email, phone | string |
| attractionId | string | exactly one |
| passwordHash | string | |
| active | bool |
| createdAt | timestamp |

#### `super_admins`
| Field | Type |
|---|---|
| id, email, displayName, phone?, avatarUrl?, passwordHash | |
| createdAt / updatedAt | |

#### `attractions`
| Field | Type |
|---|---|
| id | string |
| name | string |
| address | string |
| region | string | e.g. `Addis Ababa`, `Amhara`, `Tigray`, `Harari`, `Oromia` |
| description | string |
| lat, lng | number |
| ticketPrice | number | ETB |
| active | bool |
| enrichedFacts | string[] | from Firecrawl |
| enrichmentStatus | enum | `none` \| `pending` \| `ready` \| `failed` |
| coverImageUrl | string? |
| createdAt / updatedAt | |

#### `tickets`
| Field | Type |
|---|---|
| id | string |
| code | string | unique QR payload id |
| qrPayload | string | signed opaque string clients encode as QR |
| attractionId | string |
| holderUserId | string? | null until claim for gift recipients |
| holderName | string |
| purchaserUserId | string |
| purchaserName | string |
| amount | number |
| status | enum | `valid` \| `used` \| `voided` \| `expired` |
| giftId | string? | |
| transactionId | string | |
| purchasedAt / usedAt / expiresAt | timestamp |
| voidReason | string? |

#### `gifts`
| Field | Type |
|---|---|
| id | string |
| keycode | string | unique, human-readable e.g. `HRR-4821` |
| attractionId | string |
| senderUserId / senderName | |
| recipientNames | string[] | ordered; length = N paid |
| greeting | string? | named greeting text |
| recipientsTotal | int |
| redeemedCount | int |
| status | enum | `active` \| `partially_used` \| `fully_used` \| `revoked` \| `expired` |
| transactionId | string |
| createdAt / expiresAt | |
| revokeReason | string? |

#### `transactions`
| Field | Type |
|---|---|
| id | string |
| reference | string | Chapa tx_ref `CHP-…` |
| kind | enum | `ticket` \| `gift` \| `booking` |
| status | enum | `pending` \| `succeeded` \| `failed` \| `refunded` |
| payerUserId / payerName | |
| attractionId | string? | required for ticket/gift |
| guideId | string? | for booking |
| amount | number | gross ETB |
| commission | number | platform cut |
| commissionRate | number | snapshot % at purchase |
| chapaCheckoutUrl | string? | |
| failureReason | string? | |
| metadata | object | giftId / ticketIds / bookingId |
| createdAt / updatedAt | |

#### `visits`
| Field | Type |
|---|---|
| id | string |
| userId | string? | holder if known |
| visitorName | string | displayed at gate |
| attractionId | string |
| ticketId | string? | |
| giftId | string? | |
| scannedByUserId | string | gatekeeper |
| scannedAt | timestamp |
| region | string | copied from attraction |

#### `bookings`
| Field | Type |
|---|---|
| id | string |
| guideId / travelerId | string |
| requestedDate | date |
| note | string? |
| status | enum | `requested` \| `confirmed` \| `declined` \| `cancelled` \| `completed` |
| transactionId | string? | |
| amount | number? | |
| createdAt / updatedAt | |

#### `recap_posts`
| Field | Type |
|---|---|
| id | string |
| authorId | string |
| attractionId | string |
| body | string |
| imageUrl | string? | Fal or upload |
| audioUrl | string? | ElevenLabs |
| aiAssisted | bool |
| status | enum | `published` \| `flagged` \| `removed` |
| likeCount / reportCount | int |
| reportReasons | string[] | aggregated |
| removalReason | string? | |
| createdAt | |

#### `comments` / `messages` / `follows`
Minimal social graph for reports + titles:

- `comments`: id, postId, authorId, body, status, createdAt  
- `messages`: id, fromUserId, toUserId, body, createdAt  
- `follows`: followerId, followeeId, createdAt (unique pair)

#### `social_reports`
| Field | Type |
|---|---|
| id | string |
| category | enum | `violence` \| `sexual_abuse` \| `other` |
| contentType | enum | `recap` \| `comment` \| `profile` \| `message` |
| status | enum | `open` \| `actioned` \| `dismissed` |
| reporterUserId / reportedUserId | string |
| contentPreview | string |
| targetId | string | post/comment/profile/message id |
| postId | string? | |
| notes | string | reporter free text |
| resolutionNote | string? | |
| resolvedByAdminId | string? | |
| createdAt / resolvedAt | |

#### `streak_tiers` / `follower_titles`
Configurable by Super Admin (see Section 9 of product PDF). Seed defaults:

**Streak tiers:** Dula 1–2, Jile 3–4, Tor 5–7, Gasha 8–10, Shotel 11–15, Ye Zellan Silt 16+ + `requiresAllRegions=true`.

**Titles:** Traveler 0–50, Young Noble 51–200, Commander 201–500, Vanguard Chief 501–2000, Governor 2001–10000, Ras 10001+.

#### `payouts`
Monthly partner settlement per attraction (and optionally guides).

| Field | Type |
|---|---|
| id | string |
| attractionId | string? | |
| guideId | string? | |
| period | string | `YYYY-MM` |
| grossAmount / commission / netAmount | number |
| status | `scheduled` \| `paid` \| `on_hold` |
| scheduledFor / paidAt | |
| holdReason | string? |

#### `support_cases`
kind: `payment` \| `access` \| `content` \| `site` \| `other`  
status: `open` \| `in_progress` \| `escalated` \| `resolved`  
priority: `low` \| `medium` \| `high`

#### `api_credentials`
scope: `place_admin` \| `webhook` \| `partner`  
store only hashed secret; return plaintext once on create/rotate.

#### `feature_flags`
keys: `diaspora_gifting`, `ai_recaps`, `guide_booking`, `streak_badges`, `discovery_feed`, `live_streaming`  
fields: enabled, rollout (0–100)

#### `platform_settings`
commissionRate (default 12), payoutDay (1–28), supportEmail, maintenanceMode, giftKeycodeExpiryHours (default 72)

#### `announcements`
audience: `all` \| `travelers` \| `guides` \| `gatekeepers`

#### `audit_log`
category: `content` \| `admins` \| `money` \| `catalogue` \| `platform` \| `support` \| `security`  
Every privileged Super Admin / Place Admin money or enforcement action writes a row.

#### `integration_health`
Chapa, Firebase, Firecrawl, Whisperflow, ElevenLabs, Fal — status, latencyMs, usage, quota, lastCheckedAt.

---

## 5. Business rules (do not leave ambiguous)

1. **Maintenance mode:** when `true`, reject new ticket/gift/booking payment starts and reject gate scans with `503 MAINTENANCE`.
2. **Commission:** `commission = round(amount * commissionRate / 100, 2)`; partner share = `amount - commission`. Snapshot rate on the transaction.
3. **Ticket QR payload:** HMAC-signed opaque string containing `ticketId` + `attractionId` + `exp`. Custom API verifies signatures; clients never forge payloads.
4. **Gift keycode:** 3-letter site slug + `-` + 4 digits, unique among active codes. Expires after `giftKeycodeExpiryHours`.
5. **Scan:**  
   - Solo ticket → mark ticket `used`, create one visit, return one name.  
   - Gift keycode → redeem next unused recipient name OR redeem whole group in one scan (MVP: **redeem all remaining names in one scan** for demo impact). Mark gift `fully_used` when done. Create one visit per name.  
   - Already used / expired / wrong attraction → `422` with clear code.
6. **Streak:** consecutive calendar months with ≥1 verified visit. Miss a month → streak resets to 0 next visit month. Recompute after every successful scan.
7. **All-regions for Ye Zellan Silt:** `regionsVisited` must include every distinct `region` among currently `active` attractions.
8. **Heritage Score:**  
   `heritageScore = round(100 * uniqueActiveSitesVisited / max(1, count(active attractions)))`  
   Recompute after each visit.
9. **Follower title:** recompute on follow/unfollow from `followerCount`.
10. **Inactive attraction:** hidden from browse; existing valid tickets still scannable until used/expired.
11. **Refund:** Custom API refunds via Chapa; marks transaction `refunded`; voids associated unused tickets; does not delete visits already scanned.
12. **Content removal:** Super Admin removal sets post `removed` + reason; author cannot undelete.
13. **Social report action:** requires `resolutionNote`; may also suspend user (`status=suspended`).
14. **Place admin:** can only read/write data where `attractionId` matches their assignment.
15. **Audit:** any void, revoke, refund, hold payout, remove content, suspend user, rotate key, change commission → audit row.

---

## 6. Screen → backend map

### 6.1 Customer app (Flutter traveler)

| # | Screen | Backend needs |
|---|---|---|
| 1 | Login / role selection | Firebase Auth; `GET /me` |
| 2 | Home / attraction browsing | `GET /attractions?active=true` |
| 3 | Attraction detail | `GET /attractions/{id}`; enrichment from stored `enrichedFacts` (Firecrawl job fills this) |
| 4 | Ticket purchase | `POST /payments/tickets/checkout` → Chapa; webhook settles ticket |
| 5 | Ticket / QR display | `GET /tickets/mine`; render `qrPayload` |
| 6 | My Passport | `GET /passport/me` (visits, stats, streak, title, heritageScore) |
| 7 | Guide list | `GET /guides` |
| 8 | Guide profile / booking | `GET /guides/{id}`; `POST /bookings` (+ optional pay) |
| 9 | Recap creation | `POST /recaps`; optional `POST /ai/transcribe` (Whisperflow) |
| 10 | Post detail + read-aloud | `GET /recaps/{id}`; `POST /ai/tts` (ElevenLabs) |
| 11 | Send a Gift | `POST /payments/gifts/checkout` → Chapa + keycode |
| — | Discovery feed (flag) | `GET /feed` |
| — | Report content | `POST /reports` |
| — | Follow user | `POST /users/{id}/follow` |
| — | Profile image gen (flag) | `POST /ai/image` (Fal) |

### 6.2 Staff app — Guide

| Screen | Backend |
|---|---|
| Guide mode home / bookings inbox | `GET /guides/me/bookings` |
| Confirm / decline booking | `PATCH /bookings/{id}` |
| Guide profile edit | `PATCH /guides/me` |

### 6.3 Staff app — Gatekeeper

| # | Screen | Backend |
|---|---|---|
| 12 | Scan | Camera local; `POST /scans/verify` |
| 13 | Confirmation | Uses verify response (`names[]`, type, attractionName) |

### 6.4 Attraction Admin web

| Page | Backend |
|---|---|
| Login | `POST /admin/auth/login` role `place_admin` |
| Dashboard | `GET /place/dashboard` (site revenue, visits, open tickets) |
| Visitors / scans | `GET /place/visits` |
| Tickets at site | `GET /place/tickets` |
| Gatekeepers for site | `GET/POST/PATCH /place/gatekeepers` |
| Site profile | `GET/PATCH /place/attraction` (non-destructive fields) |
| Payouts | `GET /place/payouts` |
| API key usage | `GET /place/credentials` (prefix only; issue via Super Admin) |

### 6.5 Platform Admin (Super Admin) web

| Page | Backend |
|---|---|
| Login | `POST /admin/auth/login` role `super_admin` |
| Overview | `GET /platform/overview` |
| Attractions | CRUD `/platform/attractions`; enrich `POST .../enrich` (Firecrawl) |
| Place admins | CRUD `/platform/place-admins` |
| Moderation | `/platform/recaps` keep/remove |
| Payments (live revenue) | `GET /platform/revenue/by-attraction` (+ optional SSE/poll) |
| Support | `/platform/support-cases` |
| Reports — social | `/platform/social-reports` |
| Reports — exports | CSV endpoints |
| Gamification | PATCH streak tiers & titles |
| Integrations | `GET /platform/integrations` + recheck |
| Security | API credential lifecycle |
| Settings | flags, announcements, maintenance, commercial terms |
| My account | profile + password |
| Audit log | list + CSV |

---

## 7. Custom API endpoint catalog

Unless noted, all endpoints require auth. Role column lists allowed roles.

### 7.1 Auth — apps

#### `GET /v1/me`
**Roles:** traveler, guide, gatekeeper  
**Response 200**
```json
{
  "user": {
    "id": "usr_01",
    "email": "selam@example.com",
    "displayName": "Selam Tesfaye",
    "photoUrl": null,
    "role": "traveler",
    "status": "active",
    "followerCount": 12,
    "heritageScore": 33,
    "streakMonths": 2,
    "currentBadge": { "id": "tier_01", "badgeName": "Dula", "item": "Wooden fighting stick" },
    "currentTitle": { "id": "ttl_01", "title": "Traveler", "amharic": "ተጓዥ" }
  }
}
```

#### `PATCH /v1/me`
Body: `{ "displayName"?, "photoUrl"?, "phone"? }`

---

### 7.2 Attractions (public read)

#### `GET /v1/attractions`
Query: `active=true|false`, `region=`, `q=`  
**Roles:** any authenticated app user; public read allowed if you prefer anonymous browse (MVP: authenticated).  
**Response**
```json
{
  "items": [
    {
      "id": "atr_adwa",
      "name": "Adwa Victory Memorial Museum",
      "address": "Piassa Square, Addis Ababa",
      "region": "Addis Ababa",
      "description": "…",
      "lat": 9.0342,
      "lng": 38.7636,
      "ticketPrice": 300.00,
      "active": true,
      "coverImageUrl": null,
      "enrichedFacts": ["…"]
    }
  ]
}
```

#### `GET /v1/attractions/{id}`
Same object; `404` if inactive and caller is traveler (admins may still fetch).

---

### 7.3 Payments — Chapa

#### `POST /v1/payments/tickets/checkout`
**Roles:** traveler  
**Flag:** not blocked by maintenance  
**Body**
```json
{
  "attractionId": "atr_adwa",
  "holderName": "Selam Tesfaye"
}
```
**Behavior:** create `transaction` pending + pending ticket; call Chapa initialize; return checkout URL.  
**Response 201**
```json
{
  "transactionId": "txn_01",
  "reference": "CHP-8F2A41",
  "checkoutUrl": "https://checkout.chapa.co/…",
  "amount": 300.00,
  "currency": "ETB"
}
```

#### `POST /v1/payments/gifts/checkout`
**Roles:** traveler  
**Flag:** `diaspora_gifting`  
**Body**
```json
{
  "attractionId": "atr_harar",
  "recipientNames": ["Meron Abebe", "Sara Mulugeta", "Abel Getachew"],
  "greeting": "From your cousin in DC"
}
```
**Response 201:** same shape as ticket checkout + `"recipients": 3`.

#### `POST /v1/payments/bookings/checkout`
**Roles:** traveler  
**Flag:** `guide_booking`  
**Body:** `{ "bookingId": "bkg_01" }` after booking is confirmed, or combine create+pay in one call for MVP.

#### `POST /v1/webhooks/chapa`
**Auth:** Chapa signature  
**Behavior:** on success → mark transaction succeeded; finalize ticket(s) or gift keycode; email/SMS optional. On fail → mark failed.

#### `POST /v1/payments/{transactionId}/refund`
**Roles:** super_admin  
**Body:** `{ "reason": "…" }`  
Calls Chapa refund; voids unused tickets; audit log.

---

### 7.4 Tickets & gifts (read)

#### `GET /v1/tickets/mine`
**Roles:** traveler  
Returns valid/used tickets with `qrPayload`, attraction summary, status.

#### `GET /v1/gifts/mine`
Sender’s gifts with keycode, status, recipientNames, redeemedCount.

---

### 7.5 Scan verification (critical)

#### `POST /v1/scans/verify`
**Roles:** gatekeeper  
**Body**
```json
{
  "code": "<qrPayload or gift keycode string>",
  "attractionId": "atr_harar"
}
```
**Response 200 — success**
```json
{
  "valid": true,
  "type": "solo_ticket",
  "names": ["Selam Tesfaye"],
  "attractionName": "Harar Jugol",
  "senderName": null,
  "greeting": null,
  "visitIds": ["vis_01"]
}
```
```json
{
  "valid": true,
  "type": "gift_keycode",
  "names": ["Meron Abebe", "Sara Mulugeta", "Abel Getachew"],
  "attractionName": "Harar Jugol",
  "senderName": "Yonas Alemu",
  "greeting": "From your cousin in DC",
  "visitIds": ["vis_02", "vis_03", "vis_04"]
}
```
**Response 422 — failure**
```json
{
  "valid": false,
  "type": null,
  "names": [],
  "attractionName": "Harar Jugol",
  "errorCode": "ALREADY_USED",
  "errorMessage": "This ticket was already scanned."
}
```
**Side effects:** create visits; update ticket/gift; recompute streak + heritageScore for matched users; write audit-lite scan log.

Gatekeeper `attractionId` MUST be in their `attractionIds` or `403`.

---

### 7.6 Passport & gamification

#### `GET /v1/passport/me`
```json
{
  "heritageScore": 50,
  "sitesVisited": 3,
  "regionsCovered": ["Addis Ababa", "Amhara"],
  "streakMonths": 4,
  "badge": { "badgeName": "Jile", "item": "Curved dagger" },
  "title": { "title": "Traveler", "amharic": "ተጓዥ" },
  "visits": [
    {
      "id": "vis_01",
      "attractionId": "atr_adwa",
      "attractionName": "Adwa Victory Memorial Museum",
      "scannedAt": "2026-07-20T08:12:00Z"
    }
  ],
  "isFirstPurchaseCelebrationEligible": false
}
```

#### Internal job: `recomputeProgress(userId)`
Called after visit create and follow graph changes. Updates streakMonths, badge, title, heritageScore, regionsVisited.

Super Admin configures tiers:

#### `GET /v1/platform/gamification`
#### `PUT /v1/platform/gamification/streak-tiers`
#### `PUT /v1/platform/gamification/follower-titles`
**Roles:** super_admin  
Body: full array replacement with validation (non-overlapping ranges).

---

### 7.7 Guides & bookings

#### `GET /v1/guides`
#### `GET /v1/guides/{id}`
#### `PATCH /v1/guides/me` (guide)
#### `POST /v1/bookings`
**Body**
```json
{
  "guideId": "usr_guide_01",
  "requestedDate": "2026-08-02",
  "note": "Family of four, Amharic ok"
}
```
**Response 201:** booking `requested`.

#### `GET /v1/bookings/mine` (traveler)
#### `GET /v1/guides/me/bookings` (guide)
#### `PATCH /v1/bookings/{id}`
Body: `{ "status": "confirmed" | "declined" | "cancelled" | "completed" }`  
Guide confirms/declines; traveler may cancel while `requested`.

---

### 7.8 Recaps & AI

#### `POST /v1/recaps`
**Body:** `{ "attractionId", "body", "imageUrl"? }`  
**Flag:** always for text; AI fields require `ai_recaps`.

#### `GET /v1/recaps/{id}`
#### `GET /v1/feed` (flag `discovery_feed`)
#### `POST /v1/recaps/{id}/like`
#### `DELETE /v1/recaps/{id}` (author only if published)

#### `POST /v1/ai/transcribe`
**Roles:** traveler  
**Upstream:** Whisperflow  
**Body:** multipart `audio` file  
**Response:** `{ "text": "…" }`  
Server stores nothing durable unless client then posts a recap.

#### `POST /v1/ai/tts`
**Upstream:** ElevenLabs  
**Body:** `{ "text": "…", "recapId"? }`  
**Response:** `{ "audioUrl": "https://…" }` (CDN or signed URL)

#### `POST /v1/ai/image`
**Upstream:** Fal  
**Body:** `{ "prompt": "…", "purpose": "recap" | "avatar" }`  
**Response:** `{ "imageUrl": "https://…" }`

#### `POST /v1/attractions/{id}/enrich` (platform)
**Upstream:** Firecrawl  
**Behavior:** scrape/enrich → write `enrichedFacts`, set `enrichmentStatus=ready|failed`.  
**Response:** `{ "facts": ["…"], "status": "ready" }`

---

### 7.9 Social graph & reports

#### `POST /v1/users/{id}/follow` / `DELETE /v1/users/{id}/follow`
#### `POST /v1/reports`
**Body**
```json
{
  "category": "violence",
  "contentType": "recap",
  "targetId": "pst_05",
  "postId": "pst_05",
  "notes": "Threatening language at the gate"
}
```
Increments report aggregates; may auto-flag post at threshold (MVP threshold: **3** reports → `flagged`).

---

### 7.10 Announcements (read)

#### `GET /v1/announcements`
Returns items for caller’s role audience ∪ `all`.

---

### 7.11 Admin auth

#### `POST /v1/admin/auth/login`
**Body:** `{ "email", "password" }`  
**Response**
```json
{
  "accessToken": "…",
  "refreshToken": "…",
  "expiresIn": 900,
  "admin": {
    "id": "au_01",
    "email": "superadmin@viseth.et",
    "displayName": "Selamawit Kebede",
    "role": "super_admin",
    "attractionId": null
  }
}
```
Place admin response includes `"role":"place_admin","attractionId":"atr_adwa"`.

#### `POST /v1/admin/auth/refresh`
#### `POST /v1/admin/auth/logout`
#### `POST /v1/admin/auth/change-password`
**Body:** `{ "currentPassword", "newPassword" }`

#### `GET /v1/admin/me` / `PATCH /v1/admin/me`

---

### 7.12 Attraction Admin (`/v1/place/*`)

All require `place_admin` JWT; server injects `attractionId` from token — clients cannot override.

| Method | Path | Purpose |
|---|---|---|
| GET | `/place/dashboard` | gross, commission, visitsToday, validTickets, recentScans |
| GET | `/place/visits` | paginated visits |
| GET | `/place/tickets` | tickets for site |
| GET | `/place/attraction` | site profile |
| PATCH | `/place/attraction` | update description/cover (not ticketPrice if Super Admin owns pricing — **MVP: Place Admin may update description & cover only; Super Admin owns price/active/geo**) |
| GET/POST/PATCH | `/place/gatekeepers` | manage gatekeepers for this site |
| GET | `/place/payouts` | payouts for site |
| GET | `/place/revenue` | totals for site |

---

### 7.13 Platform Admin (`/v1/platform/*`)

All require `super_admin`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/platform/overview` | KPIs + queues |
| GET/POST | `/platform/attractions` | list/create |
| GET/PATCH | `/platform/attractions/{id}` | read/update |
| POST | `/platform/attractions/{id}/activate` | `{ "active": true\|false }` |
| POST | `/platform/attractions/{id}/enrich` | Firecrawl |
| GET/POST | `/platform/place-admins` | list/create |
| PATCH | `/platform/place-admins/{id}` | edit/activate |
| GET | `/platform/recaps?status=` | moderation queue |
| POST | `/platform/recaps/{id}/keep` | clear reports → published |
| POST | `/platform/recaps/{id}/remove` | `{ "reason" }` |
| GET | `/platform/social-reports` | filters: status, category, page, pageSize |
| POST | `/platform/social-reports/{id}/resolve` | `{ "status":"actioned\|dismissed", "resolutionNote" }` |
| GET | `/platform/revenue/by-attraction` | live totals |
| GET | `/platform/revenue/stream` | SSE: push on succeeded payment (optional) |
| GET | `/platform/transactions` | ledger (export source) |
| GET | `/platform/payouts` | |
| POST | `/platform/payouts/{id}/hold` | `{ "reason" }` |
| POST | `/platform/payouts/{id}/release` | |
| POST | `/platform/payouts/{id}/mark-paid` | |
| GET/PATCH | `/platform/support-cases` | |
| POST | `/platform/support-cases/{id}/status` | `{ "status", "resolution"? }` |
| GET/PUT | `/platform/settings` | commercial + maintenance |
| GET/PATCH | `/platform/feature-flags/{key}` | `{ "enabled", "rollout" }` |
| GET/POST | `/platform/announcements` | |
| GET/POST | `/platform/api-credentials` | issue |
| POST | `/platform/api-credentials/{id}/rotate` | returns secret once |
| POST | `/platform/api-credentials/{id}/revoke` | |
| GET | `/platform/integrations` | |
| POST | `/platform/integrations/{id}/recheck` | ping upstream |
| GET | `/platform/audit-log` | |
| GET | `/platform/exports/sites.csv` | |
| GET | `/platform/exports/payments.csv` | |
| GET | `/platform/exports/social-reports.csv` | |
| GET | `/platform/exports/audit.csv` | |

#### `GET /v1/platform/revenue/by-attraction` response
```json
{
  "updatedAt": "2026-07-25T19:30:00Z",
  "totals": {
    "gross": 184200.00,
    "commission": 22104.00,
    "settledSales": 412
  },
  "items": [
    {
      "attractionId": "atr_lalibela",
      "name": "Lalibela Rock-Hewn Churches",
      "address": "…",
      "active": true,
      "gross": 52800.00,
      "commission": 6336.00,
      "partnerShare": 46464.00,
      "settledSales": 44,
      "lastSaleAt": "2026-07-25T19:29:40Z"
    }
  ]
}
```

#### `GET /v1/platform/overview` response (shape)
```json
{
  "netRevenue": 22104.00,
  "grossVolume": 184200.00,
  "verifiedVisits": 390,
  "liveSites": 6,
  "activePlaceAdmins": 5,
  "queues": {
    "sitesWithoutAdmin": 1,
    "openSupport": 4,
    "flaggedRecaps": 3,
    "openSocialReports": 5
  },
  "visitsByDay": [{ "date": "2026-07-12", "visits": 12 }],
  "revenueByAttraction": [{ "attractionId": "atr_adwa", "gross": 22200.00 }]
}
```

---

## 8. Third-party integrations (exact duties)

| Service | Called by | When | Purpose | Secrets location |
|---|---|---|---|---|
| **Chapa** | Custom API | checkout + webhook + refund | Ticket, gift, booking payments | Server env `CHAPA_SECRET_KEY` |
| **Firebase Auth/Firestore** | Apps + API Admin SDK | always | Identity & primary datastore | Server service account; client config in apps |
| **Firecrawl** | Custom API | Super Admin enrich OR async job on create | Attraction facts into `enrichedFacts` | Server env |
| **Whisperflow** | Custom API `/ai/transcribe` | Recap voice input | Speech → text | Server env |
| **ElevenLabs** | Custom API `/ai/tts` | Post read-aloud | Text → audio URL | Server env |
| **Fal** | Custom API `/ai/image` | Recap/avatar image | Image generation | Server env |
| **Google Maps** | Platform Admin **frontend only** | Pin picker | Geocode/reverse geocode | `VITE_GOOGLE_MAPS_API_KEY` (client). Backend stores lat/lng only — no Maps server key required for MVP. |
| **SMS provider (optional)** | Custom API | After gift success | Send keycode to recipients | Server env — if absent, return keycode to sender UI only |
| **Live streaming SDK** | Client-only if flag on | Backlog | Not backend MVP |

### Chapa webhook requirements
- Verify signature.
- Idempotent on `reference`.
- Map statuses to `pending|succeeded|failed`.
- Never trust client “payment success” without webhook or server verify.

### AI proxy requirements
- Enforce `ai_recaps` / rollout %.
- Timeout 30s; on failure return `502` with `UPSTREAM_TIMEOUT` / `UPSTREAM_ERROR`.
- Strip PII from logs; do not persist raw audio longer than needed to transcribe (delete within 24h).

---

## 9. Firestore security rules (summary)

- Travelers: read active attractions; CRUD own profile fields; create own tickets only via API (prefer API-only writes for tickets).
- **Recommended hardening:** tickets, gifts, transactions, visits are **Admin SDK / API only** — clients read their own via API.
- Guides: update own `guides` doc; read own bookings.
- Gatekeepers: no direct visit writes; scan via API only.
- Place/Super admin: no direct Firestore from browser; API only.

---

## 10. Jobs & schedulers

| Job | Schedule | Action |
|---|---|---|
| Expire tickets/gifts | hourly | status → `expired` |
| Monthly payouts | `payoutDay` 00:05 Africa/Addis_Ababa | create `payouts` rows from prior month succeeded sales |
| Integration health ping | every 5–15 min | update `integration_health` |
| Streak month rollover check | daily | optionally mark users who will break streak (notification backlog) |

---

## 11. Non-functional requirements

- p95 scan verify < 800ms excluding network from device.
- Checkout init < 2s excluding Chapa redirect.
- All money endpoints idempotent via `Idempotency-Key` header (UUID).
- Rate limit: scan 30/min/device; AI 10/min/user; login 10/min/IP.
- Structured logs with `requestId`, `userId`, `attractionId`.
- Staging sandbox Chapa keys only until production checklist signed.

---

## 12. Seed data expectations for demo

Must ship with:
- ≥5 attractions across ≥3 regions (Adwa, Lalibela, Harar, Gondar, Aksum, Sof Omar as in admin console).
- Super Admin: `superadmin@viseth.et`.
- ≥1 place admin per major site.
- ≥1 gatekeeper user assigned to Harar for gift demo.
- ≥1 guide with bookable profile.
- Seeded recaps (published + flagged).
- Open social reports in all three categories.

---

## 13. Acceptance checklist (backend done when…)

- [ ] Traveler can pay (Chapa sandbox), see QR, gatekeeper scan succeeds with green confirmation.
- [ ] Diaspora gift: pay N names → keycode → scan announces all names + sender.
- [ ] Passport shows visits, heritage score, streak badge, follower title.
- [ ] Recap: text + Whisperflow path + ElevenLabs audio URL.
- [ ] Firecrawl enrich writes facts visible on attraction detail.
- [ ] Place Admin sees only their site metrics.
- [ ] Super Admin: attractions, place admins, moderation, social reports, revenue-by-site, support, flags, announcements, API keys, audit CSV.
- [ ] Maintenance mode blocks pay + scan.
- [ ] Webhooks idempotent; refunds void unused tickets.
- [ ] No vendor secrets in client apps.

---

## 14. Explicit decisions (so you do not need to ask)

| Topic | Decision |
|---|---|
| Gift redeem mode | One scan redeems **all remaining** recipient names |
| Heritage score | Unique active sites visited / active sites × 100 |
| Ticket pricing owner | Super Admin |
| Place Admin pricing | Cannot change ticket price in MVP |
| QR format | Opaque HMAC payload from API, not raw ticket UUID alone |
| Social auto-flag | 3 reports → post `flagged` |
| Emperor title | Never use አጼ; cap at Ras |
| Streaming | Out of backend MVP |
| Chat | Out of backend MVP |
| Admin traveler directory | Not required; Super Admin does not CRUD travelers |

---

*End of Backend Technical Specification v1.0*
