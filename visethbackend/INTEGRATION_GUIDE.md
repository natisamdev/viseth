# Viseth API — Full Client Integration Guide (Cursor-ready)

**Audience:** Flutter (Customer + Staff) and Web (Attraction Admin + Platform Admin) teams using Cursor AI  
**API version:** `/v1`  
**Payments:** **Telebirr** (not Chapa)  
**Auth:** Firebase ID token (mobile) · Admin JWT (web admins)  
**Date:** 2026-07-26  

Paste this file into Cursor and say: *“Integrate the Viseth API using INTEGRATION_GUIDE.md as the source of truth.”*

---

## 0. How Cursor should use this doc

1. Treat this document as the **contract**. Do not invent endpoints.  
2. Never put Telebirr secrets, Firebase private keys, or JWT secrets in client code.  
3. All money flows: **Custom API only** → Telebirr. Clients never call Telebirr directly.  
4. After payment UI returns, **always poll** `GET /payments/{id}` or `POST /payments/{id}/sync` — never trust the browser return alone.  
5. Base URL comes from env: `VISETH_API_BASE` (staging/production).

---

## 1. Environments

| Env | Base URL |
|---|---|
| Local | `http://localhost:8080/v1` |
| Staging / Render | `https://<your-service>.onrender.com/v1` |
| Production | `https://api.viseth.et/v1` (when DNS is set) |

Health: `GET {BASE}/health` → `{ "ok": true, "payments": "telebirr"|"mock" }`

Public config: `GET {BASE}/config`

```json
{
  "maintenanceMode": false,
  "supportEmail": "support@viseth.et",
  "platformFeePercent": 2,
  "currency": "ETB",
  "paymentProvider": "telebirr",
  "paymentsMode": "sandbox",
  "featureFlags": {
    "diaspora_gifting": true,
    "ai_recaps": true,
    "guide_booking": true,
    "streak_badges": true,
    "discovery_feed": true,
    "live_streaming": false,
    "hotels": true
  }
}
```

If `maintenanceMode === true`, disable Buy Ticket / Gift / Scan CTAs.

---

## 2. Shared HTTP rules

### Headers (every authenticated call)

```
Authorization: Bearer <token>
Content-Type: application/json
Accept: application/json
X-Client: customer | staff | attraction_admin | platform_admin
```

### Money POSTs (required)

```
Idempotency-Key: <uuid-v4>
```

Send the **same** key on retries of the same checkout. Different body + same key → conflict.

### Errors

```json
{
  "error": {
    "code": "ALREADY_USED",
    "message": "This ticket was already scanned.",
    "details": {}
  }
}
```

| HTTP | Client action |
|---|---|
| 400 | Show field errors |
| 401 | Refresh Firebase token once, else re-login |
| 403 | “Not allowed” |
| 404 | Empty state |
| 422 | Business rule (esp. scans) — show `error.message` |
| 429 | Back off |
| 502 | Telebirr/AI upstream — “Try again shortly” |
| 503 `MAINTENANCE` | Block pay/scan |

### Pagination

`?page=1&pageSize=20` → `{ items, page, pageSize, total, totalPages }`

---

## 3. Authentication

### 3.1 Customer + Staff (Flutter) — Firebase

```
1. Firebase Auth (phone OTP / Google)
2. token = await user.getIdToken()
3. Authorization: Bearer <token>
4. GET /me   // upserts user on first call
5. optional PATCH /me { "isDiaspora": true }
6. GET /config
```

**Dev-only shortcut (non-production API):**

```
Authorization: Bearer dev:usr_seed_traveler
Authorization: Bearer dev:gatekeeper
Authorization: Bearer dev:guide
```

### 3.2 Attraction / Platform Admin (Web) — JWT

```
POST /admin/auth/login
{ "email": "superadmin@viseth.et", "password": "…" }
```

**200**

```json
{
  "accessToken": "eyJ…",
  "refreshToken": "eyJ…",
  "expiresIn": 900,
  "admin": {
    "id": "au_super_01",
    "email": "superadmin@viseth.et",
    "displayName": "Selamawit Kebede",
    "role": "super_admin",
    "attractionId": null
  }
}
```

Place admin: `"role":"place_admin"` (treat as `attraction_admin` in UI) + non-null `attractionId`.

- Refresh: `POST /admin/auth/refresh` `{ "refreshToken" }`  
- Logout: `POST /admin/auth/logout`  
- Me: `GET /admin/me` or `GET /auth/me`

**Never send `attractionId` on place-admin mutations** — server scopes from JWT.

Aliases also available: `POST /auth/session`, `GET /auth/me` (after Bearer token).

---

## 4. Customer App — call book

### Login / splash
1. Firebase sign-in  
2. `GET /me`  
3. `PATCH /me` if diaspora  
4. `GET /config`

### Home / Feed
```
GET /feed?tab=for_you&page=1&pageSize=10
GET /feed?scope=following
GET /feed?scope=attraction&attractionId=atr_adwa
```

| Action | Call |
|---|---|
| Like | `POST /posts/{id}/like` or `POST /recaps/{id}/like` |
| Unlike | `DELETE /posts/{id}/like` |
| Comment | `POST /posts/{id}/comments` `{ "body" }` |
| Report | `POST /posts/{id}/report` `{ "reason" }` |
| Follow | `POST /users/{id}/follow` |

### Explore / nearby
```
GET /attractions?region=&category=&q=&page=1
GET /attractions/nearby?lat=9.03&lng=38.75&radiusKm=50
GET /attractions/{id}
POST /attractions/{id}/save
GET /hotels
GET /guides
GET /recommendations
```

### Buy ticket (Telebirr)

```
POST /payments/tickets/checkout
Idempotency-Key: <uuid>
{
  "attractionId": "atr_adwa",
  "holderName": "Selam Tesfaye",
  "guests": 2,
  "visitDate": "2026-07-26T10:00:00Z",
  "returnUrl": "viseth://payments/return"
}
```

**201**

```json
{
  "transactionId": "txn_…",
  "reference": "VST…",
  "checkoutUrl": "https://…telebirr…/paygate?…",
  "amount": 600,
  "fee": 12,
  "total": 612,
  "currency": "ETB",
  "kind": "ticket",
  "provider": "telebirr"
}
```

**Client flow**

1. Open `checkoutUrl` in WebView / external browser (Telebirr H5).  
2. On app resume / deep link `viseth://payments/return`:  
   - `POST /payments/{transactionId}/sync`  
   - or poll `GET /payments/{transactionId}` every 3s up to 3 minutes.  
3. When `status === "succeeded"` → `GET /tickets/mine` and show QR (`qrPayload`).

**Do not** mark the ticket paid from the WebView close event alone.

### Gift (diaspora)

```
POST /payments/gifts/checkout
Idempotency-Key: <uuid>
{
  "attractionId": "atr_harar",
  "recipientNames": ["Meron Abebe", "Sara Mulugeta"],
  "greeting": "From your cousin in DC",
  "visitDate": "2026-08-02T09:00:00Z",
  "returnUrl": "viseth://payments/return"
}
```

After success: `GET /gifts/mine` → show `keycode` (e.g. `HRR-4821`).

### Tickets / Passport
```
GET /tickets/mine?status=valid
GET /tickets/{id}
GET /passport/me
GET /visits/me
POST /me/celebrations/first-purchase   // after confetti
```

QR: encode **`qrPayload` only** (HMAC opaque string). Offline cache `{ ticketId, qrPayload, attractionId, expiresAt }`.

### Create post / voice story
```
POST /media/upload          # multipart field: file
POST /ai/transcribe         # multipart field: audio  → { text }
POST /posts
{
  "attractionId": "atr_lalibela",
  "visitId": "vis_…",
  "caption": "The rock churches feel eternal.",
  "media": [{ "url": "https://…", "kind": "image" }],
  "aiAssisted": true,
  "hasVoiceStory": true
}
POST /ai/tts  { "text": "…", "recapId": "pst_…" }
```

`POST /recaps` is an alias of `POST /posts`.

### Guides / hotels
```
GET /guides
POST /bookings  { "guideId", "requestedDate", "note?" }
GET /bookings/mine
POST /hotel-bookings
GET /hotel-bookings/mine
```

### Notifications
```
GET /notifications
POST /notifications/read  { "all": true } | { "ids": ["…"] }
```

---

## 5. Staff App — Gatekeeper + Guide

### Session
```
Firebase → GET /auth/session or GET /me
GET /staff/me   → { role, attractionIds, mustChangePassword }
```

### Gate scan (critical)
```
POST /visits/verify
# alias: POST /scans/verify
{
  "code": "<qrPayload OR gift keycode HRR-4821>",
  "attractionId": "atr_harar"
}
```

**200 success**

```json
{
  "valid": true,
  "type": "solo_ticket",
  "names": ["Selam Tesfaye"],
  "guests": 2,
  "attractionName": "Harar Jugol",
  "visitIds": ["vis_…"],
  "ticketId": "tkt_…"
}
```

**422 failure** → `{ "valid": false, "errorCode": "ALREADY_USED"|"EXPIRED"|"INVALID_CODE"|"WRONG_ATTRACTION"|"MAINTENANCE", "errorMessage": "…" }`

UX: success → haptic + green check; failure → calm error (no shake).

### Gate desk
```
GET /staff/gate/today
GET /staff/gate/expected
```

### Guide
```
GET /guides/me/bookings
PATCH /bookings/{id}  { "status": "confirmed"|"declined"|"completed" }
PATCH /guides/me
```

---

## 6. Attraction Admin (Web)

### Login
`POST /admin/auth/login` → store tokens → route by `admin.attractionId`.

### Dashboard / sales
```
GET /admin/attractions/{attractionId}
GET /admin/attractions/{attractionId}/summary?days=30
GET /admin/attractions/{attractionId}/visits
GET /admin/attractions/{attractionId}/tickets?status=paid
GET /admin/attractions/{attractionId}/tickets.csv
GET /admin/notifications
```

Aliases of older paths: `GET /place/dashboard`, `/place/visits`, `/place/tickets`.

### Listing settings
```
GET /admin/attractions/{attractionId}
PATCH /admin/attractions/{attractionId}
  { "description?", "coverImageUrl?" }   // English name / price blocked server-side
POST /admin/attractions/{attractionId}/cover   # multipart file
```

### Gatekeepers / guides
```
GET/POST /admin/gatekeepers
POST /admin/gatekeepers/{id}/active  { "active": false }
GET/POST /admin/guides
POST /admin/guides/{id}/status  { "status": "suspended"|"active" }
```

Staff accounts are **created by the API** (never `createUserWithEmailAndPassword` in the browser).

---

## 7. Platform Admin (Web)

```
POST /admin/auth/login   # superadmin@viseth.et
GET /platform/overview
GET /platform/analytics          # alias
GET/POST /platform/attractions
POST /platform/attractions/{id}/enrich
POST /platform/attraction-admins
GET /platform/place-admins
GET/PATCH /platform/guides
GET /platform/transactions
GET /platform/moderation/reports
POST /platform/posts/{id}/moderate  { "action":"remove"|"keep"|"dismiss", "reason?" }
GET/PUT /platform/settings
GET/PATCH /platform/feature-flags/{key}
GET /platform/integrations       # shows Telebirr status
GET /platform/audit-logs
```

Refund: `POST /payments/{transactionId}/refund` `{ "reason" }` (super_admin).

---

## 8. Telebirr payment details (for backend awareness — clients do not implement)

| Field | Value source |
|---|---|
| Provider | Telebirr Fabric H5 C2B |
| Merchant App ID | server env `TELEBIRR_MERCHANT_APP_ID` |
| Fabric App ID | server env `TELEBIRR_FABRIC_APP_ID` |
| ShortCode | server env `TELEBIRR_SHORT_CODE` |
| Notify URL | `{BASE_URL}/v1/webhooks/telebirr` |
| Redirect URL | `{BASE_URL}/v1/payments/return` or app deep link via checkout `returnUrl` |

Client only needs: **`checkoutUrl`**, then **poll/sync**.

Mock mode (`paymentsMode: "mock"`): `checkoutUrl` opens `/payments/mock-checkout?tx_ref=…` which auto-succeeds.

---

## 9. Roles cheat sheet

| Role | Surface | Notes |
|---|---|---|
| `traveler` (aka visitor) | Customer | Default after Firebase signup |
| `guide` | Staff | Provisioned by place/platform admin |
| `gatekeeper` | Staff | Scoped to `attractionIds` |
| `place_admin` (aka attraction_admin) | Attraction Admin web | Exactly one site |
| `super_admin` | Platform Admin web | Global |

---

## 10. Seeded demo accounts (after `npm run seed`)

| Account | Email / Bearer | Password |
|---|---|---|
| Super Admin | `superadmin@viseth.et` | `VisethAdmin2026!` (or `SEED_ADMIN_PASSWORD`) |
| Place Admin (Harar) | `harar.admin@viseth.et` | same |
| Traveler (dev) | `Bearer dev:usr_seed_traveler` | — |
| Gatekeeper (dev) | `Bearer dev:gatekeeper` | — |
| Guide (dev) | `Bearer dev:guide` | — |

Demo attractions: `atr_adwa`, `atr_lalibela`, `atr_harar`, `atr_gondar`, `atr_aksum`, `atr_sofomar`.

---

## 11. Flutter integration checklist (Cursor prompt)

```
Integrate Viseth Custom API into this Flutter app using INTEGRATION_GUIDE.md:

1. Add dio/http client with baseUrl from VISETH_API_BASE
2. Attach Firebase ID token on every request; on 401 refresh once
3. Replace mock AppState ticket purchase with POST /payments/tickets/checkout
4. Open checkoutUrl in webview; on return call POST /payments/{id}/sync then GET /tickets/mine
5. Show qrPayload with qr_flutter; cache offline
6. Wire feed to GET /feed and posts to POST /posts
7. Wire passport to GET /passport/me
8. Never call Telebirr or Chapa from the app
```

## 12. Attraction Admin (React) Cursor prompt

```
Integrate Viseth Attraction Admin using INTEGRATION_GUIDE.md §6:
- Login via POST /admin/auth/login
- Store accessToken; refresh via /admin/auth/refresh
- Dashboard from /admin/attractions/{id}/summary
- Never send attractionId overrides; use JWT scope
- Create gatekeepers/guides only via API
```

## 13. Platform Admin Cursor prompt

```
Integrate Viseth Platform Admin using INTEGRATION_GUIDE.md §7:
- super_admin JWT login
- Overview, attractions CRUD, place-admin create, moderation, Telebirr-aware payments list
```

## 14. Staff App Cursor prompt

```
Integrate Viseth Staff App using INTEGRATION_GUIDE.md §5:
- Firebase auth → GET /staff/me
- Gatekeeper: POST /visits/verify with camera QR + manual keycode
- Guide: bookings inbox PATCH
```

---

## 15. Endpoint index (quick)

| Method | Path | Who |
|---|---|---|
| GET | `/health` `/config` | public |
| GET/PATCH | `/me` | app |
| GET | `/attractions` `/attractions/{id}` `/attractions/nearby` | app |
| POST | `/payments/tickets/checkout` `/payments/gifts/checkout` | traveler |
| GET | `/payments/{id}` | payer |
| POST | `/payments/{id}/sync` | payer |
| POST | `/webhooks/telebirr` | Telebirr |
| GET | `/tickets/mine` `/gifts/mine` `/passport/me` `/visits/me` | app |
| POST | `/visits/verify` `/scans/verify` | gatekeeper |
| GET | `/feed` | app |
| POST | `/posts` `/recaps` | traveler |
| POST | `/media/upload` `/ai/transcribe` `/ai/tts` | app |
| POST | `/admin/auth/login` | admin |
| * | `/admin/attractions/*` `/admin/gatekeepers` `/admin/guides` | place_admin |
| * | `/platform/*` | super_admin |
| GET | `/staff/me` `/staff/gate/today` `/staff/gate/expected` | staff |

---

## 16. What clients must NOT do

- Call Telebirr / Chapa / Whisperflow / ElevenLabs / Fal / Firecrawl with API keys  
- Invent ticket codes or QR payloads  
- Trust WebView “payment finished” without API sync  
- Create staff Auth users from the browser  
- Store Telebirr private key or Fabric secret in the client  

---

*End of Viseth Integration Guide — payments = Telebirr*
