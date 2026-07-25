# Viseth Client Integration Guide

**Audience:** Flutter (Customer + Staff) and Web (Attraction Admin + Platform Admin) teams  
**Version:** 1.0  
**Date:** 2026-07-25  
**Companion doc:** `VISETH_BACKEND_TECHNICAL_SPEC.md` (backend build contract)

This guide tells client teams **exactly how to call the API** after the backend is live: base URL, auth headers, request bodies, success responses, and error handling. Do not call AI vendors or Chapa directly from clients.

---

## 1. Environments

| Env | Base URL |
|---|---|
| Staging | `https://api-staging.viseth.et/v1` |
| Production | `https://api.viseth.et/v1` |

All paths below are relative to that base.

Firebase remains the identity provider for **mobile** users. Admin webs use API email/password tokens.

---

## 2. Auth recipes

### 2.1 Flutter (traveler / guide / gatekeeper)

1. Sign in with Firebase Auth.
2. Get ID token: `await user.getIdToken()`.
3. Send on every API call:

```
Authorization: Bearer <firebase_id_token>
Content-Type: application/json
X-Client: customer   # or staff
```

4. Refresh token on `401`; retry once; then force re-login.

### 2.2 Attraction Admin & Platform Admin (web)

**Login**

`POST /admin/auth/login`

```json
{ "email": "superadmin@viseth.et", "password": "••••••••" }
```

**200**

```json
{
  "accessToken": "eyJ…",
  "refreshToken": "eyJ…",
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

Store tokens securely (httpOnly cookie or secure storage). Attach:

```
Authorization: Bearer <accessToken>
X-Client: platform_admin   # or attraction_admin
```

**Refresh:** `POST /admin/auth/refresh` `{ "refreshToken": "…" }`  
**Logout:** `POST /admin/auth/logout`  
**Change password:** `POST /admin/auth/change-password` `{ "currentPassword", "newPassword" }`

Place admin login returns `"role":"place_admin"` and a non-null `attractionId`. Never send `attractionId` on place routes — the server scopes it from the token.

---

## 3. Errors (all clients)

```json
{
  "error": {
    "code": "ALREADY_USED",
    "message": "This ticket was already scanned.",
    "details": {}
  }
}
```

| HTTP | Meaning | Client UX |
|---|---|---|
| 400 | Bad input | Show field errors from `details` if present |
| 401 | Auth expired | Refresh / re-login |
| 403 | Wrong role / wrong site | “Not allowed” |
| 404 | Missing | Empty state |
| 422 | Business rule | Show `error.message` (scan failures, etc.) |
| 429 | Rate limit | Back off |
| 503 | Maintenance | Block pay/scan with maintenance copy |
| 502 | Upstream (Chapa/AI) | Retry or “try again shortly” |

---

## 4. Customer app — call book by screen

### Screen 1 — Login / role
- Firebase Auth only for session.
- Then `GET /me` to load role, badge, title, heritageScore.

### Screen 2 — Home / browse
`GET /attractions?active=true`

Optional: `?region=Amhara&q=adwa`

Use `items[]` for cards: `name`, `region`, `ticketPrice`, `coverImageUrl`.

### Screen 3 — Attraction detail
`GET /attractions/{id}`

Show `description`, `enrichedFacts[]`, map from `lat`/`lng`, CTA “Buy ticket” → Screen 4.

### Screen 4 — Ticket purchase
`POST /payments/tickets/checkout`

```json
{
  "attractionId": "atr_adwa",
  "holderName": "Selam Tesfaye"
}
```

**201**

```json
{
  "transactionId": "txn_01",
  "reference": "CHP-8F2A41",
  "checkoutUrl": "https://checkout.chapa.co/…",
  "amount": 300.00,
  "currency": "ETB"
}
```

Open `checkoutUrl` (WebView / browser). Do **not** mark the ticket paid on client success alone — wait for:

- return deep link + `GET /tickets/mine` showing a new `valid` ticket, or  
- poll `GET /payments/{transactionId}` if backend exposes it (optional).

On first-ever succeeded purchase, if passport payload says `isFirstPurchaseCelebrationEligible: true`, play confetti ≤1s once.

### Screen 5 — Ticket / QR
`GET /tickets/mine`

```json
{
  "items": [
    {
      "id": "tkt_01",
      "status": "valid",
      "holderName": "Selam Tesfaye",
      "qrPayload": "vise1.eyJ…sig",
      "attraction": { "id": "atr_adwa", "name": "Adwa Victory Memorial Museum" },
      "purchasedAt": "2026-07-25T10:00:00Z"
    }
  ]
}
```

Encode **`qrPayload` exactly** as the QR contents (do not invent your own QR string).

### Screen 6 — My Passport
`GET /passport/me`

Use:
- `heritageScore` → ring 0–100  
- `streakMonths` + `badge` → streak badge  
- `title` → honorific next to name  
- `visits[]` → timeline  
- `sitesVisited`, `regionsCovered` → stats  

### Screens 7–8 — Guides
`GET /guides`  
`GET /guides/{id}`

Book:

`POST /bookings`

```json
{
  "guideId": "usr_guide_01",
  "requestedDate": "2026-08-02",
  "note": "Family of four"
}
```

**201** → snackbar “Booking sent”. Payment (if required) via `POST /payments/bookings/checkout` `{ "bookingId" }` when backend enables it.

### Screen 9 — Recap create
Text path: `POST /recaps` `{ "attractionId", "body", "imageUrl"? }`

Voice path (flag `ai_recaps`):
1. `POST /ai/transcribe` multipart field `audio`
2. Put returned `text` into the composer
3. `POST /recaps`

Optional image: `POST /ai/image` `{ "prompt", "purpose": "recap" }` → use `imageUrl`.

### Screen 10 — Post detail + read-aloud
`GET /recaps/{id}`

Read aloud: `POST /ai/tts` `{ "text": "<body>", "recapId": "pst_01" }` → play `audioUrl`.

### Screen 11 — Send a Gift
`POST /payments/gifts/checkout`

```json
{
  "attractionId": "atr_harar",
  "recipientNames": ["Meron Abebe", "Sara Mulugeta"],
  "greeting": "From your cousin in DC"
}
```

After pay settles: `GET /gifts/mine` → show `keycode` to share.

### Report content (any social surface)
`POST /reports`

```json
{
  "category": "violence",
  "contentType": "recap",
  "targetId": "pst_05",
  "postId": "pst_05",
  "notes": "Threatening language"
}
```

`category`: `violence` | `sexual_abuse` | `other`  
`contentType`: `recap` | `comment` | `profile` | `message`

### Follow
`POST /users/{id}/follow`  
`DELETE /users/{id}/follow`

### Announcements
`GET /announcements` — show matching items in inbox/banner.

### Feature flags
Read from `GET /me` extensions or a lightweight `GET /config` if provided. Until then, hardcode defaults matching Super Admin seeds; prefer server config when available.

---

## 5. Staff app — Guide calls

| Action | Call |
|---|---|
| Edit profile | `PATCH /guides/me` `{ "bio", "languages", "specialties", "photoUrl"? }` |
| Inbox | `GET /guides/me/bookings` |
| Confirm | `PATCH /bookings/{id}` `{ "status": "confirmed" }` |
| Decline | `PATCH /bookings/{id}` `{ "status": "declined" }` |
| Complete | `PATCH /bookings/{id}` `{ "status": "completed" }` |

---

## 6. Staff app — Gatekeeper calls (screens 12–13)

### Screen 12 — Scan
1. Capture QR/raw string with `mobile_scanner`.
2. Debounce: handle **one** detect per code.
3. Call:

`POST /scans/verify`

```json
{
  "code": "<raw QR or keycode>",
  "attractionId": "<gatekeeper assigned site>"
}
```

4. Navigate to confirmation with the JSON body (memory/provider) — do not re-scan.

### Screen 13 — Confirmation

**Success (`valid: true`)**

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

UX:
- `type: solo_ticket` → one large name + green check  
- `type: gift_keycode` → **all** `names` stacked + “Gift from {senderName}”  
- Immediate success haptic once  

**Failure (`valid: false` or HTTP 422)**

```json
{
  "valid": false,
  "names": [],
  "errorCode": "ALREADY_USED",
  "errorMessage": "This ticket was already scanned."
}
```

UX: calm error + `errorMessage`; double haptic; button “Scan next”.

| errorCode | Meaning |
|---|---|
| `ALREADY_USED` | Ticket/gift already redeemed |
| `EXPIRED` | Past expiry |
| `INVALID_CODE` | Unknown / bad signature |
| `WRONG_ATTRACTION` | Valid code, different site |
| `MAINTENANCE` | Platform maintenance |

---

## 7. Attraction Admin web

### Session
`POST /admin/auth/login` → role must be `place_admin`.

### Dashboard
`GET /place/dashboard`

Expected fields:
```json
{
  "attraction": { "id": "atr_adwa", "name": "…" },
  "gross": 22200.00,
  "commission": 2664.00,
  "visitsToday": 18,
  "validTickets": 42,
  "recentScans": [ { "visitorName": "…", "scannedAt": "…" } ]
}
```

### Lists
- `GET /place/visits?page=1&pageSize=20`
- `GET /place/tickets?status=valid`
- `GET /place/payouts`
- `GET /place/revenue`

### Gatekeepers
- `GET /place/gatekeepers`
- `POST /place/gatekeepers` `{ "name", "email", "phone" }`
- `PATCH /place/gatekeepers/{id}` `{ "active": false }`

### Site profile
- `GET /place/attraction`
- `PATCH /place/attraction` `{ "description"?, "coverImageUrl"? }`  
  (Cannot change `ticketPrice` / `active` / map pin — Super Admin owns those.)

---

## 8. Platform Admin (Super Admin) web

Map each existing console page to these calls.

### Overview
`GET /platform/overview` → stats cards, charts, attention queues.

### Attractions
| UI action | Call |
|---|---|
| List | `GET /platform/attractions` |
| Create | `POST /platform/attractions` `{ name, address, region, description, lat, lng, ticketPrice }` |
| Edit | `PATCH /platform/attractions/{id}` |
| Activate/deactivate | `POST /platform/attractions/{id}/activate` `{ "active": false }` |
| Enrich (Firecrawl) | `POST /platform/attractions/{id}/enrich` |

### Place admins
| UI | Call |
|---|---|
| List | `GET /platform/place-admins` |
| Add | `POST /platform/place-admins` `{ name, email, phone, attractionId, temporaryPassword }` |
| Edit / toggle | `PATCH /platform/place-admins/{id}` |

### Moderation
`GET /platform/recaps?status=flagged`  
`POST /platform/recaps/{id}/keep`  
`POST /platform/recaps/{id}/remove` `{ "reason": "…" }`  ← reason required

### Payments (revenue by site — live)
`GET /platform/revenue/by-attraction`

Poll every 5s **or** subscribe `GET /platform/revenue/stream` (SSE) if enabled.

Do **not** list every transaction on this page — only per-attraction totals.

### Support
`GET /platform/support-cases?status=`  
`POST /platform/support-cases/{id}/status` `{ "status": "resolved", "resolution": "…" }`

### Reports — Social
`GET /platform/social-reports?status=open&category=violence&page=1&pageSize=5`

Resolve:
`POST /platform/social-reports/{id}/resolve`

```json
{ "status": "actioned", "resolutionNote": "Comment removed; user warned." }
```

Export: `GET /platform/exports/social-reports.csv`

### Reports — Sites / Payments / Overview exports
- `GET /platform/exports/sites.csv`
- `GET /platform/exports/payments.csv`

### Gamification
`GET /platform/gamification`  
`PUT /platform/gamification/streak-tiers` ← full array  
`PUT /platform/gamification/follower-titles` ← full array  

### Integrations
`GET /platform/integrations`  
`POST /platform/integrations/{id}/recheck`

### Security (API keys)
`POST /platform/api-credentials`

```json
{ "name": "Adwa place console", "scope": "place_admin", "attractionId": "atr_adwa" }
```

**201** includes `secret` **once** — show modal, never re-fetchable.

`POST /platform/api-credentials/{id}/rotate` → new secret once  
`POST /platform/api-credentials/{id}/revoke`

### Settings
`GET /platform/settings`  
`PUT /platform/settings` `{ "commissionRate", "payoutDay", "supportEmail", "maintenanceMode" }`  
`PATCH /platform/feature-flags/{key}` `{ "enabled", "rollout" }`  
`POST /platform/announcements` `{ "title", "body", "audience" }`

### Account
`GET /admin/me`  
`PATCH /admin/me`  
`POST /admin/auth/change-password`

### Audit
`GET /platform/audit-log?category=money`  
`GET /platform/exports/audit.csv`

---

## 9. Idempotency (money)

For checkout endpoints send:

```
Idempotency-Key: <uuid-v4>
```

Retrying the same key returns the same checkout session — safe for flaky mobile networks.

---

## 10. Pagination convention

List endpoints accept:

```
?page=1&pageSize=20
```

Response:

```json
{
  "items": [],
  "page": 1,
  "pageSize": 20,
  "total": 128,
  "totalPages": 7
}
```

Social reports in Super Admin use `pageSize=5` to match the current UI.

---

## 11. Maintenance mode

If any pay or scan call returns `503` with `MAINTENANCE`:

- Customer: disable Buy / Gift CTAs; show support email from last known settings if cached.
- Gatekeeper: show “Gate scanning paused by platform” — do not keep retrying rapidly.

---

## 12. What clients must NEVER do

1. Call Chapa, Whisperflow, ElevenLabs, Fal, or Firecrawl with vendor API keys from the app/web bundle.  
2. Invent QR payloads or gift keycodes.  
3. Trust client-side “payment success” without server ticket/gift appearing as paid/valid.  
4. Let Place Admin tokens access another attraction’s data (server enforces; still don’t send foreign IDs).  
5. Store API credential plaintext after the one-time issue/rotate modal is dismissed.

---

## 13. Minimal happy-path scripts (for QA)

### A. Ticket demo
1. Traveler login → browse → checkout ticket → Chapa sandbox pay.  
2. `GET /tickets/mine` → show QR.  
3. Gatekeeper `POST /scans/verify` → confirmation with one name.  
4. Traveler `GET /passport/me` → visit appears; score updates.

### B. Diaspora gift demo
1. Traveler gift checkout with 3 names.  
2. Pay → `GET /gifts/mine` → keycode.  
3. Gatekeeper scans keycode → **three names** + sender.  

### C. AI recap demo
1. `POST /ai/transcribe` → text.  
2. `POST /recaps`.  
3. `POST /ai/tts` → play audio.

### D. Super Admin revenue
1. Login admin.  
2. `GET /platform/revenue/by-attraction` → totals move after sandbox payments.

---

## 14. Contact points while integrating

| Issue | Owner |
|---|---|
| 401/token shape | Backend |
| Scan contract / error codes | Backend + Gatekeeper UI |
| Checkout redirect / deep links | Backend + Mobile Lead |
| Admin JWT + CORS | Backend + Web |
| Firecrawl facts empty | AI/Content + Backend |

When response shapes change, update **this file** and bump the version header.

---

*End of Client Integration Guide v1.0*
