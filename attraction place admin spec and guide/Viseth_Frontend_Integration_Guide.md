# Viseth — Frontend Integration Guide

**Audience:** Customer App (Flutter), Staff App (Flutter), Attraction Admin (React), Platform Admin (React).
**Source of truth for contracts:** `Viseth_Backend_Technical_Specification.md` (this guide tells you *how to call* what that doc defines).
**Base URLs:**

| Env | API |
|---|---|
| Production | `https://api.viseth.et/v1` |
| Staging | `https://viseth-api-staging.onrender.com/v1` |

Store as `API_BASE` / `VITE_API_URL`. Never hardcode provider keys (Chapa, WisprFlow, ElevenLabs, Fal, Firecrawl) in any client — the API owns those.

---

## Table of contents

1. [Shared client rules](#1-shared-client-rules)
2. [Auth bootstrap (every surface)](#2-auth-bootstrap-every-surface)
3. [Customer App](#3-customer-app)
4. [Staff App](#4-staff-app)
5. [Attraction Admin](#5-attraction-admin)
6. [Platform Admin](#6-platform-admin)
7. [Errors, polling, and offline QR](#7-errors-polling-and-offline-qr)
8. [Quick endpoint index](#8-quick-endpoint-index)

---

## 1. Shared client rules

### 1.1 Headers on every authenticated call

```http
Authorization: Bearer <Firebase ID token>
Accept-Language: en          # or am
Content-Type: application/json
Idempotency-Key: <uuid>      # REQUIRED on POST /tickets, POST /tickets/{id}/pay, POST /visits/verify
```

Refresh the Firebase ID token before calls if it is near expiry. After staff/admin account creation or first claim change, call `getIdToken(true)` so custom claims (`role`, `attractionId`, `staffId`) land in the token.

### 1.2 Success shape

- Single resource → bare JSON object (no `{ data: ... }` wrapper).
- Lists → `{ "items": [...], "nextCursor": "...|null", "hasMore": boolean }`.
- Pagination query: `?limit=20&cursor=<opaque>` (`limit` max 100).

### 1.3 Error shape (switch on `error.code`)

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

Show `message` or `messageAm` from `Accept-Language`. Log `requestId` for support. On `401 TOKEN_EXPIRED`, refresh token once and retry; on second failure, sign out.

### 1.4 Firestore vs API

| Path | Client may |
|---|---|
| Read live attractions, own user (rules permitting) | Firestore direct (optional) |
| Tickets, payments, visits, staff create, AI, moderation | **API only** |
| Cover / post media | Prefer `POST /media/upload` or admin cover endpoint |

If unsure: money, proof, privilege → API.

### 1.5 Minimal HTTP helper (TypeScript / Dart-equivalent)

```ts
async function api<T>(
  path: string,
  opts: { method?: string; body?: unknown; idempotencyKey?: string; auth?: boolean } = {}
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept-Language': locale, // 'en' | 'am'
  };
  if (opts.auth !== false) {
    headers.Authorization = `Bearer ${await firebaseUser.getIdToken()}`;
  }
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method ?? 'GET',
    headers,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json?.error?.code ?? 'INTERNAL'), { status: res.status, ...json.error });
  return json as T;
}
```

---

## 2. Auth bootstrap (every surface)

### Step A — Firebase sign-in

| Surface | Methods |
|---|---|
| Customer | Phone OTP, Google |
| Staff / Attraction Admin / Platform Admin | Email + password |

### Step B — Session upsert

```http
POST /auth/session
Authorization: Bearer <idToken>

{ "displayName": "Eyerusalem Mekonnen", "locale": "am", "country": "ET", "pushToken": "fcm_..." }
```

**200 response (route the shell from `role`):**

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
  "passport": {
    "heritageScore": 340,
    "title": "Highland Wanderer",
    "visitCount": 7,
    "regionsVisited": ["Addis Ababa", "Amhara"],
    "streakDays": 3,
    "lastVisitAt": "2026-07-20T09:12:00Z"
  }
}
```

| `role` | Open |
|---|---|
| `visitor` | Customer App |
| `gatekeeper` / `guide` | Staff App (or Admin Staff tab → `/staff`) |
| `attraction_admin` | Attraction Admin |
| `super_admin` | Platform Admin |

Wrong surface → show “Wrong app” and sign out; do not soft-fail into empty dashboards.

### Step C — Cold start

```http
GET /auth/me
```

Same body as session. Then:

```http
GET /config
```

Public subset: `{ "minAppVersion": "...", "giftingEnabled": true, "maintenanceBanner": null }`. Force-update if app version &lt; `minAppVersion`.

### Forced password change (staff / new admins)

If `mustChangePassword === true`:

```http
POST /auth/change-password
{ "newPassword": "AtLeast8Chars!" }
```

**204** → clear local flag, continue. Block the rest of the app until this succeeds.

### Profile

```http
PATCH /users/me
{ "displayName": "...", "locale": "am", "country": "US", "phone": "+2519...", "photoUrl": "https://..." }
```

`isDiaspora` is recomputed server-side when `country !== "ET"`.

```http
POST /users/me/push-tokens
{ "token": "fcm_..." }
```

```http
DELETE /users/me/push-tokens/{token}
```

---

## 3. Customer App

### 3.1 Splash → Home

1. `GET /config` (no auth)
2. Firebase restore → `GET /auth/me` (if signed in)
3. Home parallel:

```http
GET /attractions?sort=popular&limit=20
GET /recommendations
```

**Attractions list item (expect):**

```json
{
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
}
```

**Recommendations:**

```json
{
  "items": [
    {
      "attractionId": "atr_lalibela",
      "name": "Lalibela Rock-Hewn Churches",
      "reason": "You've visited 2 historical sites in Amhara",
      "score": 0.82
    }
  ]
}
```

Always render something — the API falls back to heuristics if Fal is down.

### 3.2 Search / filters / map

```http
GET /attractions?q=adwa&region=Addis%20Ababa&category=museum&maxPriceEtb=500&freeOnly=false
GET /attractions?nearLat=9.03&nearLng=38.74&radiusKm=15&sort=nearest
```

### 3.3 Attraction detail

```http
GET /attractions/atr_adwa
GET /attractions/atr_adwa/availability?date=2026-07-28
GET /attractions/atr_adwa/guides
```

**Detail extras to wire:**

| Field | UI |
|---|---|
| `enrichedFacts.summary` | Facts block (not a substitute for `description`) |
| `narration[locale].audioUrl` | Audio guide — play URL directly from Storage |
| `guides[]` | Guide cards (no phone/email/licence) |
| `todayCapacity` | Soft capacity hint |

**Availability:**

```json
{
  "date": "2026-07-28",
  "open": true,
  "remainingCapacity": 14,
  "closedReason": null,
  "hours": "Tue–Sun, 8:30am – 5:30pm"
}
```

### 3.4 Buy ticket (+ diaspora gift)

**Create pending ticket** — generate a UUID for `Idempotency-Key` and reuse it on retries of the same purchase intent.

```http
POST /tickets
Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000

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

Omit `gift` for a normal self purchase. Hide gift UI if `GET /config` → `giftingEnabled === false` or attraction `allowsGifting === false`.

**201 — store these once in secure storage (Keychain / Keystore):**

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

> Later `GET /tickets/{id}` returns only `keycodeLast4`. If the user clears app storage before paying, they cannot recover the QR — show that clearly after create.

If `requiresPayment === false` (free check-in sites), skip payment and show the QR immediately (`status` is already `paid`).

### 3.5 Pay with Chapa

```http
POST /tickets/tkt_9fA2kd/pay
Idempotency-Key: <new uuid for this pay attempt>

{ "returnUrl": "viseth://payment/return" }
```

**200:**

```json
{
  "paymentId": "pay_3Kd8",
  "checkoutUrl": "https://checkout.chapa.co/checkout/payment/xyz...",
  "merchantOrderId": "VISETH-tkt_9fA2kd-01",
  "expiresAt": "2026-07-25T14:18:00Z"
}
```

**Client sequence:**

1. Open `checkoutUrl` in an in-app browser / webview.
2. On return to `viseth://payment/return` (or webview close), **do not trust success**.
3. Poll every 3s for up to 3 minutes:

```http
GET /tickets/tkt_9fA2kd
```

4. When `status === "paid"` → wallet / QR screen.
5. If still `pending` after timeout → “Payment is processing; check wallet later” (reconcile job may finish it).
6. On `503 PAYMENT_PROVIDER_DOWN` → retry pay with a **new** Idempotency-Key.

### 3.6 Wallet, QR, claim gift

```http
GET /tickets?status=paid&limit=50
GET /tickets/tkt_9fA2kd
POST /tickets/tkt_9fA2kd/claim
```

Render QR from **local** `qrPayload`. Detail response example:

```json
{
  "id": "tkt_9fA2kd",
  "attractionId": "atr_adwa",
  "attractionName": "Adwa Victory Memorial Museum",
  "status": "paid",
  "amountEtb": 750,
  "partySize": 3,
  "keycodeLast4": "2XB",
  "visitDate": "2026-07-28",
  "expiresAt": "2026-08-27T00:00:00Z",
  "gift": {
    "recipientName": "Almaz Wolde",
    "recipientHandle": "+2519...118",
    "claimed": true
  },
  "visit": null
}
```

After gate scan, `status` becomes `used` and `visit` is populated. Push `visit_verified` also arrives — refresh passport + wallet.

Cancel only while pending:

```http
POST /tickets/tkt_9fA2kd/cancel
```

### 3.7 Passport, visits, share card

```http
GET /passport/me
GET /visits/me?limit=20
POST /visits/vst_71bc/card
```

**Passport:**

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
  "recentVisits": [
    {
      "visitId": "vst_71bc",
      "attractionName": "Adwa Victory Memorial Museum",
      "attractionImageUrl": "https://...",
      "verifiedAt": "2026-07-20T09:12:00Z",
      "hasPost": true
    }
  ]
}
```

Share card → `{ "imageUrl": "https://storage.../card.png" }` (Fal-rendered). Public link:

```http
GET /users/{uid}/passport
```

### 3.8 Create post + voice story

1. Upload media:

```http
POST /media/upload
Content-Type: multipart/form-data

file: <bytes>
purpose: post | voice-story | avatar
```

**200:** `{ "url": "https://storage.../..." }`

2. Create post (must own the visit; one post per visit):

```http
POST /posts

{
  "visitId": "vst_71bc",
  "caption": "Standing where 1896 was decided.",
  "mediaUrls": ["https://storage.../p1.jpg"],
  "voiceStory": { "audioUrl": "https://storage.../story.m4a" },
  "visibility": "public"
}
```

If voice is present, transcript may be null briefly. Poll:

```http
GET /ai/jobs/{jobId}
```

until `status` is `succeeded` | `failed`. Post stays visible either way (WisprFlow failure must not block sharing).

Optional direct STT:

```http
POST /ai/transcribe
{ "audioUrl": "https://...", "language": "auto" }
```

→ `202 { "jobId": "aij_..." }`

### 3.9 Feed & social

```http
GET /feed?scope=following
GET /feed?scope=discover
GET /feed?scope=attraction&attractionId=atr_adwa

POST /posts/{id}/like
DELETE /posts/{id}/like
POST /posts/{id}/comments
{ "body": "Beautiful." }
GET /posts/{id}/comments
POST /posts/{id}/report
{ "reason": "spam" }
POST /users/{uid}/follow
DELETE /users/{uid}/follow
DELETE /posts/{id}
```

Every feed item includes `verified: { visitId, verifiedAt }` — always show the proof badge.

### 3.10 Book a guide

```http
POST /bookings
{
  "guideId": "gd_01",
  "date": "2026-07-28",
  "partySize": 3,
  "language": "Amharic",
  "ticketId": "tkt_9fA2kd",
  "note": "First time at Adwa"
}

GET /bookings/me
PATCH /bookings/bkg_01
{ "status": "cancelled" }

POST /bookings/bkg_01/rate
{ "rating": 5, "comment": "Wonderful tour." }
```

Visitor may cancel `requested|confirmed`. Guide confirm/decline is Staff App.

### 3.11 Notifications

```http
GET /notifications?unreadOnly=true
POST /notifications/{id}/read
POST /notifications/read-all
```

Kinds: `ticket_paid`, `gift_received`, `gift_used`, `visit_verified`, `booking_*`, etc. Use `href` for deep links.

---

## 4. Staff App

### 4.1 Sign-in → desk

```http
POST /auth/session
GET /staff/me
```

**200 `/staff/me`:**

```json
{
  "role": "gatekeeper",
  "profile": {
    "id": "gk_01",
    "name": "Girma Tadesse",
    "gateLabel": "Main Entrance",
    "shift": "Morning",
    "active": true,
    "scanCount": 214,
    "mustChangePassword": false
  },
  "attraction": {
    "id": "atr_adwa",
    "name": "Adwa Victory Memorial Museum",
    "nameAm": "የአድዋ ድል መታሰቢያ ሙዚየም"
  }
}
```

| `role` | UI |
|---|---|
| `gatekeeper` | Scanner + today + expected |
| `guide` | Tours desk |

If `mustChangePassword`, force `POST /auth/change-password` first.

### 4.2 Gate verify (most important call)

Prefer QR payload; fall back to manual fields.

```http
POST /visits/verify
Idempotency-Key: <uuid per physical scan attempt>

{
  "qrPayload": "viseth://t/tkt_9fA2kd/7QK4M2XB",
  "deviceId": "and_9f2b3c",
  "scannedAt": "2026-07-28T09:14:01Z"
}
```

Manual:

```json
{
  "ticketId": "tkt_9fA2kd",
  "keycode": "7QK4M2XB",
  "deviceId": "and_9f2b3c"
}
```

**201 success — drive greeting UI from this body:**

```json
{
  "visitId": "vst_71bc",
  "verifiedAt": "2026-07-28T09:14:02Z",
  "visitor": {
    "displayName": "Almaz Wolde",
    "photoUrl": null,
    "isGiftRecipient": true
  },
  "greeting": {
    "line": "Welcome, Almaz.",
    "lineAm": "እንኳን ደህና መጡ፣ አልማዝ።",
    "giftedByLabel": "Gift from family abroad"
  },
  "ticket": {
    "partySize": 3,
    "amountEtb": 750,
    "attractionName": "Adwa Victory Memorial Museum"
  },
  "capacity": { "peopleToday": 34, "dailyCapacity": 45 }
}
```

Show `giftedByLabel` when non-null — that is the diaspora gift moment.

**Map error codes to UI (do not invent copy that contradicts these):**

| `code` | HTTP | UI |
|---|---|---|
| `KEYCODE_MISMATCH` | 403 | Invalid / forged QR |
| `TICKET_ALREADY_USED` | 409 | Already scanned — show `details.verifiedAt` |
| `WRONG_SITE` | 403 | Wrong attraction |
| `CAPACITY_REACHED` | 409 | Site full today |
| `TICKET_EXPIRED` | 409 | Expired |
| `TICKET_UNPAID` | 409 | Not paid yet |
| `QR_MALFORMED` | 400 | Cannot read code |
| `GATEKEEPER_DISABLED` | 403 | Account disabled — sign out |

Use a **new** Idempotency-Key only for a new physical scan. Retrying the same scan after network failure should reuse the same key so you never create a double visit.

### 4.3 Gate desk widgets

```http
GET /staff/gate/today
```

```json
{
  "date": "2026-07-28",
  "scansByMe": 41,
  "peopleToday": 34,
  "dailyCapacity": 45,
  "capacityPct": 76,
  "lastScanAt": "2026-07-28T09:14:02Z"
}
```

```http
GET /staff/gate/expected
```

```json
{
  "items": [
    {
      "ticketId": "tkt_9fA2kd",
      "recipientName": "Almaz Wolde",
      "partySize": 3,
      "keycodeLast4": "2XB",
      "giftedByLabel": "Gift from family abroad"
    }
  ]
}
```

### 4.4 Guide desk

```http
GET /bookings/me?status=requested
GET /bookings/me?status=confirmed
PATCH /bookings/bkg_01
{ "status": "confirmed" }
```

Allowed for guide: `requested → confirmed|declined`, `confirmed → completed`.

Profile/licence: from `GET /staff/me` (`role: "guide"`).

---

## 5. Attraction Admin

**Scope:** every admin call is scoped by the JWT claim `attractionId`. Prefer paths that include your site id for clarity; a mismatch returns **404** (not 403). Never create attractions or attraction admins here — that is Platform Admin.

Resolve `attractionId` from `POST /auth/session` / `GET /auth/me` after login.

### 5.1 Login routing

| Tab | After Firebase + session |
|---|---|
| Admin | `role === 'attraction_admin'` → `/` |
| Staff | `GET /staff/me` → `/staff` gate or guide desk |

### 5.2 Sales & Visitors (dashboard — one shot)

```http
GET /admin/attractions/{attractionId}
GET /admin/attractions/{attractionId}/summary?days=30
GET /admin/attractions/{attractionId}/visits?limit=10
GET /admin/notifications
```

**Summary:**

```json
{
  "ticketsSold": 168,
  "revenueEtb": 41250,
  "verifiedVisits": 143,
  "uniqueVisitors": 121,
  "giftedTickets": 24,
  "expiredTickets": 11,
  "peopleToday": 34,
  "dailyCapacity": 45,
  "capacityPct": 76,
  "requiresTicket": true,
  "daily": [
    { "date": "2026-06-26", "revenueEtb": 1250, "visits": 5, "people": 11 }
  ]
}
```

`daily` always has exactly `days` points (zero-filled). Chart that array; do not re-aggregate tickets client-side.

### 5.3 Tickets table + CSV

```http
GET /admin/attractions/{attractionId}/tickets?status=paid&q=2XB&from=2026-07-01&to=2026-07-31
GET /admin/attractions/{attractionId}/tickets.csv?status=all
```

CSV: open as blob download (`Content-Disposition: attachment`). Columns include buyer, gift flag, `keycodeLast4`, amount, status.

### 5.4 Gatekeepers (server creates Auth users)

```http
GET /admin/gatekeepers
POST /admin/gatekeepers
{
  "name": "Girma Tadesse",
  "phone": "+251911204118",
  "email": "girma.tadesse@gmail.com",
  "password": "TempPass2026",
  "employeeId": "ADW-0142",
  "gateLabel": "Main Entrance",
  "shift": "Morning"
}
```

**201** returns the gatekeeper document **without** the password. Hand the temp password to the staff member out-of-band once.

```http
PATCH /admin/gatekeepers/{id}
{ "gateLabel": "East Gate", "shift": "Afternoon" }

POST /admin/gatekeepers/{id}/active
{ "active": false }
```

> Do **not** call Firebase `createUserWithEmailAndPassword` from the browser — it would replace the operator’s session.

### 5.5 Guides

```http
GET /admin/guides
POST /admin/guides
{
  "name": "Feven Getnet",
  "nameAm": "...",
  "phone": "+2519...",
  "email": "feven@example.com",
  "password": "TempPass2026",
  "licenceNumber": "GUIDE-7781",
  "licenceExpiry": "2027-01-15",
  "yearsExperience": 6,
  "languages": ["Amharic", "English"],
  "bio": "...",
  "bioAm": "..."
}

PATCH /admin/guides/{id}
POST /admin/guides/{id}/status
{ "status": "suspended" }
```

No approval queue — register → active; suspend/reactivate only.

### 5.6 Listing settings

```http
GET /admin/attractions/{attractionId}
PATCH /admin/attractions/{attractionId}
{
  "nameAm": "የአድዋ ድል መታሰቢያ ሙዚየም",
  "description": "...",
  "descriptionAm": "...",
  "priceEtb": 250,
  "hours": "Tue–Sun, 8:30am – 5:30pm",
  "region": "Addis Ababa",
  "status": "live",
  "dailyCapacity": 45,
  "allowsGifting": true
}
```

**English `name` is locked.** Sending `"name"` is ignored (or stripped); do not show it as editable.

Cover:

```http
POST /admin/attractions/{attractionId}/cover
Content-Type: multipart/form-data
file: <image ≤ 5MB>
```

**200:** `{ "imageUrl": "https://..." }` — persist by including `imageUrl` in a subsequent PATCH if your UX separates upload from save.

Optional audio guide generation:

```http
POST /attractions/{attractionId}/narration
```

→ `202 { "jobId": "aij_..." }` (ElevenLabs, server-side).

### 5.7 Account + notifications

```http
GET /auth/me
PATCH /users/me
{ "locale": "am" }

GET /admin/notifications
POST /admin/notifications/{id}/read
```

Alert kinds: licence expiry, capacity ≥ 85%, expired tickets, suspended guides.

---

## 6. Platform Admin

All routes require `role === 'super_admin'`. Wrong role → sign out of this site.

### 6.1 Overview

```http
GET /platform/analytics?from=2026-07-01&to=2026-07-26
```

Expect `gmvEtb`, `ticketsSold`, `verifiedVisits`, `proofRatePct`, `diasporaGiftShare`, `topAttractions`, `byRegion`, `daily`.

### 6.2 Attractions lifecycle

```http
GET /attractions?includeDraft=true          # super_admin only for drafts
POST /platform/attractions
{
  "name": "Adwa Victory Memorial Museum",
  "region": "Addis Ababa",
  "category": "museum",
  "priceEtb": 250
}
```

English `name` set here is permanent for the product identity.

```http
PATCH /platform/attractions/{id}
DELETE /platform/attractions/{id}          # soft archive
POST /platform/attractions/{id}/enrich    # Firecrawl/Exa job → 202 { jobId }
GET /platform/jobs
```

### 6.3 Create attraction admin (operator account)

```http
POST /platform/attraction-admins
{
  "attractionId": "atr_adwa",
  "name": "Eyerusalem Mekonnen",
  "organisation": "Adwa Heritage Operations",
  "email": "operations@adwamuseum.et",
  "password": "TempPass2026",
  "phone": "+251116678840"
}
```

**201:**

```json
{
  "uid": "usr_op7",
  "email": "operations@adwamuseum.et",
  "role": "attraction_admin",
  "attractionId": "atr_adwa",
  "mustChangePassword": true
}
```

Operator signs in on Attraction Admin with that email/password, then changes password.

### 6.4 Users, payments, refunds

```http
GET /platform/users?q=almaz&role=visitor
POST /platform/users/{uid}/role
{ "role": "attraction_admin", "attractionId": "atr_adwa" }
POST /platform/users/{uid}/disable
{ "disabled": true }

GET /platform/payments?status=succeeded&from=&to=
GET /platform/payments/{id}
POST /platform/payments/{id}/reconcile    # Chapa verify repair
POST /tickets/{id}/refund                 # super_admin only
GET /platform/settlements?attractionId=&period=2026-07
```

### 6.5 Moderation, audit, flags

```http
GET /platform/moderation/reports?status=open
POST /platform/posts/{id}/moderate
{ "action": "hide", "reason": "..." }     # hide | remove | dismiss

GET /platform/audit-logs?from=&to=
GET /platform/config
PATCH /platform/config
{
  "giftingEnabled": true,
  "minAppVersion": "1.0.0",
  "maintenanceBanner": null
}
```

---

## 7. Errors, polling, and offline QR

### 7.1 Common codes (client switchboard)

| Code | Typical surface | Action |
|---|---|---|
| `UNAUTHENTICATED` / `TOKEN_EXPIRED` | all | Refresh token or re-login |
| `FORBIDDEN_ROLE` | all | Wrong app / wrong desk |
| `VALIDATION_FAILED` | forms | Show `details.fields` |
| `GIFTING_DISABLED` | Customer buy | Hide gift path |
| `PAYMENT_PROVIDER_DOWN` | Customer pay | Retry later |
| `PAYMENT_DECLINED` | Customer pay | New payment attempt |
| `TICKET_*` / `KEYCODE_*` / `CAPACITY_*` | Staff scan | See §4.2 table |
| `VISIT_NOT_YOURS` / `POST_EXISTS` | Customer post | Block create |
| `EMAIL_TAKEN` / `LICENCE_TAKEN` | Admin register | Inline field error |
| `RATE_LIMITED` | all | Honour `Retry-After` |
| `CANNOT_DEMOTE_SELF` | Platform | Block UI action |

### 7.2 Polling recipes

| Flow | Interval | Stop when |
|---|---|---|
| Chapa payment | 3s, max 3 min | `ticket.status` ∈ `paid\|cancelled\|expired` |
| AI job (transcript / narration / enrich) | 2s, max 2 min | `job.status` ∈ `succeeded\|failed` |
| Notifications badge | 30–60s or FCM | — |

### 7.3 Offline QR contract

- Persist after `POST /tickets`: `{ ticketId, keycode, qrPayload, attractionId, expiresAt }`.
- Encode QR as the exact string `qrPayload` (`viseth://t/{ticketId}/{keycode}`).
- Staff verify sends that string unchanged; never re-format or URL-encode the path segments differently.
- Wallet can show QR without network if `status` was last known `paid` and not past `expiresAt`; still refresh when online.

### 7.4 Deep links

| Link | Handler |
|---|---|
| `viseth://payment/return` | Resume poll of last `ticketId` |
| `viseth://t/{ticketId}/{keycode}` | Staff scanner (or ignore in Customer) |
| `viseth://passport/{uid}` | `GET /users/{uid}/passport` |
| `viseth://ticket/{ticketId}` | `GET /tickets/{id}` / claim flow |

---

## 8. Quick endpoint index

| Method | Path | Roles | Notes |
|---|---|---|---|
| POST | `/auth/session` | any | After Firebase sign-in |
| GET | `/auth/me` | any | Cold start |
| POST | `/auth/change-password` | any | Staff first login |
| PATCH | `/users/me` | any | Profile |
| GET | `/config` | public | Version / flags |
| GET | `/attractions` | public | Discovery |
| GET | `/attractions/{id}` | public | Detail |
| GET | `/attractions/{id}/availability` | public | |
| GET | `/attractions/{id}/guides` | public | Sanitised |
| GET | `/recommendations` | visitor | Fal + fallback |
| POST | `/tickets` | visitor | Idempotency-Key |
| POST | `/tickets/{id}/pay` | visitor | Chapa checkout |
| GET | `/tickets` · `/{id}` | owner/admin | Wallet |
| POST | `/tickets/{id}/claim` | visitor | Gift claim |
| POST | `/tickets/{id}/cancel` | buyer | pending only |
| POST | `/tickets/{id}/refund` | super_admin | |
| POST | `/webhooks/chapa` | Chapa only | Not for apps |
| POST | `/visits/verify` | gatekeeper | Idempotency-Key |
| GET | `/staff/me` | staff | Desk router |
| GET | `/staff/gate/today` · `/expected` | gatekeeper | |
| GET | `/passport/me` | visitor | |
| GET | `/visits/me` | visitor | |
| POST | `/visits/{id}/card` | visitor | Share PNG |
| POST | `/posts` + social | visitor | Proof-backed |
| GET | `/feed` | visitor | |
| POST | `/bookings` · PATCH · rate | visitor/guide | |
| POST | `/media/upload` | any auth | multipart |
| GET/POST | `/admin/*` | attraction_admin | Claim-scoped |
| GET/POST | `/platform/*` | super_admin | |
| POST | `/ai/transcribe` · GET `/ai/jobs/{id}` | auth | WisprFlow jobs |
| GET/POST | `/notifications*` | owner | |

---

## Integration checklist (ship gate)

**Customer**

- [ ] Secure-store `keycode` + `qrPayload` from create response only
- [ ] Chapa return URL only triggers poll; webhook/verify is truth
- [ ] Gift UI gated on config + attraction flags
- [ ] Posts require a owned visit; proof badge always visible on feed

**Staff**

- [ ] Success screen shows `greeting` (+ `giftedByLabel` when set)
- [ ] All verify failure codes mapped; double-scan shows already-used, not a second success
- [ ] Idempotency-Key reused on retry of the same scan

**Attraction Admin**

- [ ] English name read-only
- [ ] Staff created only via `/admin/gatekeepers` and `/admin/guides`
- [ ] Dashboard uses `/summary` single payload

**Platform Admin**

- [ ] Create attraction → create attraction admin before operator can log in
- [ ] Refunds and role changes audited; cannot demote self

---

**Document owner:** client surface leads. If a response field here disagrees with `Viseth_Backend_Technical_Specification.md`, the backend spec wins — file a PR against this guide.
