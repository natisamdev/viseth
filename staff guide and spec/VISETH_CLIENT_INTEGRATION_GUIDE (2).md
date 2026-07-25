# Viseth Client Integration Guide

**Version:** 1.0.0  
**Audience:** Customer app, Staff app, Attraction Admin web, Platform Admin web  
**Prerequisite:** Backend implements [`VISETH_BACKEND_TECHNICAL_SPEC.md`](./VISETH_BACKEND_TECHNICAL_SPEC.md)  
**Date:** 2026-07-25  

This guide tells each client team exactly how to call the Viseth API: URLs, headers, request bodies, success responses, and errors. It does not redefine server business rules — those live in the backend spec.

---

## 1. Environments

| Env | Base URL |
|---|---|
| Staging | `https://api-staging.viseth.et/v1` |
| Production | `https://api.viseth.et/v1` |
| Local (typical) | `http://localhost:8000/v1` |

WebSocket:

| Env | URL |
|---|---|
| Staging | `wss://api-staging.viseth.et/v1/ws/chat?token=<access_token>` |
| Production | `wss://api.viseth.et/v1/ws/chat?token=<access_token>` |

Configure via:

- Flutter: `--dart-define=VISETH_API_BASE=...`
- Web: `VITE_VISETH_API_BASE=...`

---

## 2. Conventions every client must follow

### 2.1 Headers

```http
Authorization: Bearer <access_token>
Content-Type: application/json
Accept: application/json
Accept-Language: en
X-Request-Id: <uuid>   # recommended
```

Omit `Authorization` only on public auth/catalog routes noted below.

### 2.2 Response envelope

Every JSON response:

```json
{
  "ok": true,
  "data": {},
  "meta": { "request_id": "…", "page": 1, "page_size": 20, "total": 100 }
}
```

Errors:

```json
{
  "ok": false,
  "error": {
    "code": "FORBIDDEN_ROLE",
    "message": "Gatekeeper role required",
    "details": {}
  }
}
```

**Client rule:** branch on `ok` and `error.code`, not only HTTP status.

### 2.3 Token lifecycle

1. After OTP/Google → store `access_token` (memory/secure storage) + `refresh_token` (secure storage).  
2. On any `401` with code `TOKEN_EXPIRED` → `POST /auth/refresh` once, retry original request.  
3. If refresh fails → clear session → navigate to Login.  
4. Access TTL ≈ 15 minutes; do not decode JWT for role UI — use `user.role` from login/`GET /me`.

### 2.4 Money & time

- Display fields often return whole birr as `*_etb` integers (e.g. `150`).  
- Prefer server-provided display fields; do not invent FX.  
- All timestamps UTC ISO-8601; format locally in the app.

### 2.5 QR contract (Customer ↔ Staff)

Customer ticket screen must render QR encoding exactly:

```text
VISETH:TKT:<CODE>:<SITE_ID>
```

Example: `VISETH:TKT:ADW-8471-QK:adwa`

Staff scanner sends that full string (or bare `ADW-8471-QK`) to `POST /gate/verify`.

---

## 3. Shared TypeScript / Dart shapes

Use these field names in all clients (snake_case JSON).

### User
```json
{
  "id": "uuid",
  "display_name": "Yonas Kebede",
  "email": "yonas.kebede@viseth.et",
  "phone": "+2519…",
  "role": "gatekeeper",
  "country_code": "ET",
  "avatar_url": null,
  "locale": "en",
  "amharic_first": false,
  "telebirr_msisdn": null,
  "staff": {
    "staff_code": "ADW-GK-014",
    "home_site_id": "adwa",
    "site_name": "Adwa Victory Memorial",
    "site_amharic": "የአድዋ ድል መታሰቢያ",
    "title": "Gate Lead",
    "title_amharic": "የበር ኃላፊ"
  }
}
```
`staff` is `null` for customers and platform admins without a staff profile.

### Ticket
```json
{
  "id": "uuid",
  "code": "ADW-8471-QK",
  "qr_payload": "VISETH:TKT:ADW-8471-QK:adwa",
  "holder_name": "Selam Alemu",
  "holder_phone": "+251914472210",
  "site_id": "adwa",
  "site_name": "Adwa Victory Memorial",
  "tier": "adult",
  "party_size": 2,
  "valid_on": "2026-07-25",
  "purchased_at": "2026-07-24T10:00:00Z",
  "price_etb": 300,
  "status": "valid",
  "used_at": null,
  "used_gate": null,
  "gifted_by": null,
  "gifted_from": null,
  "is_gift": false
}
```

### ScanResult (Staff)
```json
{
  "outcome": "valid",
  "scanned_at": "2026-07-25T08:12:00Z",
  "raw_payload": "VISETH:TKT:ADW-8471-QK:adwa",
  "hint": null,
  "risk_level": "none",
  "flags": [],
  "ticket": { "...Ticket..." }
}
```
`outcome`: `valid|already_used|expired|not_yet_valid|wrong_site|invalid`

---

## 4. Auth (all surfaces)

### Register (Customer only)
```http
POST /auth/register
```
```json
{
  "display_name": "Selam Alemu",
  "email": "selam@example.com",
  "phone": "+251914472210",
  "password": "secret12",
  "country_code": "ET"
}
```
**Expect 201:** `{ "user": User, "otp_required": true, "challenge_id": "…" }`  
→ navigate to OTP screen.

### Login (all)
```http
POST /auth/login
```
```json
{ "email": "yonas.kebede@viseth.et", "password": "••••" }
```
**Expect 200:** `{ "challenge_id": "…", "otp_required": true, "role": "gatekeeper" }`  

Staff app: if `403 STAFF_NOT_PROVISIONED`, show “Ask your site admin to invite this email.”

### Verify OTP
```http
POST /auth/otp/verify
```
```json
{ "challenge_id": "…", "code": "123456" }
```
**Expect 200:**
```json
{
  "access_token": "eyJ…",
  "refresh_token": "…",
  "expires_in": 900,
  "user": { "...User..." }
}
```

**Staff routing:**  
- `user.role === "gatekeeper"` → `/gate/home`  
- `user.role === "guide"` → `/guide/home`  

**Admin web routing:**  
- `attraction_admin` → Attraction dashboard  
- `platform_admin` → Platform dashboard  

### Google
```http
POST /auth/google
{ "id_token": "<google-id-token>" }
```
Same token response as OTP verify (or OTP challenge if policy requires).

### Refresh / Logout
```http
POST /auth/refresh
{ "refresh_token": "…" }

POST /auth/logout
Authorization: Bearer …
```

### Current user
```http
GET /me
→ { "...User..." }

PATCH /me
{ "display_name": "…", "telebirr_msisdn": "+2519…" }

PATCH /me/preferences
{ "locale": "am", "amharic_first": true, "theme": "dark", "push_enabled": true }
```

---

## 5. Customer app integration map

| Screen | Call | Notes |
|---|---|---|
| Home | `GET /me/passport/summary` + `GET /sites?featured=true` + `GET /tickets?status=valid` | Show score ring from `heritage_score` |
| Explore | `GET /sites?q=&region=&category=` | Public OK without token |
| Site detail | `GET /sites/{id}` | Products for purchase sheet |
| Buy / Gift ticket | `POST /checkout/tickets` | Open `checkout_url` (Chapa); on return `GET /payments/{id}` |
| My tickets | `GET /tickets` | QR from `qr_payload` |
| Claim gift | `POST /tickets/{id}/claim` | After SMS OTP if required by API |
| Passport | `GET /me/passport` | Stamps list |
| Share | `POST /visits/{id}/share` | `{ "caption", "visibility":"public", "generate_image": true }` |
| Feed | `GET /feed` | Like/follow as below |
| Book guide | `GET /sites/{id}/guides` → `GET /guides/{id}` → `POST /bookings` | |
| My bookings | `GET /bookings` | |
| Chat | `GET /chats`, `GET /chats/{id}`, `POST …/messages` + WS | |
| Voice assistant | `POST /ai/transcribe` then `POST /ai/assistant` | Mic → STT → answer (+ audio) |
| Notifications | `GET /notifications` | Register device via `POST /me/devices` |

### 5.1 Checkout flow (Chapa)

```http
POST /checkout/tickets
Authorization: Bearer <customer>
```
```json
{
  "site_id": "adwa",
  "product_id": "uuid-or-omit-if-using-tier",
  "tier": "diaspora",
  "party_size": 4,
  "valid_on": "2026-07-26",
  "holder_name": "Tigist Bekele",
  "holder_phone": "+251911000000",
  "gift": {
    "enabled": true,
    "recipient_name": "Tigist Bekele",
    "recipient_phone": "+251911000000",
    "gifted_by_name": "Dawit Bekele",
    "gifted_from_place": "Washington, DC"
  },
  "return_url": "viseth://payments/return"
}
```

**Expect 200:**
```json
{
  "payment_id": "uuid",
  "ticket_id": "uuid",
  "amount_etb": 600,
  "checkout_url": "https://checkout.chapa.co/…",
  "tx_ref": "uuid"
}
```

Client steps:
1. Open `checkout_url` (in-app browser / external).  
2. On `return_url`, call `GET /payments/{payment_id}`.  
3. If `status === "success"`, navigate to ticket detail (`ticket` embedded).  
4. If still `pending`, poll every 2s up to 60s.  
5. On `failed`, show error and allow retry (new checkout).

**Do not** put Chapa secret keys in the mobile app.

### 5.2 Passport summary
```http
GET /me/passport/summary
```
```json
{
  "heritage_score": 72,
  "streak_days": 3,
  "titles": ["Adwa Witness"],
  "unique_sites": 9,
  "total_visits": 14,
  "next_title": { "name": "Heritage Keeper", "required_score": 60, "unlocked": true }
}
```

### 5.3 Share a verified visit
```http
POST /visits/{visit_id}/share
{
  "caption": "Really stood here.",
  "visibility": "public",
  "generate_image": true
}
```
**Expect:** `{ "post": { "id", "image_url", "caption", "visibility", "created_at" } }`  
`image_url` may take a few seconds (Fal). Show placeholder until present; or await full response (server blocks until ready, timeout ~30s).

### 5.4 Feed / social
```http
GET /feed?page=1
POST /share/{post_id}/like
POST /users/{user_id}/follow
DELETE /users/{user_id}/follow
```

### 5.5 Book a guide
```http
POST /bookings
{
  "guide_id": "uuid",
  "site_id": "adwa",
  "starts_at": "2026-07-26T12:30:00Z",
  "duration_hours": 2,
  "party_size": 3,
  "language": "english",
  "note": "Wheelchair access?",
  "is_diaspora_gift": false
}
```
**Expect 201:** Booking with `status: "pending"`.  
Errors: `GUIDE_NOT_ACCEPTING` (409).

### 5.6 Customer AI
```http
POST /ai/transcribe
Content-Type: multipart/form-data
audio=@capture.m4a
```
```json
{ "text": "Tell me a story about Adwa", "language": "en", "confidence": 0.9 }
```

```http
POST /ai/assistant
{
  "session_id": null,
  "query": "Tell me a story about Adwa",
  "spoken": true,
  "skill_hint": "story"
}
```
```json
{
  "session_id": "uuid",
  "message": {
    "id": "uuid",
    "author": "assistant",
    "text": "…",
    "skill": "story",
    "sources": ["Site enrichment"],
    "audio_url": "https://…/narration.mp3",
    "spoken": true
  }
}
```
Play `audio_url` when non-null (ElevenLabs). Reuse `session_id` for follow-ups.

---

## 6. Staff app — Gatekeeper

Swap `MockGateRepository` for HTTP implementing the same methods.

| UI action | HTTP |
|---|---|
| Load dashboard | `GET /gate/stats` + `GET /gate/visitors` |
| Filter visitors | `GET /gate/visitors?filter=verified\|rejected\|gifts\|all` |
| Scan / manual | `POST /gate/verify` |
| Shift summary | `GET /gate/shift-summary` |
| Handover note | `POST /gate/shift-notes` `{ "note": "…" }` |
| Profile / ratings | `GET /staff/me` + `GET /staff/me/performance` |
| Assistant | `/ai/transcribe` + `/ai/assistant` |

### 6.1 Verify (critical path)
```http
POST /gate/verify
Authorization: Bearer <gatekeeper>
```
```json
{
  "payload": "VISETH:TKT:ADW-8471-QK:adwa",
  "gate": "Gate 2"
}
```

**Always expect HTTP 200** for scan outcomes (including invalid tickets):

```json
{
  "outcome": "already_used",
  "scanned_at": "…",
  "raw_payload": "…",
  "hint": "Checked in at 08:12 on Gate 1.",
  "risk_level": "high",
  "flags": [
    {
      "level": "high",
      "title": "Duplicate check-in attempt",
      "detail": "This code was already verified…"
    }
  ],
  "ticket": { "...or null..." }
}
```

UI mapping (already in Staff app):
- `valid` → green success; if `ticket.is_gift` show welcome card using `hint`  
- `already_used` / high flags → risk banner  
- `wrong_site` / `expired` / `not_yet_valid` / `invalid` → corresponding sheets  

### 6.2 Stats
```http
GET /gate/stats
```
```json
{
  "verified": 342,
  "rejected": 18,
  "headcount": 510,
  "capacity": 800,
  "expected": 480,
  "gifts_welcomed": 6,
  "accept_rate": 0.95,
  "integrity_rate": 0.97
}
```
Bind headcount ring to `headcount / capacity`.

---

## 7. Staff app — Tour Guide

| UI action | HTTP |
|---|---|
| Home | `GET /guide/dashboard` |
| Requests list | `GET /guide/requests` |
| Accept / decline | `POST /guide/requests/{id}/accept` · `…/decline` |
| Schedule | `GET /guide/tours` |
| Tour detail | `GET /guide/tours/{id}` |
| Start / check-in | `POST /guide/tours/{id}/check-in` `{ "payload": "VISETH:TKT:…" }` |
| Toggle stop | `PATCH /guide/tours/{id}/stops/{stopId}` `{ "done": true }` |
| Complete tour | `POST /guide/tours/{id}/complete` |
| Chats | `/chats/*` + translate endpoint |
| Earnings | `GET /guide/earnings` |
| Withdraw | `POST /guide/payouts/withdraw` `{ "amount_etb": 4800 }` |
| Profile toggle | `PATCH /guide/profile` `{ "accepting_bookings": false }` |

### 7.1 Accept request
```http
POST /guide/requests/req-401/accept
```
**Expect 200:** `{ "booking": { "status": "accepted", … }, "tour": { "id": "…", "state": "upcoming", … } }`  
Refresh schedule + clear badge via `GET /guide/dashboard`.

### 7.2 Complete tour
```http
POST /guide/tours/{id}/complete
```
```json
{
  "tour": { "state": "completed", "completed_at": "…" },
  "payout_queued_etb": 2400,
  "stamp": {
    "visit_id": "uuid",
    "site_id": "adwa",
    "stamped_at": "…"
  }
}
```
Show PassportStamp UI + “Payout queued via telebirr”.

### 7.3 Earnings + withdraw
```http
GET /guide/earnings
```
```json
{
  "available_etb": 4800,
  "pending_etb": 1600,
  "this_month_etb": 18200,
  "last_month_etb": 15400,
  "lifetime_etb": 128400,
  "tours_this_month": 11,
  "weekly": [
    { "label": "Mon", "amount_etb": 2400, "tours": 1 }
  ],
  "payouts": [
    {
      "id": "…",
      "amount_etb": 4800,
      "at": "…",
      "status": "paid",
      "reference": "TB-90821",
      "method": "telebirr",
      "tour_count": 3
    }
  ]
}
```

```http
POST /guide/payouts/withdraw
{ "amount_etb": 4800 }
```
**Expect:** `{ "payout": { "status": "processing", … } }`  
Errors: `INSUFFICIENT_BALANCE`, or 400 if `telebirr_msisdn` missing → send user to profile to add number (`PATCH /me`).

### 7.4 Translate a chat message
```http
POST /chats/{threadId}/messages/{messageId}/translate
{ "target_language": "am" }
```
**Expect:** `{ "translation": "…" }` — patch into bubble.

---

## 8. Chat (Customer + Guide)

```http
GET /chats
→ { "threads": [ { "id", "traveller_name", "site_name", "unread", "online", "last_message", … } ] }

GET /chats/{id}
→ { "thread": …, "messages": [ … ] }

POST /chats/{id}/messages
{ "text": "See you at the north gate." }
→ { "message": { "id", "author": "guide", "text": "…", "sent_at": "…" } }
```

**WebSocket events** (JSON text frames):
```json
{ "type": "chat.message", "thread_id": "…", "message": { … } }
{ "type": "chat.read", "thread_id": "…", "reader": "traveller" }
```

Connect after login; reconnect with backoff; on resume call `GET /chats/{id}` to fill gaps.

---

## 9. Attraction Admin web

All routes under `/admin/attraction`. Send Bearer token for `attraction_admin`. Always pass `site_id` when the admin manages multiple sites.

### Login
Same `/auth/login` + OTP → if `role !== "attraction_admin"` show forbidden.

### Dashboard
```http
GET /admin/attraction/dashboard?site_id=adwa
```
```json
{
  "visitors_today": 510,
  "verified_today": 342,
  "revenue_etb_today": 125000,
  "capacity": 800,
  "capacity_ratio": 0.64,
  "integrity_rate": 0.97,
  "pending_bookings": 6,
  "active_staff": 12
}
```

### Edit site
```http
GET /admin/attraction/sites/adwa
PATCH /admin/attraction/sites/adwa
{
  "description": "…",
  "daily_capacity": 800,
  "meeting_point_default": "North entrance",
  "cover_image_url": "https://…"
}
```

### Ticket products
```http
GET /admin/attraction/sites/adwa/products
POST /admin/attraction/sites/adwa/products
{
  "tier": "foreign",
  "name": "Foreign adult",
  "price_etb": 500,
  "party_size_min": 1,
  "party_size_max": 1,
  "active": true
}
PATCH /admin/attraction/sites/adwa/products/{productId}
{ "price_etb": 550, "active": true }
```

### Visitors + export
```http
GET /admin/attraction/visitors?site_id=adwa&from=2026-07-01&to=2026-07-25&page=1
GET /admin/attraction/visitors/export?site_id=adwa&from=…&to=…
→ text/csv download
```

### Staff provisioning
```http
POST /admin/attraction/staff
{
  "email": "guide.eyerusalem@viseth.et",
  "phone": "+2519…",
  "display_name": "Eyerusalem Tadesse",
  "role": "guide",
  "home_site_id": "adwa",
  "staff_code": "ADW-TG-003",
  "title": "Senior Guide",
  "title_amharic": "ከፍተኛ መሪ"
}
```
**Expect 201:** created user (invite email sent). They log in on Staff app with that email.

```http
GET /admin/attraction/staff?site_id=adwa
PATCH /admin/attraction/staff/{staffProfileId}
{ "title": "Gate Lead", "home_site_id": "adwa" }
```

### Guides verification / bookings
```http
PATCH /admin/attraction/guides/{userId}
{ "verified": true }

GET /admin/attraction/bookings?site_id=adwa&status=pending
```

### Enrichment (Firecrawl)
```http
POST /admin/attraction/sites/adwa/enrich
→ { "job_id": "…", "status": "queued" }

Poll site:
GET /admin/attraction/sites/adwa
→ enrichment_updated_at + enrichment facts for preview
```

### Settlements
```http
GET /admin/attraction/settlements?site_id=adwa&month=2026-07
→ { "gross_etb", "platform_fee_etb", "net_etb", "currency": "ETB", "lines": […] }
```

---

## 10. Platform Admin web

All routes under `/admin/platform`. Role must be `platform_admin`.

### Dashboard
```http
GET /admin/platform/dashboard
```
```json
{
  "gmv_etb_30d": 4200000,
  "tickets_sold_30d": 18820,
  "active_sites": 9,
  "dau": 2400,
  "guides_active": 130,
  "open_moderation": 7,
  "payouts_pending_etb": 96000
}
```

### Sites onboard / suspend
```http
GET /admin/platform/sites?status=pending
POST /admin/platform/sites
{
  "id": "gondar-castle",
  "name": "Fasil Ghebbi",
  "name_amharic": "…",
  "region": "Amhara",
  "category": "unesco",
  "ticket_price_etb": 200,
  "daily_capacity": 1000,
  "unesco": true
}
PATCH /admin/platform/sites/adwa
{ "status": "active" }
```

### Users
```http
GET /admin/platform/users?q=selam&role=customer&page=1
PATCH /admin/platform/users/{id}
{ "status": "suspended" }
```

### Payments & refunds
```http
GET /admin/platform/payments?status=success&from=&to=
POST /admin/platform/payments/{id}/refund
{ "reason": "Duplicate purchase" }
```
**Expect:** payment `refunded`, linked ticket `refunded`.

### Payouts queue
```http
GET /admin/platform/payouts?status=processing
POST /admin/platform/payouts/{id}/retry
```

### Moderation
```http
GET /admin/platform/moderation?status=open
POST /admin/platform/moderation/{reportId}/action
{ "action": "hide", "note": "spam" }
```
`action`: `hide|restore|warn_user`

### Integrations health
```http
GET /admin/platform/integrations
```
```json
{
  "chapa": { "ok": true, "latency_ms": 180 },
  "whisperflow": { "ok": true, "latency_ms": 420 },
  "elevenlabs": { "ok": true, "latency_ms": 390 },
  "fal": { "ok": true, "latency_ms": 800 },
  "firecrawl": { "ok": false, "error": "timeout" }
}
```
Show status chips on Integrations page.

### AI usage / audit
```http
GET /admin/platform/ai-usage?from=&to=
GET /admin/platform/audit?page=1
```

---

## 11. Notifications (all authenticated apps)

```http
POST /me/devices
{ "platform": "android", "token": "<fcm-token>" }

GET /notifications?page=1
POST /notifications/{id}/read
POST /notifications/read-all
```

Notification `data` examples for deep links:

| category | data | Open |
|---|---|---|
| `ticket_ready` | `{ "ticket_id" }` | Ticket detail |
| `gift_received` | `{ "ticket_id" }` | Claim / ticket |
| `booking_request` | `{ "booking_id" }` | Guide Requests |
| `booking_update` | `{ "booking_id" }` | Customer booking |
| `tour_complete` | `{ "tour_id", "visit_id" }` | Passport stamp |
| `payout` | `{ "payout_id" }` | Earnings |
| `chat` | `{ "thread_id" }` | Chat thread |
| `moderation` | `{ "post_id" }` | (admin) |

---

## 12. Error handling cheat sheet

| code | Client behavior |
|---|---|
| `INVALID_CREDENTIALS` | Shake form; generic “wrong email or password” |
| `OTP_INVALID` | Clear OTP boxes; allow resend |
| `STAFF_NOT_PROVISIONED` | Staff-only message + support CTA |
| `FORBIDDEN_ROLE` | Sign out or show “wrong app” |
| `TOKEN_EXPIRED` | Silent refresh once |
| `CAPACITY_EXCEEDED` | Disable date / suggest another day |
| `PAYMENT_FAILED` | Retry checkout |
| `GUIDE_NOT_ACCEPTING` | Hide Book CTA; toast |
| `INSUFFICIENT_BALANCE` | Clamp withdraw slider |
| `RATE_LIMITED` | Backoff; gate scanner pause 2s |
| `INTEGRATION_ERROR` | “Voice temporarily unavailable”; allow typed fallback |

Gate verify: treat body `outcome`, not HTTP error, for visitor-facing results.

---

## 13. Staff app repository swap (concrete)

In `lib/data/repositories/providers.dart`:

```dart
final gateRepositoryProvider = Provider<GateRepository>(
  (ref) => HttpGateRepository(ref.watch(apiClientProvider)),
);

final guideRepositoryProvider = Provider<GuideRepository>(
  (ref) => HttpGuideRepository(ref.watch(apiClientProvider)),
);
```

Map:

| Repository method | Endpoint |
|---|---|
| `GateRepository.todayLog` | `GET /gate/visitors?filter=all` |
| `GateRepository.verify` | `POST /gate/verify` |
| `GateRepository.stats` | Prefer `GET /gate/stats` (server truth) |
| `GuideRepository.requests` | `GET /guide/requests` |
| `GuideRepository.tours` | `GET /guide/tours` |
| `GuideRepository.threads` | `GET /chats` |
| `GuideRepository.earnings` | `GET /guide/earnings` |
| `GuideRepository.profile` | `GET /guide/profile` |

---

## 14. Web admin auth guard (pseudo)

```ts
const { user } = await api.get('/me');
if (app === 'attraction' && user.role !== 'attraction_admin') redirect('/login');
if (app === 'platform' && user.role !== 'platform_admin') redirect('/login');
```

Attach token from httpOnly cookie or memory; prefer memory + refresh token in secure cookie for web.

---

## 15. Acceptance tests clients should run against staging

1. Customer registers → buys ticket via Chapa test mode → sees QR.  
2. Gatekeeper scans that QR → `outcome=valid` → customer passport gains stamp.  
3. Rescan → `already_used` + high risk flag.  
4. Diaspora gift ticket → gate `hint` contains gifter name.  
5. Customer books guide → guide accepts → live check-in → complete → earnings increase → withdraw processing.  
6. Mic path: transcribe → assistant → audio plays.  
7. Attraction admin invites staff email → staff can OTP login with correct shell.  
8. Platform admin suspends user → subsequent API calls `USER_SUSPENDED`.  
9. Share with `generate_image:true` returns `image_url`.  
10. Attraction enrich job updates site facts; assistant facts skill reflects them.

---

## 16. Quick endpoint index

| Method | Path | Roles |
|---|---|---|
| POST | `/auth/register` | public |
| POST | `/auth/login` | public |
| POST | `/auth/otp/verify` | public |
| POST | `/auth/google` | public |
| POST | `/auth/refresh` | public |
| POST | `/auth/logout` | any |
| GET/PATCH | `/me` | any |
| PATCH | `/me/preferences` | any |
| POST | `/me/devices` | any |
| GET | `/notifications` | any |
| GET | `/sites` | public |
| GET | `/sites/{id}` | public |
| POST | `/checkout/tickets` | customer |
| GET | `/payments/{id}` | customer |
| GET | `/tickets` | customer |
| GET | `/me/passport` | customer |
| POST | `/visits/{id}/share` | customer |
| GET | `/feed` | customer |
| POST | `/bookings` | customer |
| GET | `/gate/stats` | gatekeeper |
| GET | `/gate/visitors` | gatekeeper |
| POST | `/gate/verify` | gatekeeper |
| GET | `/guide/dashboard` | guide |
| GET/POST | `/guide/requests…` | guide |
| GET/POST | `/guide/tours…` | guide |
| GET/POST | `/guide/earnings` `/guide/payouts/withdraw` | guide |
| GET/POST | `/chats…` | customer, guide |
| POST | `/ai/transcribe` `/ai/assistant` `/ai/narrate` | customer, staff |
| * | `/admin/attraction/*` | attraction_admin |
| * | `/admin/platform/*` | platform_admin |
| POST | `/webhooks/chapa` | Chapa only (server) |

---

*End of client integration guide v1.0.0 — pair with backend technical spec; do not invent alternate field names.*
