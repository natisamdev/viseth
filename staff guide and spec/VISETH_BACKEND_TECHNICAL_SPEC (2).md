# Viseth Backend Technical Specification

**Version:** 1.0.0  
**Status:** Binding contract for backend implementation  
**Audience:** Backend developers  
**Companion doc:** [`VISETH_CLIENT_INTEGRATION_GUIDE.md`](./VISETH_CLIENT_INTEGRATION_GUIDE.md)  
**Date:** 2026-07-25  

This document is the single source of truth for what the Viseth API must store, expose, authenticate, and call externally. After reading it, a backend developer should be able to build the full API without clarifying questions.

---

## 0. Locked product decisions

These decisions are final for v1. Do not reopen them without a version bump.

| Decision | Value |
|---|---|
| API style | REST + JSON over HTTPS |
| API version prefix | `/v1` |
| Auth | JWT Bearer access token (15 min) + refresh token (30 days, rotate on use) |
| IDs | UUID v4 strings |
| Money | Integer **ETB cents** in storage (`amount_etb_cents`). API also returns `amount_etb` as integer birr for display convenience where noted. Staff app today uses whole birr — store cents, expose both. |
| Time | ISO-8601 UTC (`2026-07-25T12:00:00Z`) |
| Languages | `am`, `en`, `om`, `ti`, `fr`, `ar` |
| Ticket QR payload | `VISETH:TKT:<CODE>:<SITE_ID>` |
| Ticket code format | `^[A-Z]{3}-\d{4}-[A-Z]{2}$` (e.g. `ADW-8471-QK`) |
| Payments (customer) | **Chapa** initialize + webhook verify |
| Guide payouts | **Chapa Transfer** to guide’s telebirr / bank; UI labels destination as telebirr |
| Voice STT | **Whisperflow** (also known as WisprFlow in pitch materials) |
| Voice TTS / narration | **ElevenLabs** |
| Personalized share art / stamps | **Fal** (image generation) |
| Site discovery enrichment | **Firecrawl** (scrape + extract structured site facts) |
| Hosting assumption | API on Render (or equivalent); web admin on Netlify; mobile talks to same API |

**Surfaces covered**

1. **Customer app** (traveller / diaspora) — Flutter  
2. **Staff app** — Gatekeeper + Tour Guide — Flutter (implemented UI; mock → this API)  
3. **Attraction Admin web** — per-site operators  
4. **Platform Admin web** — Viseth super-admins  

---

## 1. Roles & authentication model

### 1.1 Roles

| Role | Surface | Scope |
|---|---|---|
| `customer` | Customer app | Own profile, tickets, passport, bookings, chat, feed |
| `gatekeeper` | Staff app | Assigned `site_id` only; scan/verify; shift stats |
| `guide` | Staff app | Own bookings, tours, chat, earnings, profile |
| `attraction_admin` | Attraction Admin | One or more `site_id`s; staff, pricing, visitors, content |
| `platform_admin` | Platform Admin | Global; onboard sites, users, payouts, moderation, integrations |

A user account has exactly one primary `role`. Staff accounts are **not** self-selected at login — role is assigned by Attraction Admin / Platform Admin and returned in the auth response.

### 1.2 Auth flows

| Flow | Who | Steps |
|---|---|---|
| Phone/email + password + OTP | All roles | `POST /auth/login` → `POST /auth/otp/verify` → tokens |
| Google OAuth | Customer + Staff (optional) | `POST /auth/google` with ID token → tokens (or OTP if new staff must be pre-provisioned) |
| Refresh | All | `POST /auth/refresh` |
| Logout | All | `POST /auth/logout` (revoke refresh) |
| Password reset | All | `POST /auth/password/forgot` → `POST /auth/password/reset` |

**Staff rule:** Login with work email. If email is not in `staff_users` (or `users.role` ∈ {gatekeeper, guide}), return `403 STAFF_NOT_PROVISIONED`. OTP is always required for staff.

**Customer rule:** Self-registration allowed via `POST /auth/register`.

### 1.3 Token claims (JWT access)

```json
{
  "sub": "user-uuid",
  "role": "gatekeeper",
  "site_ids": ["adwa"],
  "staff_id": "staff-uuid-or-null",
  "iat": 0,
  "exp": 0
}
```

- Gatekeepers: `site_ids` length 1 (home site).  
- Guides: `site_ids` = sites they are licensed for.  
- Attraction admins: all sites they administer.  
- Platform admins: `site_ids: ["*"]`.  
- Customers: `site_ids: []`, `staff_id: null`.

### 1.4 Authorization matrix (summary)

| Resource | customer | gatekeeper | guide | attraction_admin | platform_admin |
|---|---|---|---|---|---|
| Public site catalog | R | R | R | R | CRUD |
| Own tickets | CRUD* | — | — | R (their sites) | R |
| Scan/verify ticket | — | W (own site) | W (tour check-in) | — | — |
| Bookings | create/own | — | accept/decline/own | R | R |
| Chat | own threads | — | own threads | — | moderate |
| Earnings/payouts | — | — | own | site settlements | global |
| Staff CRUD | — | — | — | own sites | global |
| Passport stamps | own + public share | creates via scan | creates via tour end | R | R/mod |
| AI assistant | own | own | own | — | usage metrics |

\*Customer creates tickets via purchase checkout only; cannot forge codes.

---

## 2. Screen → feature → backend requirements

Each screen lists **data stored**, **endpoints required**, and **auth**. Endpoint details are in §4.

### 2.1 Customer app

| Screen | What the user does | Data to persist | Endpoints | Auth |
|---|---|---|---|---|
| Splash / Onboarding | Sees brand; first-run prefs | `user_preferences.onboarding_done` | `GET /me`, `PATCH /me/preferences` | optional → customer |
| Register / Login / OTP | Creates session | `users`, `otp_challenges`, `refresh_tokens` | `/auth/*` | public |
| Home | Heritage score, streak, featured sites, continue ticket | computed passport + sites | `GET /me/passport/summary`, `GET /sites?featured=true`, `GET /tickets?status=valid` | customer |
| Explore / Search | Browse/filter sites | sites, search analytics (optional) | `GET /sites`, `GET /sites/search?q=` | public or customer |
| Site detail | View info, tiers, guides, reviews | sites, tiers, media, guides | `GET /sites/{id}`, `GET /sites/{id}/guides`, `GET /sites/{id}/reviews` | public |
| Buy ticket | Choose date, tier, party | checkout session → ticket after pay | `POST /checkout/tickets`, Chapa redirect/callback | customer |
| Gift ticket (diaspora) | Buy for someone else | ticket with `gifted_by`, recipient phone/name | `POST /checkout/tickets` with `gift` object | customer |
| Payment result | Confirm success/fail | payment + ticket status | `GET /payments/{id}`, webhook (server) | customer |
| My Tickets | List + show QR | tickets | `GET /tickets`, `GET /tickets/{id}` | customer |
| Ticket QR | Display payload | derived from ticket | same | customer |
| Passport | Stamps, score, titles, streak | visits, achievements | `GET /me/passport`, `GET /me/achievements` | customer |
| Share visit | Create public share card | share_posts + Fal image | `POST /visits/{id}/share` | customer |
| Feed | See verified visits from people they follow / public | follows, share_posts | `GET /feed`, `POST /users/{id}/follow` | customer |
| Book guide | Request tour | booking_requests | `POST /bookings`, `GET /guides/{id}` | customer |
| My bookings | Track status | bookings | `GET /bookings` | customer |
| Chat | Message guide | chat_threads, messages | `GET /chats`, `GET /chats/{id}`, `POST /chats/{id}/messages`, WS | customer |
| Voice story / Assistant | Speak → story about site | assistant_sessions, audio assets | `POST /ai/transcribe`, `POST /ai/assistant`, `POST /ai/narrate` | customer |
| Profile / Settings | Edit profile, locale, notifications | users, preferences | `GET/PATCH /me`, `PATCH /me/preferences` | customer |
| Notifications | Inbox | notifications | `GET /notifications`, `POST /notifications/{id}/read` | customer |

### 2.2 Staff app — Gatekeeper

| Screen | What the user does | Data | Endpoints | Auth |
|---|---|---|---|---|
| Splash / Login / OTP | Staff session; role from directory | users, staff_profiles | `/auth/*` | staff |
| Gate Home | Headcount ring, integrity, shortcuts | scans today, capacity | `GET /gate/stats`, `GET /gate/visitors` | gatekeeper |
| Visitors | Today’s log; filter verified/rejected/gifts | scan_events | `GET /gate/visitors?filter=` | gatekeeper |
| Scan | Camera QR → verify | scan_events, tickets, visits | `POST /gate/verify` | gatekeeper |
| Manual entry | Type code | same | `POST /gate/verify` with bare code | gatekeeper |
| Shift summary | Refusal breakdown, handover notes | scan_events, shift_notes | `GET /gate/shift-summary`, `POST /gate/shift-notes` | gatekeeper |
| Assistant | Voice AI for briefing/fraud/translate | assistant + Whisperflow + ElevenLabs | `/ai/*` | gatekeeper |
| Profile | Staff card + performance | staff_profiles, performance | `GET /staff/me`, `GET /staff/me/performance` | gatekeeper |
| Notifications | Role notices | notifications | `GET /notifications` | gatekeeper |
| Settings | Theme/locale (client-local OK); account | preferences | `GET/PATCH /me/preferences` | gatekeeper |

### 2.3 Staff app — Tour Guide

| Screen | What the user does | Data | Endpoints | Auth |
|---|---|---|---|---|
| Guide Home | Next tour countdown, pending count | tours, bookings | `GET /guide/dashboard` | guide |
| Requests | Accept / decline | booking_requests | `GET /guide/requests`, `POST /guide/requests/{id}/accept\|decline` | guide |
| Schedule | Upcoming / past | tours | `GET /guide/tours` | guide |
| Tour detail | Brief, stops, start CTA | tours, tour_stops | `GET /guide/tours/{id}` | guide |
| Tour live | Check-in QR, timer, checklist, end | tours, stamps, earnings ledger | `POST /guide/tours/{id}/check-in`, `PATCH /guide/tours/{id}/stops/{stopId}`, `POST /guide/tours/{id}/complete` | guide |
| Chat list / thread | Message travellers; translate | chats | `/chats/*`, `POST /chats/{id}/messages/{mid}/translate` | guide |
| Earnings | Chart, payouts, withdraw | earnings, payouts, Chapa transfer | `GET /guide/earnings`, `POST /guide/payouts/withdraw` | guide |
| Guide profile | Public profile, toggle accepting | guide_profiles | `GET/PATCH /guide/profile` | guide |
| Assistant | Story scripts, translate, facts | AI stack | `/ai/*` | guide |
| Notifications / Settings | Same pattern as gatekeeper | — | same | guide |

### 2.4 Attraction Admin web

| Screen | What the admin does | Data | Endpoints | Auth |
|---|---|---|---|---|
| Login | Attraction admin session | users | `/auth/*` | attraction_admin |
| Dashboard | Today visitors, revenue, capacity, integrity | aggregates | `GET /admin/attraction/dashboard?site_id=` | attraction_admin |
| Sites (assigned) | Edit site info, hours, capacity, media | sites | `GET/PATCH /admin/attraction/sites/{id}` | attraction_admin |
| Ticket products | CRUD tiers & prices | ticket_products | `GET/POST/PATCH /admin/attraction/sites/{id}/products` | attraction_admin |
| Visitors | Search scan log, export CSV | scan_events | `GET /admin/attraction/visitors`, `GET .../export` | attraction_admin |
| Staff | Invite/assign gatekeepers & guides | staff_profiles | `GET/POST/PATCH /admin/attraction/staff` | attraction_admin |
| Bookings / Guides | Monitor bookings; verify guide licence | bookings, guides | `GET /admin/attraction/bookings`, `PATCH /admin/attraction/guides/{id}` | attraction_admin |
| Settlements | See ticket revenue share | settlements | `GET /admin/attraction/settlements` | attraction_admin |
| Content enrichment | Trigger Firecrawl refresh | site_content_jobs | `POST /admin/attraction/sites/{id}/enrich` | attraction_admin |
| Notifications / Settings | Org settings | org prefs | `GET/PATCH /admin/attraction/settings` | attraction_admin |

### 2.5 Platform Admin web

| Screen | What the admin does | Data | Endpoints | Auth |
|---|---|---|---|---|
| Login | Super-admin | users | `/auth/*` | platform_admin |
| Platform KPIs | GMV, tickets sold, active sites, DAU | aggregates | `GET /admin/platform/dashboard` | platform_admin |
| Sites directory | Approve/onboard/suspend sites | sites | `GET/POST/PATCH /admin/platform/sites` | platform_admin |
| Users | Search customers/staff; suspend | users | `GET/PATCH /admin/platform/users` | platform_admin |
| Payments | Chapa reconciliation, refunds | payments | `GET /admin/platform/payments`, `POST .../refund` | platform_admin |
| Payouts | Guide/site payout queue | payouts | `GET/POST /admin/platform/payouts` | platform_admin |
| Moderation | Shared visits / reports | share_posts, reports | `GET /admin/platform/moderation`, `POST .../action` | platform_admin |
| Integrations health | Chapa/Whisperflow/ElevenLabs/Fal/Firecrawl status | integration_health | `GET /admin/platform/integrations` | platform_admin |
| AI usage | Token/minute costs | ai_usage_logs | `GET /admin/platform/ai-usage` | platform_admin |
| Audit log | Who changed what | audit_logs | `GET /admin/platform/audit` | platform_admin |

---

## 3. Data model (storage)

Use PostgreSQL. Suggested table names below. All tables have `created_at`, `updated_at` unless noted.

### 3.1 `users`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| email | citext unique null | required for staff/admin |
| phone | text unique null | E.164 preferred |
| password_hash | text null | null if Google-only |
| google_sub | text unique null | |
| role | enum | `customer\|gatekeeper\|guide\|attraction_admin\|platform_admin` |
| display_name | text | |
| country_code | char(2) null | ISO 3166-1 |
| avatar_url | text null | |
| locale | text default `en` | |
| amharic_first | bool default false | |
| status | enum | `active\|suspended\|deleted` |
| telebirr_msisdn | text null | guides / payout destination |
| last_login_at | timestamptz null | |

### 3.2 `otp_challenges`

| Column | Type |
|---|---|
| id | uuid PK |
| user_id | uuid FK |
| channel | `sms\|email` |
| code_hash | text |
| expires_at | timestamptz |
| consumed_at | timestamptz null |
| attempts | int |

### 3.3 `refresh_tokens`

| Column | Type |
|---|---|
| id | uuid PK |
| user_id | uuid FK |
| token_hash | text |
| expires_at | timestamptz |
| revoked_at | timestamptz null |
| user_agent | text null |
| ip | inet null |

### 3.4 `sites` (heritage attractions)

| Column | Type | Notes |
|---|---|---|
| id | text PK | slug e.g. `adwa`, `lalibela` |
| name | text | |
| name_amharic | text | |
| region | text | |
| category | text | museum, memorial, park, church, … |
| description | text | |
| description_amharic | text | |
| ticket_price_etb_cents | int | default adult price |
| daily_capacity | int | |
| unesco | bool | |
| lat / lng | numeric null | |
| address | text null | |
| meeting_point_default | text null | |
| status | enum | `draft\|pending\|active\|suspended` |
| cover_image_url | text null | |
| enrichment_json | jsonb | Firecrawl/Exa-derived facts |
| enrichment_updated_at | timestamptz null | |
| attraction_org_id | uuid null | owning org |

Seed IDs used by Staff app today: `adwa`, `lalibela`, `simien`, `axum`, `fasil`, `harar`, `national`, `tisisat`, `sofomar`.

### 3.5 `ticket_products`

| Column | Type |
|---|---|
| id | uuid PK |
| site_id | text FK |
| tier | enum | `adult\|child\|student\|group\|diaspora\|foreign` |
| name | text |
| price_etb_cents | int |
| party_size_min / max | int |
| active | bool |

### 3.6 `tickets`

| Column | Type | Notes |
|---|---|---|
| id | uuid PK | |
| code | text unique | `ADW-8471-QK` |
| qr_payload | text | `VISETH:TKT:CODE:SITE` |
| purchaser_user_id | uuid FK | who paid |
| holder_user_id | uuid null | claimed recipient; may equal purchaser |
| holder_name | text | |
| holder_phone | text | |
| site_id | text FK | |
| tier | enum | |
| party_size | int | |
| valid_on | date | single-day validity v1 |
| purchased_at | timestamptz | |
| price_etb_cents | int | |
| status | enum | `pending_payment\|valid\|used\|expired\|refunded` |
| used_at | timestamptz null | |
| used_gate | text null | e.g. `Gate 2` |
| gifted_by_name | text null | diaspora display |
| gifted_from_place | text null | e.g. `Washington, DC` |
| gift_recipient_phone | text null | |
| payment_id | uuid null FK | |
| booking_id | uuid null | if bundled with guide |

**Code generation:** `{SITE_PREFIX}-{NNNN}-{AA}` where prefix is first 3 letters of site id uppercased (`ADW`, `LAL`), NNNN random 0–9999, AA random A–Z.

### 3.7 `payments`

| Column | Type |
|---|---|
| id | uuid PK |
| user_id | uuid FK |
| provider | `chapa` |
| provider_tx_ref | text unique |
| provider_ref_id | text null | Chapa ref after success |
| amount_etb_cents | int |
| currency | `ETB` |
| purpose | `ticket_purchase\|guide_booking\|gift_ticket` |
| status | `pending\|success\|failed\|refunded` |
| metadata | jsonb | ticket draft, etc. |
| paid_at | timestamptz null |

### 3.8 `scan_events`

| Column | Type |
|---|---|
| id | uuid PK |
| ticket_id | uuid null |
| ticket_code | text |
| site_id | text |
| gatekeeper_user_id | uuid |
| gate_label | text |
| raw_payload | text |
| outcome | enum | `valid\|already_used\|expired\|not_yet_valid\|wrong_site\|invalid` |
| risk_flags | jsonb | `[{level,title,detail}]` |
| hint | text null |
| party_size | int default 0 |
| is_gift | bool |
| scanned_at | timestamptz |

### 3.9 `visits` (passport stamps)

| Column | Type |
|---|---|
| id | uuid PK |
| user_id | uuid | holder |
| site_id | text |
| ticket_id | uuid null |
| tour_id | uuid null |
| source | `gate_scan\|tour_complete` |
| stamped_at | timestamptz |
| verified | bool default true |

Unique constraint: one stamp per (`user_id`, `site_id`, `ticket_id`) when ticket present.

### 3.10 `achievements` / `user_achievements`

Heritage score, streaks, titles.

- `heritage_score` (0–100): computed = `min(100, unique_verified_sites * 8 + total_visits * 2 + gifts_received * 3)`.  
- `streak_days`: consecutive calendar days with ≥1 verified visit.  
- Titles: unlock table e.g. `Adwa Witness` when site `adwa` stamped; `Heritage Keeper` at score ≥60.

### 3.11 `share_posts`

| Column | Type |
|---|---|
| id | uuid PK |
| visit_id | uuid FK |
| user_id | uuid |
| caption | text |
| image_url | text | Fal-generated or upload |
| visibility | `public\|followers\|private` |
| status | `active\|hidden\|removed` |
| like_count | int |

### 3.12 `follows`

`follower_id`, `followee_id`, unique pair.

### 3.13 `staff_profiles`

| Column | Type |
|---|---|
| id | uuid PK |
| user_id | uuid unique |
| role | `gatekeeper\|guide` |
| staff_code | text unique | e.g. `ADW-GK-014` |
| title / title_amharic | text |
| home_site_id | text |
| avatar_color_seed | int |

### 3.14 `guide_profiles`

| Column | Type |
|---|---|
| staff_profile_id | uuid PK/FK |
| headline / headline_amharic | text |
| bio | text |
| languages | text[] | enum values |
| site_ids | text[] | |
| licence_id | text | |
| years_experience | int | |
| verified | bool | |
| accepting_bookings | bool | |
| rating_avg | numeric | |
| review_count | int | |
| tours_completed | int | |
| response_minutes_avg | int | |

### 3.15 `booking_requests` / `tours`

**booking_requests**

| Column | Type |
|---|---|
| id | uuid PK |
| traveller_user_id | uuid |
| guide_user_id | uuid |
| site_id | text |
| starts_at | timestamptz |
| duration_hours | numeric |
| party_size | int |
| language | text |
| payout_etb_cents | int |
| note | text |
| status | `pending\|accepted\|declined\|completed\|cancelled` |
| is_diaspora_gift | bool |
| requested_at | timestamptz |

**tours** (created on accept)

| Column | Type |
|---|---|
| id | uuid PK |
| booking_id | uuid unique |
| state | `upcoming\|live\|completed\|cancelled` |
| meeting_point | text |
| checked_in_at | timestamptz null |
| completed_at | timestamptz null |
| check_in_ticket_code | text null |

**tour_stops**

| id | tour_id | title | title_amharic | minutes | sort_order | done |

### 3.16 Chat

`chat_threads`: id, booking_id null, site_id, traveller_user_id, guide_user_id, last_message_at, traveller_unread, guide_unread  

`chat_messages`: id, thread_id, author_role (`traveller\|guide\|system`), text, translation null, read_at, sent_at

### 3.17 Earnings

`ledger_entries`: id, guide_user_id, tour_id null, type (`tour_earn\|withdrawal\|adjustment`), amount_etb_cents, status (`pending\|available\|paid`), at  

`payouts`: id, guide_user_id, amount_etb_cents, method (`telebirr`), status (`scheduled\|processing\|paid\|failed`), chapa_transfer_ref, reference, tour_count, at

### 3.18 AI

`assistant_sessions`: id, user_id, role_context, created_at  
`assistant_messages`: id, session_id, author (`user\|assistant`), text, skill, sources jsonb, audio_url null, spoken bool  
`ai_usage_logs`: provider, operation, user_id, units, cost_estimate, at  
`site_content_jobs`: site_id, provider `firecrawl`, status, result_json, at

### 3.19 Admin / ops

`attraction_orgs`, `attraction_admin_sites` (user_id, site_id), `settlements`, `moderation_reports`, `audit_logs`, `notifications`, `shift_notes`

### 3.20 Notifications

| Column | Type |
|---|---|
| id | uuid PK |
| user_id | uuid |
| title | text |
| body | text |
| category | text |
| data | jsonb | deep link keys |
| read_at | timestamptz null |

Push: store FCM/APNs device tokens in `device_tokens`.

---

## 4. API endpoint catalog

Base URL: `https://api.viseth.et/v1` (staging: `https://api-staging.viseth.et/v1`)

Common headers:

```
Authorization: Bearer <access_token>
Content-Type: application/json
Accept-Language: en|am|...
X-Request-Id: <client-uuid>   # optional, echoed
```

Common envelope:

**Success**
```json
{
  "ok": true,
  "data": { },
  "meta": { "request_id": "..." }
}
```

**Error**
```json
{
  "ok": false,
  "error": {
    "code": "TICKET_ALREADY_USED",
    "message": "Human readable message",
    "details": { }
  }
}
```

List responses paginate with `?page=1&page_size=20` → `meta: { page, page_size, total }`.

---

### 4.1 Auth

#### `POST /auth/register`
**Auth:** public  
**Body:**
```json
{
  "display_name": "Selam Alemu",
  "email": "selam@example.com",
  "phone": "+251914472210",
  "password": "secret12",
  "country_code": "ET"
}
```
**Response 201:** `{ "user": User, "otp_required": true, "challenge_id": "..." }`  
Creates `role=customer`. Sends OTP.

#### `POST /auth/login`
**Auth:** public  
**Body:** `{ "email": "...", "password": "..." }` OR `{ "phone": "...", "password": "..." }`  
**Response 200:** `{ "challenge_id": "...", "otp_required": true, "role": "gatekeeper" }`  
**Errors:** `INVALID_CREDENTIALS` (401), `STAFF_NOT_PROVISIONED` (403), `USER_SUSPENDED` (403)

#### `POST /auth/otp/verify`
**Body:** `{ "challenge_id": "...", "code": "123456" }`  
**Response 200:**
```json
{
  "access_token": "...",
  "refresh_token": "...",
  "expires_in": 900,
  "user": {
    "id": "...",
    "display_name": "Yonas Kebede",
    "email": "yonas.kebede@viseth.et",
    "role": "gatekeeper",
    "staff": {
      "staff_code": "ADW-GK-014",
      "home_site_id": "adwa",
      "site_name": "Adwa Victory Memorial",
      "site_amharic": "የአድዋ ድል መታሰቢያ",
      "title": "Gate Lead",
      "title_amharic": "የበር ኃላፊ"
    }
  }
}
```

#### `POST /auth/google`
**Body:** `{ "id_token": "..." }`  
Customer: upsert user. Staff: only if email already provisioned; else `403`.

#### `POST /auth/refresh`
**Body:** `{ "refresh_token": "..." }` → new access + refresh.

#### `POST /auth/logout`
**Auth:** required  
Revokes refresh token.

#### `POST /auth/password/forgot` / `POST /auth/password/reset`
Standard email/SMS reset.

---

### 4.2 Me / preferences / notifications

#### `GET /me` → User + role profile  
#### `PATCH /me`  
**Body:** `{ "display_name", "country_code", "avatar_url", "telebirr_msisdn" }`  

#### `PATCH /me/preferences`  
**Body:** `{ "locale", "amharic_first", "push_enabled", "sound_enabled", "haptics_enabled", "theme": "system|light|dark" }`  

#### `GET /notifications`  
#### `POST /notifications/{id}/read`  
#### `POST /notifications/read-all`  
#### `POST /me/devices` — `{ "platform": "android|ios|web", "token": "..." }`

---

### 4.3 Sites (public + customer)

#### `GET /sites`
Query: `featured`, `region`, `category`, `unesco`, `q`, pagination  
**Response item:**
```json
{
  "id": "adwa",
  "name": "Adwa Victory Memorial",
  "name_amharic": "የአድዋ ድል መታሰቢያ",
  "region": "Addis Ababa",
  "category": "memorial",
  "ticket_price_etb": 150,
  "daily_capacity": 800,
  "unesco": false,
  "cover_image_url": "https://...",
  "rating_avg": 4.8,
  "visit_count": 12040
}
```

#### `GET /sites/{id}`  
Full detail + `products[]` + `enrichment` highlights + `open_hours`.

#### `GET /sites/{id}/guides`  
Public guide cards for booking.

#### `GET /sites/{id}/reviews`  

#### `POST /admin/...` for mutations — see §4.10–4.11

---

### 4.4 Checkout & payments (Chapa)

#### `POST /checkout/tickets`
**Auth:** customer  
**Body:**
```json
{
  "site_id": "adwa",
  "product_id": "uuid",
  "tier": "adult",
  "party_size": 2,
  "valid_on": "2026-07-26",
  "holder_name": "Selam Alemu",
  "holder_phone": "+251914472210",
  "gift": {
    "enabled": true,
    "recipient_name": "Tigist Bekele",
    "recipient_phone": "+251911000000",
    "gifted_by_name": "Dawit Bekele",
    "gifted_from_place": "Washington, DC"
  },
  "return_url": "viseth://payments/return",
  "callback_url": "https://api.viseth.et/v1/webhooks/chapa"
}
```
**Server:**  
1. Validate capacity for `valid_on` (count `status in (valid,used,pending_payment)` party sizes < `daily_capacity`).  
2. Create `payments` row `pending` + reserved ticket draft `pending_payment`.  
3. Call **Chapa** `POST https://api.chapa.co/v1/transaction/initialize` with `tx_ref=payment.id`, amount, currency ETB, customer email/phone, customizations.  
4. Return:

```json
{
  "payment_id": "...",
  "ticket_id": "...",
  "amount_etb": 300,
  "checkout_url": "https://checkout.chapa.co/...",
  "tx_ref": "..."
}
```

#### `GET /payments/{id}`  
Returns status; if success, includes ticket.

#### `POST /webhooks/chapa`
**Auth:** Chapa signature header verification (secret).  
On success: mark payment success; set ticket `valid`; generate `code` + `qr_payload`; notify purchaser (+ SMS to gift recipient).  
On fail: ticket `expired`/`cancelled` equivalent → set `refunded` or delete reservation; free capacity.

#### `POST /admin/platform/payments/{id}/refund`  
Platform admin; calls Chapa refund; ticket → `refunded`.

**Guide booking payment (optional v1.1):** same pattern with `purpose=guide_booking`. v1 may book for free payout-only (traveller pays site ticket separately). **v1 rule:** booking request does not require Chapa; guide earns on tour complete; ticket purchase is the paid path.

---

### 4.5 Customer tickets & passport

#### `GET /tickets`
Query: `status=valid|used|expired`  
#### `GET /tickets/{id}`  
Includes `qr_payload`, gift fields, site summary.

#### `POST /tickets/{id}/claim`
Gift recipient claims with OTP to `gift_recipient_phone` → sets `holder_user_id`.

#### `GET /me/passport/summary`
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

#### `GET /me/passport`  
List of stamps with site, date, source, share status.

#### `POST /visits/{id}/share`
**Body:** `{ "caption": "...", "visibility": "public", "generate_image": true }`  
If `generate_image`: call **Fal** to generate share card → store URL.  
**Response:** `{ "post": SharePost }`

#### `GET /feed`  
#### `POST /share/{id}/like`  
#### `POST /users/{id}/follow` / `DELETE /users/{id}/follow`

---

### 4.6 Gatekeeper

All require `role=gatekeeper`. `site_id` forced from token `site_ids[0]`.

#### `GET /gate/stats`
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
`integrity_rate` = 1 - (high_risk_flags / scans).

#### `GET /gate/visitors?filter=all|verified|rejected|gifts`
Returns `VisitorEntry[]` matching Staff app model.

#### `POST /gate/verify`
**Body:**
```json
{
  "payload": "VISETH:TKT:ADW-8471-QK:adwa",
  "gate": "Gate 2"
}
```
Also accepts bare `ADW-8471-QK` in `payload`.

**Server algorithm (must match Staff mock behavior):**

1. Extract code from `VISETH:TKT:<code>:<siteId>` or bare pattern; else `invalid` + high risk.  
2. Lookup ticket; missing → `invalid`.  
3. If `ticket.site_id != gatekeeper.home_site_id` → `wrong_site`.  
4. If `valid_on` > today → `not_yet_valid`.  
5. If `valid_on` < today or status expired → `expired`.  
6. If status `used` OR prior successful scan → `already_used` + high risk duplicate flag.  
7. Else mark `used`, set `used_at`, `used_gate`; insert `scan_events`; create `visits` stamp for `holder_user_id` if set (else pending claim); if gift, notification.  
8. Return:

```json
{
  "outcome": "valid",
  "scanned_at": "...",
  "raw_payload": "...",
  "hint": "Diaspora gift from Dawit Bekele. Hand them the welcome card.",
  "ticket": { "...Ticket..." },
  "flags": [],
  "risk_level": "none"
}
```

#### `GET /gate/shift-summary`  
Aggregates refusals by outcome + recent high-risk events.

#### `POST /gate/shift-notes`  
**Body:** `{ "note": "School group still inside panorama hall." }`

#### `GET /staff/me/performance`  
Ratings distribution + recent reviews (gatekeeper metrics: speed, courtesy, integrity).

---

### 4.7 Guide

All require `role=guide`.

#### `GET /guide/dashboard`
```json
{
  "next_tour": { "...ScheduledTour or null..." },
  "pending_requests": 4,
  "unread_chats": 2,
  "today_earnings_etb": 4800,
  "accepting_bookings": true
}
```

#### `GET /guide/requests`  
#### `POST /guide/requests/{id}/accept`  
Creates `tours` row `upcoming`, sets booking `accepted`, opens/ensures chat thread, notifies traveller.

#### `POST /guide/requests/{id}/decline`  
**Body:** `{ "reason": "optional" }`

#### `GET /guide/tours?state=upcoming|live|completed`  
#### `GET /guide/tours/{id}`  
Includes `stops[]`.

#### `POST /guide/tours/{id}/check-in`
**Body:** `{ "payload": "VISETH:TKT:..." }`  
Validates ticket belongs to traveller party / site; sets tour `live`, `checked_in_at`.

#### `PATCH /guide/tours/{id}/stops/{stopId}`  
**Body:** `{ "done": true }`

#### `POST /guide/tours/{id}/complete`
- Sets tour `completed`, booking `completed`.  
- Creates passport `visits` for traveller (source `tour_complete`) if not already stamped for that ticket.  
- Inserts ledger `tour_earn` amount = booking.payout.  
- Notifies traveller (“passport stamped”) and guide (“payout queued”).  
**Response:** `{ "tour": ..., "payout_queued_etb": 2400, "stamp": {...} }`

#### `GET /guide/earnings`
Matches Staff `EarningsSummary` shape (weekly points, payouts, available/pending).

#### `POST /guide/payouts/withdraw`
**Body:** `{ "amount_etb": 4800 }`  
Validates `amount <= available`; creates payout `processing`; calls **Chapa Transfer** to `users.telebirr_msisdn`; on webhook/success → `paid`.

#### `GET /guide/profile` / `PATCH /guide/profile`  
**PATCH body includes** `{ "accepting_bookings": false, "bio": "...", "headline": "..." }`

---

### 4.8 Bookings & chat (customer ↔ guide)

#### `POST /bookings`
**Auth:** customer  
**Body:**
```json
{
  "guide_id": "user-uuid",
  "site_id": "adwa",
  "starts_at": "2026-07-26T12:30:00Z",
  "duration_hours": 2,
  "party_size": 3,
  "language": "english",
  "note": "Wheelchair access?",
  "is_diaspora_gift": false
}
```
Server computes `payout_etb_cents` from site/guide rate table (default: `duration_hours * party_size * rate`).  
Guide must have `accepting_bookings=true` and site in `site_ids`.

#### `GET /bookings` (customer)  
#### `GET /guides/{id}` public profile + reviews  
#### `POST /guides/{id}/reviews` after completed tour `{ "rating": 5, "text": "..." }`

#### Chat
- `GET /chats`  
- `GET /chats/{id}`  
- `POST /chats/{id}/messages` `{ "text": "..." }`  
- `POST /chats/{id}/messages/{mid}/translate` `{ "target_language": "am" }` — may use Whisperflow/LLM translate path; store `translation`  
- WebSocket `wss://api.viseth.et/v1/ws/chat?token=` for realtime

Authorization: participant only (or platform_admin).

---

### 4.9 AI (Whisperflow, ElevenLabs, Fal, Firecrawl)

#### `POST /ai/transcribe`
**Auth:** customer | gatekeeper | guide  
**Content-Type:** `multipart/form-data`  
Fields: `audio` (file), `language` optional  
**Server:** forward audio to **Whisperflow** STT →  
```json
{ "text": "Brief my shift", "language": "en", "confidence": 0.92 }
```

#### `POST /ai/assistant`
**Body:**
```json
{
  "session_id": null,
  "query": "Give me my shift briefing",
  "spoken": true,
  "skill_hint": "briefing"
}
```
**Server:**  
1. Load role context (gate stats / guide day / customer site).  
2. Optionally retrieve site facts from `sites.enrichment_json` (Firecrawl-fed).  
3. LLM generate answer (provider internal; can be Addis AI later).  
4. If `spoken`, call **ElevenLabs** TTS → `audio_url`.  
5. Persist messages + `ai_usage_logs`.  

**Response:**
```json
{
  "session_id": "...",
  "message": {
    "id": "...",
    "author": "assistant",
    "text": "...",
    "skill": "briefing",
    "sources": ["Gate 2 log", "Today's ticket manifest"],
    "audio_url": "https://...",
    "spoken": true
  }
}
```

Skills enum: `story|translate|briefing|facts|fraud|general` (matches Staff app).

#### `POST /ai/narrate`
**Body:** `{ "text": "...", "voice": "am_female|en_warm" }`  
ElevenLabs only → `{ "audio_url": "..." }`.

#### `POST /ai/story`
Customer voice story for a site: transcribe (Whisperflow) → generate story → narrate (ElevenLabs) → optional Fal cover image.

#### Firecrawl (admin-triggered)
#### `POST /admin/attraction/sites/{id}/enrich`  
Server calls **Firecrawl** scrape on configured source URLs / Wikipedia; writes `enrichment_json`; logs job.

#### Fal
Used inside `POST /visits/{id}/share` when `generate_image=true` and optionally passport stamp art.

---

### 4.10 Attraction Admin

Prefix: `/admin/attraction`  
**Auth:** `attraction_admin` + site membership check on every `site_id`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/dashboard?site_id=` | KPI cards |
| GET/PATCH | `/sites/{id}` | Site content & capacity |
| GET/POST/PATCH | `/sites/{id}/products` | Ticket tiers |
| GET | `/visitors?site_id=&from=&to=` | Scan log |
| GET | `/visitors/export?site_id=` | CSV |
| GET/POST/PATCH | `/staff` | Provision staff emails/roles/codes |
| GET | `/bookings?site_id=` | Monitor |
| PATCH | `/guides/{userId}` | `{ "verified": true }` |
| GET | `/settlements?site_id=` | Revenue share |
| POST | `/sites/{id}/enrich` | Firecrawl |
| GET/PATCH | `/settings` | Org defaults |

**Staff invite body:**
```json
{
  "email": "guide.eyerusalem@viseth.et",
  "phone": "+2519...",
  "display_name": "Eyerusalem Tadesse",
  "role": "guide",
  "home_site_id": "adwa",
  "staff_code": "ADW-TG-003",
  "title": "Senior Guide",
  "title_amharic": "ከፍተኛ መሪ"
}
```
Creates `users` + `staff_profiles` (+ empty `guide_profiles` if guide). Sends invite email.

---

### 4.11 Platform Admin

Prefix: `/admin/platform`  
**Auth:** `platform_admin` only.

| Method | Path | Purpose |
|---|---|---|
| GET | `/dashboard` | Global KPIs |
| GET/POST/PATCH | `/sites` | Onboard/approve/suspend |
| GET/PATCH | `/users` | Suspend, role fix |
| GET | `/payments` | Ledger |
| POST | `/payments/{id}/refund` | Chapa refund |
| GET/POST | `/payouts` | Approve/retry transfers |
| GET | `/moderation` | Queue |
| POST | `/moderation/{id}/action` | `{ "action": "hide\|restore\|warn_user" }` |
| GET | `/integrations` | Third-party health pings |
| GET | `/ai-usage` | Cost/usage |
| GET | `/audit` | Audit trail |

Every mutating platform/attraction admin call writes `audit_logs`.

---

## 5. Third-party integration details

### 5.1 Chapa

| Purpose | When | API |
|---|---|---|
| Collect ticket/gift payment | `POST /checkout/tickets` | Initialize transaction |
| Confirm payment | Webhook + optional verify | Verify transaction |
| Refund | Platform admin | Refund API |
| Guide withdraw | `POST /guide/payouts/withdraw` | Transfer to telebirr/bank |

**Secrets:** `CHAPA_SECRET_KEY`, `CHAPA_WEBHOOK_SECRET`, `CHAPA_PUBLIC_KEY` (client may use public key only if doing inline; preferred: server-side checkout URL).

**Idempotency:** `tx_ref` = `payments.id`. Never create two success tickets for one `tx_ref`.

### 5.2 Whisperflow

| Purpose | Endpoint |
|---|---|
| Speech → text for assistant mic | `POST /ai/transcribe` |
| Voice stories | `POST /ai/story` |

Store raw audio temporarily (TTL 24h) or stream; log usage.

### 5.3 ElevenLabs

| Purpose | Endpoint |
|---|---|
| Narrate assistant replies | `POST /ai/assistant` when `spoken=true` |
| Narrate heritage stories | `POST /ai/narrate`, `POST /ai/story` |

Cache audio by hash(text+voice) to control cost.

### 5.4 Fal

| Purpose | Endpoint |
|---|---|
| Share card / passport art | `POST /visits/{id}/share` |

Prompt must include site name + verified badge motif; store resulting CDN URL.

### 5.5 Firecrawl

| Purpose | Endpoint |
|---|---|
| Enrich site descriptions/facts | `POST /admin/attraction/sites/{id}/enrich` |
| Platform batch refresh | cron or platform admin |

Write structured fields into `sites.enrichment_json` e.g. `{ "facts": [], "hours": "", "sources": [] }`. Assistant `facts` skill reads this.

---

## 6. Business rules (must implement)

1. **Single-entry tickets:** first successful gate verify wins; further attempts `already_used`.  
2. **Site binding:** gatekeeper can only verify for `home_site_id`.  
3. **Capacity:** reject checkout if `headcount_reserved + party_size > daily_capacity` for that date.  
4. **Gift tickets:** purchaser ≠ holder allowed; gate hint uses `gifted_by_name`; recipient can `claim`.  
5. **Passport stamp:** created on successful gate verify (if holder linked) and/or tour complete — idempotent per ticket.  
6. **Heritage score:** recompute async on new stamp.  
7. **Guide accept:** only `pending` → `accepted`; creates tour + chat.  
8. **Tour complete:** only from `live`; creates earn ledger; cannot complete twice.  
9. **Withdraw:** only `available` balance; min 100 ETB; requires `telebirr_msisdn`.  
10. **Role lock:** clients never send role to escalate; JWT is source of truth.  
11. **QR forge resistance:** codes unguessable; rate-limit verify 60/min/device; log all attempts.  
12. **Expiry job:** nightly mark `valid` tickets with `valid_on < today` as `expired`.

---

## 7. Realtime & jobs

| Channel | Use |
|---|---|
| WebSocket `/v1/ws/chat` | Chat messages |
| WebSocket `/v1/ws/guide` optional | New booking request badges |
| Cron nightly | Expire tickets; settle attraction shares |
| Queue workers | Chapa webhook processing, ElevenLabs, Fal, Firecrawl, push notifications |

---

## 8. Error codes (selected)

| Code | HTTP | Meaning |
|---|---|---|
| INVALID_CREDENTIALS | 401 | Bad login |
| OTP_INVALID | 401 | Bad/expired OTP |
| STAFF_NOT_PROVISIONED | 403 | Staff email unknown |
| FORBIDDEN_ROLE | 403 | Wrong role for route |
| USER_SUSPENDED | 403 | Banned |
| NOT_FOUND | 404 | Missing entity |
| CAPACITY_EXCEEDED | 409 | Site full that day |
| TICKET_ALREADY_USED | 409 | Duplicate verify (also returned as outcome in verify body — prefer 200 with outcome for gate UX) |
| PAYMENT_FAILED | 402 | Chapa failure |
| INSUFFICIENT_BALANCE | 400 | Withdraw too high |
| GUIDE_NOT_ACCEPTING | 409 | Bookings closed |
| RATE_LIMITED | 429 | Too many verifies |
| INTEGRATION_ERROR | 502 | Chapa/Whisperflow/etc down |

**Gate verify note:** Always return **200** with `outcome` for known scan paths (including invalid). Use 4xx only for malformed auth/body. This matches Staff app UX (never crash the scanner).

---

## 9. Seed data requirements

Backend must seed for Staff app demo parity:

| Ticket code | Outcome at site `adwa` |
|---|---|
| ADW-8471-QK | valid |
| ADW-2290-RT | valid + diaspora gift |
| ADW-5533-LM | already_used |
| ADW-1188-ZC | expired |
| ADW-9001-VV | not_yet_valid |
| LAL-7742-PN | wrong_site |

Staff:

- Gatekeeper `yonas.kebede@viseth.et` / site Adwa / `ADW-GK-014`  
- Guide `guide.eyerusalem@viseth.et`

Sites: the nine heritage sites listed in §3.4.

---

## 10. Non-functional requirements

| Area | Requirement |
|---|---|
| Latency | Gate verify p95 < 400ms excluding network |
| Idempotency | Chapa webhooks & withdraw endpoints idempotent |
| Audit | All admin writes logged |
| PII | Phone/email encrypted at rest preferred; never log full OTP |
| CORS | Allow Attraction/Platform admin origins only |
| Rate limits | Auth 10/min/IP; verify 60/min/token; AI 20/min/user |
| Observability | Structured logs + metrics for third-party error rates |

---

## 11. Out of scope for v1 (explicit)

- Multi-day ticket validity ranges (only single `valid_on`)  
- Marketplace for non-guide experiences  
- In-app social DMs between customers  
- Offline-first sync (gate may cache manifest later — not v1)  
- Apple/Google IAP (tickets are Chapa ETB)

---

## 12. Implementation checklist for backend

- [ ] Auth + roles + OTP + Google  
- [ ] Sites + products + Firecrawl enrich  
- [ ] Chapa checkout + webhook + tickets + QR  
- [ ] Gate verify + visitors + stats + shift notes  
- [ ] Passport stamps + heritage score + share + Fal  
- [ ] Guide bookings + tours + chat + translate  
- [ ] Earnings ledger + Chapa transfer withdraw  
- [ ] AI transcribe (Whisperflow) + assistant + narrate (ElevenLabs)  
- [ ] Attraction admin APIs  
- [ ] Platform admin APIs  
- [ ] Notifications + device tokens  
- [ ] Seed data matching Staff demo  
- [ ] Integration tests for verify matrix & payment idempotency  

---

*End of backend technical specification v1.0.0*
