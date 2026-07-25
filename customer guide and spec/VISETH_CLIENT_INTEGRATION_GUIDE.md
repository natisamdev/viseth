# Viseth Client Integration Guide

**Audience:** Flutter (Customer + Staff) and Web (Attraction Admin + Platform Admin) teams  
**Version:** 2.0  
**Date:** 2026-07-25  
**Companion:** `VISETH_BACKEND_TECHNICAL_SPEC.md` (backend build contract — source of truth for shapes)

This guide tells client teams **exactly how to call the API** after the backend is live: base URL, auth, request bodies, success responses, and error handling. **Do not call Chapa, Whisperflow, ElevenLabs, Fal, or Firecrawl directly from clients.**

---

## 1. Environments

| Env | Base URL |
|---|---|
| Staging | `https://api-staging.viseth.et/v1` |
| Production | `https://api.viseth.et/v1` |

All paths below are relative to that base.

| Client | Auth |
|---|---|
| Customer / Staff Flutter | Firebase Auth ID token |
| Attraction Admin / Platform Admin | API JWT from `/admin/auth/login` |

---

## 2. Shared client rules

### 2.1 Headers (every call)

```
Authorization: Bearer <token>
Content-Type: application/json
Accept: application/json
X-Client: customer | staff | attraction_admin | platform_admin
```

Money POSTs also require:

```
Idempotency-Key: <uuid-v4>
```

### 2.2 Flutter auth recipe

1. Sign in with Firebase Auth (phone OTP or preferred provider).  
2. `final token = await user.getIdToken();`  
3. Attach Bearer token on Custom API calls.  
4. On `401`: refresh ID token once; retry; then force re-login.  
5. Immediately after login: `GET /me` then `GET /config`.  
6. If login UI has “I’m outside Ethiopia”, call `PATCH /me` `{ "isDiaspora": true }` before navigating home.

### 2.3 Admin web auth recipe

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

Store tokens securely. Place admin returns `"role":"place_admin"` and a non-null `attractionId`. **Never send `attractionId` on `/place/*` routes** — server scopes from JWT.

- Refresh: `POST /admin/auth/refresh` `{ "refreshToken" }`  
- Logout: `POST /admin/auth/logout`  
- Change password: `POST /admin/auth/change-password` `{ "currentPassword", "newPassword" }`

### 2.4 Errors

```json
{
  "error": {
    "code": "ALREADY_USED",
    "message": "This ticket was already scanned.",
    "details": {}
  }
}
```

| HTTP | Client UX |
|---|---|
| 400 | Show field errors from `details` |
| 401 | Refresh / re-login |
| 403 | “Not allowed” |
| 404 | Empty state |
| 422 | Show `error.message` (especially scans) |
| 429 | Back off |
| 503 `MAINTENANCE` | Block Buy / Gift / Scan |
| 502 | “Try again shortly” (Chapa/AI) |

### 2.5 Pagination

`?page=1&pageSize=20` → `{ items, page, pageSize, total, totalPages }`

### 2.6 Feature flags

Read `GET /config` → `featureFlags`. Hide Gift if `diaspora_gifting=false`, hide AI voice if `ai_recaps=false`, etc.

### 2.7 Theme / language

Night Coffee theme toggle and Amharic UI strings are **client-local** (`shared_preferences`). No API for theme.

---

## 3. Customer app — call book by screen

Map to `customer_app` navigation: Splash → Login → AppShell (Feed / Explore / Passport / Profile).

### Screen — Splash
No API.

### Screen — Login
1. Firebase phone auth (or mock until wired).  
2. `GET /me`  
3. Optional `PATCH /me` `{ "isDiaspora": true }`  
4. `GET /config`  
5. Navigate to shell.

**`GET /me` → use:** `user.role`, `heritageScore`, `currentBadge`, `currentTitle`, `isDiaspora`, `hasCompletedFirstPurchase`.

---

### Screen — Feed (Home)

`GET /feed?tab=for_you` or `?tab=following&page=1&pageSize=10`

**Item fields for UI:** author (name, photo, title, streak badge), attractionName, region, body/caption, media[], likeCount, commentCount, shareCount, likedByMe, visitedOn, hasVoiceStory, isGiftedVisit.

| Action | Call |
|---|---|
| Like | `POST /recaps/{id}/like` |
| Unlike | `DELETE /recaps/{id}/like` |
| Follow author | `POST /users/{authorId}/follow` |
| Unfollow | `DELETE /users/{authorId}/follow` |
| Share | `POST /recaps/{id}/share` → use `shareUrl` for Telegram/WhatsApp/Copy |
| Comments list | `GET /recaps/{id}/comments` |
| Add comment | `POST /recaps/{id}/comments` `{ "body": "…" }` |
| Report | `POST /reports` (see below) |
| Empty following | If `items=[]` and tab=following → show empty state; switch to for_you locally |

Single-tap location → navigate Nearby (client). Double-tap gift affordance → Gift screen with attraction preselected (client).

---

### Screen — Explore

```
GET /attractions?active=true
GET /guides?active=true
GET /hotels
```

Optional filters: `region=`, `category=`, `q=`.

**Gift banner CTA:** navigate to Gift wizard (no API until pay).  
**Closest to you / pin:** navigate Nearby → Section below.

---

### Screen — Attraction detail

`GET /attractions/{id}`

Show: name, amharicName, region, category, ticketPrice, rating, openHours, tags, summary/description, **enrichedFacts[]**, map from lat/lng.

| CTA | Next |
|---|---|
| Save | `POST /attractions/{id}/save` / `DELETE …/save` |
| Buy ticket | Purchase screen |
| Gift | Gift wizard with `attractionId` |
| Related recaps | `GET /feed` filtered client-side or future `?attractionId=` if backend adds it |

---

### Screen — Ticket purchase

Customer UI may show telebirr / Chapa / CBE labels — **always call Chapa checkout**:

`POST /payments/tickets/checkout`  
Headers: `Idempotency-Key`

```json
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
  "transactionId": "txn_01",
  "reference": "CHP-8F2A41",
  "checkoutUrl": "https://checkout.chapa.co/…",
  "amount": 600.00,
  "fee": 12.00,
  "total": 612.00,
  "currency": "ETB",
  "kind": "ticket"
}
```

1. Open `checkoutUrl` (WebView / external browser).  
2. On return deep link, poll `GET /payments/{transactionId}` until `status` is `succeeded` or `failed` (every 2s, max ~60s).  
3. On succeeded: `GET /tickets/mine?status=valid` → open Ticket screen with that ticket.  
4. If `isFirstPurchaseCelebrationEligible: true`, play confetti ≤1s once, then `POST /me/celebrations/first-purchase`.

**Never** mark paid from client alone.

---

### Screen — Ticket / QR (+ tickets list)

`GET /tickets/mine`

Encode **`qrPayload` exactly** as QR contents (`qr_flutter` / `QrImageView`). Show status, guests, visitDate, attraction, giftedBy/giftKeycode if present.

Offline: cache last `qrPayload` locally after fetch for active tickets.

---

### Screen — My Passport

`GET /passport/me`

| Field | UI |
|---|---|
| heritageScore | Heritage ring 0–100 |
| streakMonths + badge | Streak badge / ladder |
| title | Honorific |
| visits[] | Verified stamps |
| regionsCovered | Region chips |
| sitesVisited | Stat |
| upcomingTickets | Ticket rows (or merge `GET /tickets/mine?status=valid`) |
| isFirstPurchaseCelebrationEligible | Rare edge if unpaid celebration pending |

Bottom Gift CTA → Gift wizard (no attraction required).

---

### Screens — Guides

`GET /guides` → list cards (name, region, languages, rating, toursCompleted, pricePerDayEtb).  
`GET /guides/{id}` → profile.

Book:

`POST /bookings`

```json
{
  "guideId": "usr_guide_01",
  "requestedDate": "2026-08-02",
  "note": "Family of four"
}
```

**201** → snackbar “Booking sent”.  
List mine: `GET /bookings/mine`.  
If payment required later: `POST /payments/bookings/checkout` `{ "bookingId" }` + same poll pattern.

---

### Screens — Hotels (Explore)

`GET /hotels` / `GET /hotels/{id}` / `GET /hotels/nearby?lat&lng`

Soft book:

`POST /hotel-bookings`

```json
{
  "hotelId": "htl_01",
  "checkIn": "2026-08-01",
  "checkOut": "2026-08-03",
  "rooms": 1,
  "guests": 2
}
```

`GET /hotel-bookings/mine` for profile “stays”.

---

### Screen — Nearby map

1. Read device location (client). Respect profile “live location” toggle (local).  
2. `GET /attractions/nearby?lat=9.03&lng=38.75&radiusKm=50`  
3. Optional: `GET /hotels/nearby?lat&lng`  
4. Sort already by `distanceKm` from API; pins open attraction/hotel detail.

---

### Screen — Create recap

1. `GET /passport/me` → pick a verified `visitId` / attraction.  
2. Optional voice: `POST /ai/transcribe` multipart field `audio` → fill caption with `text`.  
3. Optional media: `POST /media/upload` → collect URLs.  
4. Optional image gen: `POST /ai/image` `{ "prompt", "purpose": "recap" }`.  
5. `POST /recaps`

```json
{
  "attractionId": "atr_lalibela",
  "visitId": "vis_01",
  "body": "The rock churches feel eternal.",
  "media": [{ "url": "https://…", "kind": "image" }],
  "aiAssisted": true,
  "hasVoiceStory": true
}
```

Requires flag `ai_recaps` for AI steps.

---

### Screen — Post detail + read-aloud

`GET /recaps/{id}`

Read aloud: `POST /ai/tts` `{ "text": "<body>", "recapId": "pst_01" }` → play `audioUrl`.

---

### Screen — Send a Gift (3-step wizard)

Site → people → review → pay.

`POST /payments/gifts/checkout` + `Idempotency-Key`

```json
{
  "attractionId": "atr_harar",
  "recipientNames": ["Meron Abebe", "Sara Mulugeta", "Abel Getachew"],
  "greeting": "From your cousin in DC",
  "visitDate": "2026-08-02T09:00:00Z",
  "returnUrl": "viseth://payments/return"
}
```

Same Chapa open + poll as tickets. On success: `GET /gifts/mine` → navigate **Gift success** with `keycode`, recipients, visitDate, attraction.

---

### Screen — Gift success

No extra API if you pass keycode from previous fetch. Offer clipboard copy of `keycode`. Optional re-fetch `GET /gifts/mine` to confirm `status: active`.

---

### Screen — Profile (me)

`GET /me`  
My recaps: filter feed/author or future `GET /users/{id}/recaps` — until then `GET /feed?tab=for_you` client-filter by authorId, or call `GET /recaps` if backend exposes author filter (`?authorId=` — ask backend to add if missing; **spec expects clients can use** `GET /users/{id}` + feed).  
Saved: `GET /me/saved-attractions`  
Bookings: `GET /bookings/mine`  
Settings sheet: theme + live location = **local only**.

---

### Screen — Other user profile

`GET /users/{id}`  
Follow/unfollow endpoints above. Message button = stub (no API).

---

### Screen — Notifications

`GET /notifications`  
`POST /notifications/read` `{ "all": true }` or `{ "ids": ["…"] }`

---

### Report content (any surface)

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

---

### Announcements

`GET /announcements` — banner/inbox.

---

## 4. Staff app — Guide mode

`X-Client: staff` · Firebase user with `role=guide` from `GET /me`.

| Action | Call |
|---|---|
| Edit profile | `PATCH /guides/me` `{ "bio", "languages", "specialties", "photoUrl?", "pricePerDayEtb?", "region?", "attractionIds?" }` |
| Inbox | `GET /guides/me/bookings` |
| Confirm | `PATCH /bookings/{id}` `{ "status": "confirmed" }` |
| Decline | `PATCH /bookings/{id}` `{ "status": "declined" }` |
| Complete | `PATCH /bookings/{id}` `{ "status": "completed" }` |

Optional avatar: `POST /ai/image` `{ "purpose": "avatar", "prompt": "…" }`.

---

## 5. Staff app — Gatekeeper mode (scan + confirmation)

`GET /me` → read `gatekeeperAttractionIds[0]` as assigned site (usually one).

### Scan screen

1. Capture QR/raw string (`mobile_scanner`).  
2. Debounce: **one** detect per code.  
3. `POST /scans/verify`

```json
{
  "code": "<raw QR payload or keycode>",
  "attractionId": "<assigned attraction id>"
}
```

4. Navigate to confirmation with response body in memory — do not re-scan.

### Confirmation screen

**Success (`valid: true`)**

```json
{
  "valid": true,
  "type": "gift_keycode",
  "names": ["Meron Abebe", "Sara Mulugeta", "Abel Getachew"],
  "guests": 3,
  "attractionName": "Harar Jugol",
  "senderName": "Yonas Alemu",
  "greeting": "From your cousin in DC",
  "visitIds": ["vis_02", "vis_03", "vis_04"]
}
```

UX:
- `solo_ticket` → one large name + green check (show guests as secondary if >1)  
- `gift_keycode` → **all** `names` + “Gift from {senderName}” + greeting  
- Immediate success haptic once (design system)

**Failure (HTTP 422 or `valid: false`)**

```json
{
  "valid": false,
  "names": [],
  "errorCode": "ALREADY_USED",
  "errorMessage": "This ticket was already scanned."
}
```

| errorCode | UX |
|---|---|
| `ALREADY_USED` | Already scanned |
| `EXPIRED` | Expired |
| `INVALID_CODE` | Unknown / bad signature |
| `WRONG_ATTRACTION` | Wrong site |
| `MAINTENANCE` | Gate paused |

Calm error + double haptic; “Scan next”.

---

## 6. Attraction Admin web

`X-Client: attraction_admin` · role must be `place_admin`.

### Login
`POST /admin/auth/login` → ensure `admin.role === "place_admin"`.

### Dashboard
`GET /place/dashboard`

```json
{
  "attraction": { "id": "atr_adwa", "name": "…" },
  "gross": 22200.00,
  "commission": 2664.00,
  "partnerShare": 19536.00,
  "visitsToday": 18,
  "validTickets": 42,
  "recentScans": [
    { "visitorName": "…", "scannedAt": "…", "type": "solo_ticket" }
  ]
}
```

### Lists
- `GET /place/visits?page=1&pageSize=20`  
- `GET /place/tickets?status=valid`  
- `GET /place/payouts`  
- `GET /place/revenue`  
- `GET /place/credentials` (prefix only)

### Gatekeepers
- `GET /place/gatekeepers`  
- `POST /place/gatekeepers` `{ "name", "email", "phone" }`  
- `PATCH /place/gatekeepers/{id}` `{ "active": false }`

### Site profile
- `GET /place/attraction`  
- `PATCH /place/attraction` `{ "description"?, "coverImageUrl"? }`  

**Cannot** change `ticketPrice`, `active`, lat/lng — Super Admin only. Hide those controls.

---

## 7. Platform Admin (Super Admin) web

`X-Client: platform_admin` · `role === "super_admin"`.

### Overview
`GET /platform/overview` → KPI cards, charts (`visitsByDay`, `revenueByAttraction`), attention queues.

### Attractions
| UI | Call |
|---|---|
| List | `GET /platform/attractions` |
| Create | `POST /platform/attractions` (full body — see backend spec §7.13) |
| Edit | `PATCH /platform/attractions/{id}` |
| Activate | `POST /platform/attractions/{id}/activate` `{ "active": false }` |
| Enrich (Firecrawl) | `POST /platform/attractions/{id}/enrich` → show returned `facts[]` |

Pin picker uses **Google Maps in the browser only**; send resulting `lat`/`lng` in create/edit.

### Place admins
| UI | Call |
|---|---|
| List | `GET /platform/place-admins` |
| Add | `POST /platform/place-admins` `{ name, email, phone, attractionId, temporaryPassword }` |
| Edit / toggle | `PATCH /platform/place-admins/{id}` |

### Guides approval
`GET /platform/guides`  
`PATCH /platform/guides/{id}` `{ "active": true, "verified": true }`

### Moderation (recaps)
`GET /platform/recaps?status=flagged`  
`POST /platform/recaps/{id}/keep`  
`POST /platform/recaps/{id}/remove` `{ "reason": "…" }` ← reason required

### Payments — revenue by site (live)
`GET /platform/revenue/by-attraction`  
Poll every 5s **or** SSE `GET /platform/revenue/stream`.  
Do not dump full ledger on this page.

Refunds: `POST /payments/{transactionId}/refund` `{ "reason" }`

### Transactions ledger
`GET /platform/transactions`  
Export: `GET /platform/exports/payments.csv`

### Payouts
`GET /platform/payouts`  
`POST /platform/payouts/{id}/hold` `{ "reason" }`  
`POST /platform/payouts/{id}/release`  
`POST /platform/payouts/{id}/mark-paid`

### Support
`GET /platform/support-cases?status=`  
`POST /platform/support-cases/{id}/status` `{ "status": "resolved", "resolution": "…" }`

### Social reports
`GET /platform/social-reports?status=open&category=violence&page=1&pageSize=5`

```json
POST /platform/social-reports/{id}/resolve
{
  "status": "actioned",
  "resolutionNote": "Comment removed; user warned.",
  "suspendUser": false
}
```

Export: `GET /platform/exports/social-reports.csv`

### Gamification
`GET /platform/gamification`  
`PUT /platform/gamification/streak-tiers` ← full array  
`PUT /platform/gamification/follower-titles` ← full array  

### Integrations health
`GET /platform/integrations`  
`POST /platform/integrations/{id}/recheck`  
Expect rows for: Chapa, Firebase, Firecrawl, Whisperflow, ElevenLabs, Fal.

### Security — API credentials
`POST /platform/api-credentials`

```json
{
  "name": "Adwa place console",
  "scope": "place_admin",
  "attractionId": "atr_adwa"
}
```

**201 includes `secret` once** — modal copy; never re-fetchable.  
Rotate / revoke: `POST …/rotate`, `POST …/revoke`.

### Settings
`GET /platform/settings`  
`PUT /platform/settings` `{ "commissionRate", "payoutDay", "supportEmail", "maintenanceMode", "giftKeycodeExpiryHours"? }`  
`PATCH /platform/feature-flags/{key}` `{ "enabled", "rollout" }`  
Keys: `diaspora_gifting`, `ai_recaps`, `guide_booking`, `streak_badges`, `discovery_feed`, `live_streaming`, `hotels`  
`POST /platform/announcements` `{ "title", "body", "audience" }`

### Account
`GET /admin/me` · `PATCH /admin/me` · change-password

### Audit
`GET /platform/audit-log?category=money`  
`GET /platform/exports/audit.csv`  
Also: `GET /platform/exports/sites.csv`

---

## 8. Payment polling helper (Customer)

```
checkout → open checkoutUrl
loop every 2s:
  GET /payments/{transactionId}
  if succeeded → fetch ticket/gift → success UI
  if failed → error UI
  if pending → continue until timeout (~60s) → “Payment still processing” + pull-to-refresh on tickets/gifts
```

Always send a new `Idempotency-Key` per user intent; reuse the **same** key only when retrying the identical checkout after a network drop.

---

## 9. Maintenance mode

If pay or scan returns `503` / `MAINTENANCE`:

- Customer: disable Buy / Gift; show `supportEmail` from last `GET /config`.  
- Gatekeeper: “Gate scanning paused by platform” — do not hammer retries.

---

## 10. What clients must NEVER do

1. Bundle vendor API keys for Chapa / Whisperflow / ElevenLabs / Fal / Firecrawl.  
2. Invent QR payloads or gift keycodes.  
3. Trust WebView “success” without `GET /payments/{id}` → `succeeded` and a `valid` ticket / `active` gift.  
4. Send foreign `attractionId` on place-admin routes.  
5. Persist API credential plaintext after the one-time modal.  
6. Write visits/tickets directly to Firestore from the client if API is the source of truth.

---

## 11. Wiring map for existing `customer_app` (replace AppState mocks)

| AppState / screen API | Replace with |
|---|---|
| `Seed.attractions` | `GET /attractions` |
| `purchaseTicket` | checkout + poll + `GET /tickets/mine` |
| `Ticket.code` QR | `ticket.qrPayload` |
| `sendGift` | gifts checkout + `GET /gifts/mine` |
| `visits` / heritage / streak | `GET /passport/me` |
| `posts` / like / share / comment | `/feed`, `/recaps/…` |
| `toggleFollow` | `/users/{id}/follow` |
| `toggleSave` | `/attractions/{id}/save` |
| `Seed.guides` / hotels | `GET /guides`, `GET /hotels` |
| Nearby sort | `GET /attractions/nearby` |
| Theme | keep local |

Suggested client folder: `lib/data/api/` with `VisethApiClient` + DTO mappers into existing model classes.

---

## 12. Minimal QA scripts

### A. Ticket demo
1. Traveler login → Explore → checkout ticket (guests≥1) → Chapa sandbox.  
2. Poll payment → `GET /tickets/mine` → show QR.  
3. Gatekeeper `POST /scans/verify` → one name.  
4. `GET /passport/me` → visit + score update.

### B. Diaspora gift demo
1. Gift checkout with 3 names → pay.  
2. `GET /gifts/mine` → keycode on success screen.  
3. Gatekeeper scans keycode → **three names** + sender + greeting.

### C. AI recap demo
1. `POST /ai/transcribe` → text.  
2. `POST /recaps`.  
3. `POST /ai/tts` → play audio.

### D. Admin revenue
1. Super Admin login.  
2. `GET /platform/revenue/by-attraction` moves after sandbox payments.  
3. Place Admin `GET /place/dashboard` shows only own site.

### E. Firecrawl
1. Super Admin enrich attraction.  
2. Customer `GET /attractions/{id}` shows `enrichedFacts`.

---

## 13. Ownership when integrating

| Issue | Owner |
|---|---|
| 401 / token shape | Backend |
| Scan contract / error codes | Backend + Gatekeeper UI |
| Checkout redirect / deep links | Backend + Mobile Lead |
| Admin JWT + CORS | Backend + Web |
| Empty Firecrawl facts | AI/Content + Backend |
| Feed empty / flags | Backend flags + Mobile |

When response shapes change, update **this file** and bump the version header together with the backend spec.

---

*End of Client Integration Guide v2.0*
