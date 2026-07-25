# Viseth Backend Technical Specification

**Audience:** Backend / Integrations team  
**Version:** 2.0  
**Date:** 2026-07-25  
**Companion:** `VISETH_CLIENT_INTEGRATION_GUIDE.md` (client call book — write after this API is stable)  
**Sources:** `Viseth_Full_Project_Description_v2.pdf`, Night Coffee design system, `customer_app` UI contract, Super Admin / Place Admin / Staff screen inventory  

This document is the **single build contract** for the Viseth backend. Every screen across Customer App, Staff App (Guide + Gatekeeper), Attraction Admin web, and Platform Admin (Super Admin) web is mapped to **data, APIs, request/response shapes, third-party calls, and auth rules**. Do not invent alternate shapes without updating this document and notifying client teams.

---

## 0. How to use this document

1. Implement Section 4 data model + Section 5 business rules first.  
2. Ship Custom API endpoints in Section 7 in MVP order (Section 15).  
3. Wire third parties exactly as Section 8.  
4. Seed demo data per Section 12.  
5. Pass the acceptance checklist in Section 13 before handing clients the integration guide.

---

## 1. Product summary

Viseth is a personal travel passport for Ethiopian heritage sites. Travellers buy tickets (**Chapa**), enter via QR scan by a gatekeeper, build a verified visit passport, send diaspora gifts (shared keycode + named greeting), book guides, post AI-enhanced recaps, browse a discovery feed / nearby map, and progress through streak badges and follower titles. **Place Admins** run one attraction; **Super Admins** run the platform.

**MVP demo must-haves (PDF §2):** browse + Firecrawl facts, Chapa ticket, QR + scan, passport, diaspora gift, guide booking, AI recap (Whisperflow + ElevenLabs), admin dashboard.  
**Built in customer UI beyond thin PDF (treat as API scope for hackathon):** feed, explore, nearby, hotels (read + soft-book), multi-guest tickets, gift success keycode, comments/share/report, theme is client-only.

---

## 2. Architecture (locked)

```
Flutter Customer App
Flutter Staff App (guide + gatekeeper modes)
        │
        ├─ Firebase Auth (+ optional Firestore cache)
        │     accounts identity; optional client-readable mirrors
        │
        └─ Custom API  (Node/Express or FastAPI on Railway/Render)
              → ALL money (Chapa init, webhook, refund)
              → Gift keycodes + QR HMAC payloads
              → Scan verification
              → Streak / title / heritage recompute
              → AI proxies: Whisperflow, ElevenLabs, Fal, Firecrawl
              → Place Admin + Platform Admin REST
              → Preferred source of truth for tickets, gifts, visits, transactions

Web Attraction Admin  ──┐
Web Platform Admin    ──┴── Custom API only (Firebase Admin SDK server-side)
```

### Hard rules

1. Anything involving **money, secrets, AI vendor keys, or scan verification** MUST go through the Custom API.  
2. Admin webs MUST NOT hold Chapa/AI secrets.  
3. Currency is **ETB**. Amounts are decimals with 2 places (e.g. `1200.00`).  
4. Timestamps in API responses are **ISO-8601 UTC**.  
5. IDs are opaque (`usr_…`, `atr_…`, `tkt_…`, `gft_…`, `txn_…`, `vis_…`, `bkg_…`, `pst_…`, `htl_…`). Clients never invent durable IDs.  
6. Money endpoints require `Idempotency-Key: <uuid-v4>`.  
7. Primary datastore may be Postgres **or** Firestore via Admin SDK — pick one and stick to it. Clients should prefer Custom API reads for tickets/gifts/visits/payments even if Firestore mirrors exist.

**Base URL**

| Env | Base |
|---|---|
| Staging | `https://api-staging.viseth.et/v1` |
| Production | `https://api.viseth.et/v1` |

Paths in this doc omit the host; they are under `/v1`.

---

## 3. Roles & authentication

### 3.1 Roles

| Role | Surface | Scope |
|---|---|---|
| `traveler` | Customer app | Own profile, purchases, passport, social |
| `guide` | Staff app (guide mode) | Own guide profile, booking inbox |
| `gatekeeper` | Staff app (gatekeeper mode) | Scan only at assigned `attractionIds` |
| `place_admin` | Attraction Admin web | Exactly one `attractionId` |
| `super_admin` | Platform Admin web | Whole platform |
| `partner` | External | Read-only API key feed |

A mobile account has one primary role: `traveler` | `guide` | `gatekeeper`.  
Place/super admins are **separate email/password admin accounts** (not Firebase travelers).

### 3.2 Auth mechanisms

| Client | Mechanism |
|---|---|
| Flutter apps | Firebase Auth → `Authorization: Bearer <firebase_id_token>` |
| Attraction / Platform Admin | Email/password → JWT access (15m) + refresh (30d) |
| Place machine keys | `X-Api-Key: vk_live_…` (scope `place_admin`) |
| Chapa webhook | Signature verification, no user token |
| Partner | `X-Api-Key: pk_…` |

On first Firebase login, Custom API upserts `users` from token claims (`GET /me` creates if missing). Default role `traveler`. Guides/gatekeepers are provisioned by Place/Platform Admin (linked Firebase UID + role).

### 3.3 Common headers

```
Authorization: Bearer <token>
Content-Type: application/json
Accept: application/json
X-Client: customer | staff | attraction_admin | platform_admin
X-Request-Id: <uuid>          # optional; echo in logs
Idempotency-Key: <uuid-v4>    # required on money POSTs
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

| HTTP | When |
|---|---|
| 400 | Validation |
| 401 | Unauthenticated / bad token |
| 403 | Wrong role or wrong attraction scope |
| 404 | Not found |
| 409 | Conflict (duplicate idempotency with different body) |
| 422 | Business rule (scan failures, etc.) |
| 429 | Rate limit |
| 503 | Maintenance (`MAINTENANCE`) |
| 502 | Upstream Chapa/AI failure |

### 3.5 Pagination (all list endpoints)

Query: `page` (default 1), `pageSize` (default 20, max 100; social reports admin UI uses 5).

```json
{
  "items": [],
  "page": 1,
  "pageSize": 20,
  "total": 128,
  "totalPages": 7
}
```

---

## 4. Data model (persist these)

### 4.1 `users`
| Field | Type | Notes |
|---|---|---|
| id | string | PK (`usr_…`) |
| firebaseUid | string | unique |
| email | string? | |
| phone | string? | E.164 |
| displayName | string | |
| username | string? | unique handle |
| photoUrl | string? | |
| bio | string? | |
| region | string? | home region label |
| role | enum | `traveler` \| `guide` \| `gatekeeper` |
| status | enum | `active` \| `pending` \| `suspended` |
| isDiaspora | bool | unlocks gift-first UX; set from login toggle |
| followerCount / followingCount | int | denormalized |
| streakMonths | int | consecutive months with ≥1 visit |
| streakBrokenAt | timestamp? | |
| currentBadgeId / currentTitleId | string? | |
| heritageScore | int | 0–100 |
| regionsVisited | string[] | unique region codes/names |
| sitesVisitedCount | int | denormalized unique active sites |
| hasCompletedFirstPurchase | bool | confetti gate |
| createdAt / updatedAt | timestamp | |

### 4.2 `guides` (1:1 when role=guide)
| Field | Type |
|---|---|
| userId | string | PK/FK |
| bio | string |
| languages | string[] |
| specialties | string[] |
| toursCompleted | int |
| rating | number? | 0–5 |
| pricePerDayEtb | number | |
| attractionIds | string[] | sites covered |
| region | string | |
| verified | bool | |
| respondsIn | string | e.g. `under 2 hours` |
| active | bool | Super Admin / approval |
| photoUrl | string? | |

### 4.3 `gatekeepers`
| Field | Type |
|---|---|
| userId | string |
| attractionIds | string[] | usually one |
| active | bool |
| displayName / email / phone | string |
| deviceIds | string[] | optional |

### 4.4 `place_admins` / `super_admins`
Email/password accounts with `passwordHash`, `active`, timestamps.  
`place_admins.attractionId` is **exactly one**.  
`super_admins` have no attraction scope.

### 4.5 `attractions`
| Field | Type | Notes |
|---|---|---|
| id | string | |
| name | string | |
| amharicName | string? | |
| address | string | |
| region | string | e.g. Addis Ababa, Amhara, Tigray, Harari, Oromia |
| category | enum | `museum` \| `heritage` \| `park` \| `natural` \| `culture` |
| description / summary | string | |
| lat, lng | number | |
| ticketPrice | number | ETB; **Super Admin owns** |
| active | bool | |
| isUnesco | bool | |
| openHours | string | |
| tags | string[] | |
| coverImageUrl | string? | |
| rating / reviewCount | number/int | optional seed |
| enrichedFacts | string[] | Firecrawl |
| enrichmentStatus | enum | `none` \| `pending` \| `ready` \| `failed` |
| createdAt / updatedAt | timestamp | |

### 4.6 `hotels` (customer Explore — include for UI parity)
| Field | Type |
|---|---|
| id | string |
| name | string |
| region | string |
| nearAttractionId | string |
| pricePerNightEtb | number |
| rating / reviewCount | |
| lat, lng | number |
| amenities | string[] |
| freeCancellation | bool |
| active | bool |
| coverImageUrl | string? |

### 4.7 `tickets`
| Field | Type | Notes |
|---|---|---|
| id | string | |
| code | string | unique short display code optional |
| qrPayload | string | **HMAC-signed** opaque string for QR |
| attractionId | string | |
| holderUserId | string? | purchaser or claimed user |
| holderName | string | shown at gate (primary) |
| guests | int | party size paid for (≥1) |
| visitDate | date/datetime | intended visit |
| purchaserUserId / purchaserName | string | |
| amount | number | `ticketPrice * guests` (+ fees if any) |
| status | enum | `pending_payment` \| `valid` \| `used` \| `voided` \| `expired` |
| giftId | string? | if issued via gift |
| transactionId | string | |
| purchasedAt / usedAt / expiresAt | timestamp | |
| voidReason | string? | |

**QR rule:** encode `qrPayload` only. Payload contains at least `ticketId`, `attractionId`, `exp`, HMAC. Clients never forge.

### 4.8 `gifts`
| Field | Type |
|---|---|
| id | string |
| keycode | string | unique human code e.g. `HRR-4821` |
| attractionId | string |
| senderUserId / senderName | string |
| recipientNames | string[] | ordered; length = N paid |
| greeting | string? | |
| visitDate | date/datetime? | intended visit day |
| recipientsTotal / redeemedCount | int | |
| status | enum | `pending_payment` \| `active` \| `partially_used` \| `fully_used` \| `revoked` \| `expired` |
| transactionId | string | |
| createdAt / expiresAt | timestamp | |
| revokeReason | string? | |

### 4.9 `transactions`
| Field | Type |
|---|---|
| id | string | |
| reference | string | Chapa `tx_ref` `CHP-…` |
| kind | enum | `ticket` \| `gift` \| `booking` \| `hotel` |
| status | enum | `pending` \| `succeeded` \| `failed` \| `refunded` |
| payerUserId / payerName | string | |
| attractionId | string? | |
| guideId / hotelId / bookingId | string? | |
| amount | number | gross ETB |
| fee | number | optional processor/platform fee shown in UI (~2%) |
| commission | number | platform cut |
| commissionRate | number | snapshot % |
| chapaCheckoutUrl | string? | |
| failureReason | string? | |
| metadata | object | ticketIds[], giftId, etc. |
| createdAt / updatedAt | timestamp | |

### 4.10 `visits`
| Field | Type |
|---|---|
| id | string | |
| userId | string? | if matched to account |
| visitorName | string | gate display |
| attractionId | string | |
| region | string | copied |
| ticketId / giftId | string? | |
| wasGift | bool | |
| scannedByUserId | string | |
| scannedAt | timestamp | |

### 4.11 `bookings`
| Field | Type |
|---|---|
| id | string | |
| guideId / travelerId | string | |
| requestedDate | date | |
| note | string? | |
| status | enum | `requested` \| `confirmed` \| `declined` \| `cancelled` \| `completed` |
| transactionId / amount | optional | |
| createdAt / updatedAt | |

### 4.12 `hotel_bookings` (soft MVP)
id, hotelId, travelerId, checkIn, checkOut, rooms, guests, status (`requested`\|`confirmed`\|`cancelled`), transactionId?, amount?, createdAt

### 4.13 `recap_posts`
| Field | Type |
|---|---|
| id | string | |
| authorId | string | |
| attractionId | string | |
| visitId | string? | must be author’s verified visit when enforcing proof |
| body | string | caption |
| media | array | `{ url, kind: image\|video, name? }` |
| imageUrl / audioUrl | string? | convenience / TTS |
| aiAssisted | bool | |
| hasVoiceStory | bool | |
| isGiftedVisit | bool | |
| status | enum | `published` \| `flagged` \| `removed` |
| likeCount / commentCount / shareCount / reportCount | int | |
| reportReasons | string[] | |
| removalReason | string? | |
| visitedOn | date | from visit |
| createdAt | timestamp | |

### 4.14 Social
- `comments`: id, postId, authorId, body, status (`visible`\|`removed`), createdAt  
- `follows`: followerId, followeeId, createdAt (unique pair)  
- `post_likes`: userId, postId, createdAt  
- `saved_attractions`: userId, attractionId, createdAt  
- `messages`: **out of MVP** (stub OK; no persistence required)

### 4.15 `social_reports`
category: `violence` \| `sexual_abuse` \| `other`  
contentType: `recap` \| `comment` \| `profile` \| `message`  
status: `open` \| `actioned` \| `dismissed`  
+ reporterUserId, reportedUserId, targetId, postId?, contentPreview, notes, resolutionNote?, resolvedByAdminId?, createdAt, resolvedAt?

### 4.16 Gamification config
**`streak_tiers`:** Dula 1–2, Jile 3–4, Tor 5–7, Gasha 8–10, Shotel 11–15, Ye Zellan Silt 16+ with `requiresAllRegions=true`.  
**`follower_titles`:** Traveler 0–50, Young Noble 51–200, Commander 201–500, Vanguard Chief 501–2000, Governor 2001–10000, Ras 10001+. **Never** አጼ/Emperor.  
Store Amharic labels with each title.

### 4.17 Ops / money / platform
- `payouts` — monthly per attraction (gross, commission, net, status scheduled/paid/on_hold)  
- `support_cases` — kind payment/access/content/site/other; status open/in_progress/escalated/resolved  
- `api_credentials` — scope place_admin/webhook/partner; store hash; plaintext once  
- `feature_flags` — `diaspora_gifting`, `ai_recaps`, `guide_booking`, `streak_badges`, `discovery_feed`, `live_streaming`, `hotels`  
- `platform_settings` — commissionRate (default 12), payoutDay (1–28), supportEmail, maintenanceMode, giftKeycodeExpiryHours (72), ticketExpiryHours (default 168), platformFeePercent (optional ~2 display)  
- `announcements` — audience all/travelers/guides/gatekeepers  
- `audit_log` — category content/admins/money/catalogue/platform/support/security  
- `integration_health` — Chapa, Firebase, Firecrawl, Whisperflow, ElevenLabs, Fal  
- `notifications` — userId, type, title, body, readAt?, createdAt (gift waiting, scan confirm, etc.)  
- `media_assets` — id, ownerUserId, url, kind, createdAt  

---

## 5. Business rules (locked — do not leave ambiguous)

1. **Maintenance mode:** reject new payment checkouts and gate scans with `503` / `MAINTENANCE`.  
2. **Commission:** `commission = round(amount * commissionRate / 100, 2)`; partner share = `amount - commission`. Snapshot rate on transaction.  
3. **Ticket amount:** `round(ticketPrice * guests, 2)`. Optional `fee = round(amount * platformFeePercent/100, 2)`; checkout total = amount + fee if you charge it (customer UI shows ~2%).  
4. **Ticket QR:** HMAC opaque `qrPayload`; Custom API verifies; never raw UUID alone.  
5. **Gift keycode:** `{3-letter site slug}-{4 digits}`, unique among non-expired. Expires after `giftKeycodeExpiryHours`.  
6. **Gift redeem (MVP):** one successful scan redeems **all remaining** recipient names; create one visit per name; mark gift `fully_used`.  
7. **Solo ticket scan:** mark ticket `used`; create **one** visit for `holderName` (guests is party size metadata; MVP does not create N visits unless you later add named guests).  
8. **Scan failures:** `ALREADY_USED` \| `EXPIRED` \| `INVALID_CODE` \| `WRONG_ATTRACTION` \| `MAINTENANCE` → HTTP 422 body with `valid:false`.  
9. **Wrong attraction:** code valid elsewhere but `attractionId` ≠ ticket/gift site → `WRONG_ATTRACTION`.  
10. **Gatekeeper scope:** `attractionId` in body MUST be in gatekeeper’s `attractionIds` or `403`.  
11. **Streak:** consecutive calendar months with ≥1 verified visit. Miss a month → reset on next visit’s month. Recompute after every successful scan.  
12. **Ye Zellan Silt:** requires streakMonths ≥ 16 **and** `regionsVisited` covers every distinct `region` among currently `active` attractions.  
13. **Heritage Score (align with customer_app):**  
    ```
    sitesPart   = clamp(uniqueSitesVisited / 20, 0, 1) * 55
    regionsPart = clamp(regionsVisited / TOTAL_REGIONS, 0, 1) * 30
    streakPart  = clamp(streakMonths / 16, 0, 1) * 15
    heritageScore = round(sitesPart + regionsPart + streakPart)
    ```  
    `TOTAL_REGIONS` = count of distinct regions in seed catalogue (or settings). Recompute after each visit.  
14. **Follower title:** recompute from `followerCount` on follow/unfollow.  
15. **Inactive attraction:** hidden from traveler browse; existing `valid` tickets still scannable until used/expired.  
16. **Refund (super_admin):** Chapa refund; transaction `refunded`; void unused tickets; do **not** delete existing visits.  
17. **Content removal:** status `removed` + reason; author cannot undelete.  
18. **Social auto-flag:** ≥3 reports on a recap → status `flagged`.  
19. **Report resolve:** requires `resolutionNote`; may set user `suspended`.  
20. **Place admin:** server injects `attractionId` from JWT — ignore client overrides. Place admin may edit description/cover only — **not** ticketPrice, active, lat/lng.  
21. **Recap proof (MVP):** `attractionId` must match a visit owned by author (or skip soft-check in demo with flag). Prefer requiring `visitId`.  
22. **First purchase celebration:** `isFirstPurchaseCelebrationEligible` true only when `hasCompletedFirstPurchase` is false and a ticket payment just succeeded; client calls nothing — passport/ticket responses expose the flag once; after client shows confetti, `POST /me/celebrations/first-purchase` sets the bool (or auto-clear after first `GET /tickets/mine` with header). **Decision:** expose flag on ticket finalize + `GET /passport/me`; client `POST /me/celebrations/first-purchase` to acknowledge.  
23. **Chat / live streaming:** out of backend MVP.  
24. **Traveler directory CRUD for Super Admin:** not required.  
25. **Audit:** void, revoke, refund, hold payout, remove content, suspend, rotate key, change commission → audit row.

---

## 6. Screen → backend map

### 6.1 Customer app

| # | Screen | Backend |
|---|---|---|
| 1 | Splash | none (local) |
| 2 | Login / phone OTP / diaspora toggle | Firebase Auth; `PATCH /me` `{ isDiaspora }`; `GET /me`; `GET /config` |
| 3 | Home / Feed | `GET /feed?tab=for_you\|following`; like/comment/share/follow/report |
| 4 | Explore | `GET /attractions`; `GET /guides`; `GET /hotels`; gift CTA client-only nav |
| 5 | Attraction detail | `GET /attractions/{id}`; save `POST /attractions/{id}/save` |
| 6 | Ticket purchase | `POST /payments/tickets/checkout` → Chapa |
| 7 | Ticket / QR + list | `GET /tickets/mine`; poll `GET /payments/{id}` |
| 8 | My Passport | `GET /passport/me`; tickets summary |
| 9 | Guide list / profile / book | `GET /guides`, `GET /guides/{id}`, `POST /bookings` |
| 10 | Hotels list / detail / soft book | `GET /hotels`, `GET /hotels/{id}`, `POST /hotel-bookings` (+ optional pay) |
| 11 | Nearby map | `GET /attractions/nearby?lat&lng` (+ hotels nearby) |
| 12 | Create recap | `GET /passport/me` visits; `POST /media/upload`; `POST /ai/transcribe`; `POST /recaps` |
| 13 | Post detail + TTS | `GET /recaps/{id}`; `POST /ai/tts`; comments |
| 14 | Send a Gift wizard | `POST /payments/gifts/checkout` |
| 15 | Gift success | `GET /gifts/mine` or checkout finalize payload |
| 16 | Profile (me) | `GET /me`; my recaps; saved; bookings; settings local theme |
| 17 | User profile (other) | `GET /users/{id}`; follow |
| 18 | Notifications | `GET /notifications`; `POST /notifications/read` |

### 6.2 Staff — Guide
| Screen | Backend |
|---|---|
| Inbox | `GET /guides/me/bookings` |
| Confirm/decline/complete | `PATCH /bookings/{id}` |
| Profile edit | `PATCH /guides/me` |

### 6.3 Staff — Gatekeeper
| Screen | Backend |
|---|---|
| Scan | `POST /scans/verify` |
| Confirmation | uses verify JSON only |

### 6.4 Attraction Admin web
Login → dashboard → visits → tickets → gatekeepers → site profile → payouts → credential prefix.

### 6.5 Platform Admin web
Login → overview → attractions CRUD + Firecrawl enrich → place admins → guide approval → moderation → social reports → revenue → transactions → payouts → support → gamification → integrations → API credentials → settings/flags/announcements → account → audit/exports.

---

## 7. Custom API endpoint catalog

Unless noted, auth required. Role column = allowed roles.

### 7.0 Config

#### `GET /config`
**Roles:** any authenticated (or public)  
**Response 200**
```json
{
  "maintenanceMode": false,
  "supportEmail": "support@viseth.et",
  "platformFeePercent": 2,
  "currency": "ETB",
  "totalRegions": 12,
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

---

### 7.1 Me & users

#### `GET /me`
**Roles:** traveler, guide, gatekeeper  
**Response 200**
```json
{
  "user": {
    "id": "usr_01",
    "email": "selam@example.com",
    "phone": "+251911000000",
    "displayName": "Selam Tesfaye",
    "username": "selam",
    "photoUrl": null,
    "bio": "",
    "region": "Addis Ababa",
    "role": "traveler",
    "status": "active",
    "isDiaspora": false,
    "followerCount": 12,
    "followingCount": 4,
    "heritageScore": 33,
    "streakMonths": 2,
    "sitesVisitedCount": 2,
    "regionsVisited": ["Addis Ababa", "Amhara"],
    "hasCompletedFirstPurchase": false,
    "currentBadge": {
      "id": "tier_dula",
      "badgeName": "Dula",
      "item": "Wooden fighting stick",
      "minMonths": 1,
      "maxMonths": 2
    },
    "currentTitle": {
      "id": "ttl_traveler",
      "title": "Traveler",
      "amharic": "ተጓዥ",
      "minFollowers": 0,
      "maxFollowers": 50
    },
    "gatekeeperAttractionIds": [],
    "guideProfileId": null
  }
}
```

#### `PATCH /me`
**Body:** `{ "displayName"?, "photoUrl"?, "phone"?, "bio"?, "region"?, "username"?, "isDiaspora"? }`  
**Response 200:** `{ "user": { … } }`

#### `POST /me/celebrations/first-purchase`
**Roles:** traveler  
Marks `hasCompletedFirstPurchase=true`.  
**Response 204**

#### `GET /users/{id}`
Public profile subset: id, displayName, username, photoUrl, bio, region, followerCount, followingCount, heritageScore, streakMonths, currentBadge, currentTitle, sitesVisitedCount, isFollowing (relative to caller).

#### `POST /users/{id}/follow` → 204  
#### `DELETE /users/{id}/follow` → 204  
Recompute titles for followee.

---

### 7.2 Attractions & nearby & save

#### `GET /attractions`
Query: `active=true`, `region=`, `category=`, `q=`, `page`, `pageSize`  
**Roles:** authenticated app users  
**Item shape**
```json
{
  "id": "atr_adwa",
  "name": "Adwa Victory Memorial Museum",
  "amharicName": "የአድዋ ድል መታሰቢያ ሙዚየም",
  "address": "Piassa Square, Addis Ababa",
  "region": "Addis Ababa",
  "category": "museum",
  "summary": "…",
  "description": "…",
  "lat": 9.0342,
  "lng": 38.7636,
  "ticketPrice": 300.00,
  "active": true,
  "isUnesco": false,
  "openHours": "09:00–17:00",
  "tags": ["history"],
  "coverImageUrl": null,
  "rating": 4.8,
  "reviewCount": 214,
  "enrichedFacts": ["…"],
  "enrichmentStatus": "ready",
  "distanceKm": null
}
```

#### `GET /attractions/{id}`
Same object. Travelers get `404` if inactive (admins may still fetch via platform/place routes).

#### `GET /attractions/nearby`
Query: `lat`, `lng`, `radiusKm` (default 50), `limit` (default 20)  
Returns attractions (+ optional `include=hotels`) sorted by distance; each item includes `distanceKm`.

#### `POST /attractions/{id}/save` / `DELETE /attractions/{id}/save`
**Roles:** traveler → 204

#### `GET /me/saved-attractions`
Paginated attraction summaries.

---

### 7.3 Hotels

#### `GET /hotels`
Query: `region=`, `nearAttractionId=`, `q=`, pagination  
#### `GET /hotels/{id}`
#### `GET /hotels/nearby?lat&lng`
#### `POST /hotel-bookings`
**Roles:** traveler; flag `hotels`  
**Body**
```json
{
  "hotelId": "htl_01",
  "checkIn": "2026-08-01",
  "checkOut": "2026-08-03",
  "rooms": 1,
  "guests": 2
}
```
**Response 201:** booking `requested` (payment optional via `POST /payments/hotels/checkout` if enabled; else soft-book only for demo).

#### `GET /hotel-bookings/mine`

---

### 7.4 Payments — Chapa

#### `POST /payments/tickets/checkout`
**Roles:** traveler · Flag: not maintenance  
**Headers:** `Idempotency-Key` required  
**Body**
```json
{
  "attractionId": "atr_adwa",
  "holderName": "Selam Tesfaye",
  "guests": 2,
  "visitDate": "2026-07-26T10:00:00Z",
  "returnUrl": "viseth://payments/return"
}
```
**Behavior:** validate attraction active; create `transaction` pending + ticket `pending_payment`; call Chapa Initialize; return checkout.  
**Response 201**
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

#### `POST /payments/gifts/checkout`
**Roles:** traveler · Flag: `diaspora_gifting`  
**Body**
```json
{
  "attractionId": "atr_harar",
  "recipientNames": ["Meron Abebe", "Sara Mulugeta", "Abel Getachew"],
  "greeting": "From your cousin in DC",
  "visitDate": "2026-08-02T09:00:00Z",
  "returnUrl": "viseth://payments/return"
}
```
Constraints: `recipientNames.length` 1–20; each name 2–80 chars.  
Amount = `ticketPrice * N`.  
**Response 201:** ticket-checkout shape + `"recipients": 3`.

#### `POST /payments/bookings/checkout`
**Body:** `{ "bookingId": "bkg_01", "returnUrl"? }` · Flag `guide_booking`

#### `POST /payments/hotels/checkout` (optional)
**Body:** `{ "hotelBookingId": "hb_01", "returnUrl"? }` · Flag `hotels`

#### `GET /payments/{transactionId}`
**Roles:** payer or super_admin  
```json
{
  "id": "txn_01",
  "reference": "CHP-8F2A41",
  "kind": "ticket",
  "status": "succeeded",
  "amount": 600.00,
  "fee": 12.00,
  "total": 612.00,
  "currency": "ETB",
  "attractionId": "atr_adwa",
  "metadata": { "ticketId": "tkt_01", "giftId": null },
  "createdAt": "2026-07-25T10:00:00Z",
  "updatedAt": "2026-07-25T10:01:12Z"
}
```

#### `POST /webhooks/chapa`
**Auth:** Chapa signature  
**Behavior (idempotent on `reference`):**  
- success → transaction `succeeded`; ticket → `valid` + set `qrPayload`; gift → `active` + allocate `keycode`; optional SMS; notify sender  
- fail → `failed`  
Never trust client “I paid” alone.

#### `POST /payments/{transactionId}/refund`
**Roles:** super_admin  
**Body:** `{ "reason": "…" }`  
Chapa refund; void unused tickets; revoke unused gifts; audit.

---

### 7.5 Tickets & gifts (read)

#### `GET /tickets/mine`
Query: `status=valid|used|expired|all`  
```json
{
  "items": [
    {
      "id": "tkt_01",
      "status": "valid",
      "holderName": "Selam Tesfaye",
      "guests": 2,
      "visitDate": "2026-07-26T10:00:00Z",
      "amount": 600.00,
      "code": "VSTH-ADWA-1842",
      "qrPayload": "vise1.eyJ…sig",
      "giftedBy": null,
      "giftKeycode": null,
      "attraction": {
        "id": "atr_adwa",
        "name": "Adwa Victory Memorial Museum",
        "region": "Addis Ababa",
        "amharicName": "…"
      },
      "purchasedAt": "2026-07-25T10:01:12Z",
      "expiresAt": "2026-08-01T10:01:12Z",
      "isFirstPurchaseCelebrationEligible": true
    }
  ],
  "page": 1,
  "pageSize": 20,
  "total": 1,
  "totalPages": 1
}
```

#### `GET /tickets/{id}` — owner only

#### `GET /gifts/mine`
```json
{
  "items": [
    {
      "id": "gft_01",
      "keycode": "HRR-4821",
      "status": "active",
      "recipientNames": ["Meron Abebe", "Sara Mulugeta", "Abel Getachew"],
      "greeting": "From your cousin in DC",
      "visitDate": "2026-08-02T09:00:00Z",
      "recipientsTotal": 3,
      "redeemedCount": 0,
      "attraction": { "id": "atr_harar", "name": "Harar Jugol", "region": "Harari" },
      "createdAt": "2026-07-25T11:00:00Z",
      "expiresAt": "2026-07-28T11:00:00Z"
    }
  ]
}
```

---

### 7.6 Scan verification (critical path)

#### `POST /scans/verify`
**Roles:** gatekeeper  
**Body**
```json
{
  "code": "<qrPayload OR gift keycode>",
  "attractionId": "atr_harar"
}
```
**Response 200 — solo**
```json
{
  "valid": true,
  "type": "solo_ticket",
  "names": ["Selam Tesfaye"],
  "guests": 2,
  "attractionName": "Harar Jugol",
  "senderName": null,
  "greeting": null,
  "visitIds": ["vis_01"],
  "ticketId": "tkt_01",
  "giftId": null
}
```
**Response 200 — gift**
```json
{
  "valid": true,
  "type": "gift_keycode",
  "names": ["Meron Abebe", "Sara Mulugeta", "Abel Getachew"],
  "guests": 3,
  "attractionName": "Harar Jugol",
  "senderName": "Yonas Alemu",
  "greeting": "From your cousin in DC",
  "visitIds": ["vis_02", "vis_03", "vis_04"],
  "ticketId": null,
  "giftId": "gft_01"
}
```
**Response 422 — failure**
```json
{
  "valid": false,
  "type": null,
  "names": [],
  "guests": 0,
  "attractionName": "Harar Jugol",
  "senderName": null,
  "greeting": null,
  "visitIds": [],
  "errorCode": "ALREADY_USED",
  "errorMessage": "This ticket was already scanned."
}
```
**Side effects:** visits created; ticket/gift updated; `recomputeProgress` for matched users; notify holders/sender; scan audit-lite log.

---

### 7.7 Passport & gamification

#### `GET /passport/me`
```json
{
  "heritageScore": 50,
  "sitesVisited": 3,
  "regionsCovered": ["Addis Ababa", "Amhara", "Harari"],
  "streakMonths": 4,
  "badge": {
    "badgeName": "Jile",
    "item": "Curved dagger",
    "minMonths": 3,
    "maxMonths": 4
  },
  "title": { "title": "Traveler", "amharic": "ተጓዥ" },
  "visits": [
    {
      "id": "vis_01",
      "attractionId": "atr_adwa",
      "attractionName": "Adwa Victory Memorial Museum",
      "region": "Addis Ababa",
      "scannedAt": "2026-07-20T08:12:00Z",
      "wasGift": false
    }
  ],
  "upcomingTickets": [],
  "isFirstPurchaseCelebrationEligible": false
}
```

#### Internal: `recomputeProgress(userId)`
Updates streakMonths, badge, title, heritageScore, regionsVisited, sitesVisitedCount.

#### Platform gamification
- `GET /platform/gamification`  
- `PUT /platform/gamification/streak-tiers` — full array replace  
- `PUT /platform/gamification/follower-titles` — full array replace  
**Roles:** super_admin · validate non-overlapping ranges.

---

### 7.8 Guides & bookings

#### `GET /guides` — query `region=`, `q=`, `active=true`
#### `GET /guides/{id}`
#### `PATCH /guides/me` — guide; body bio, languages, specialties, photoUrl, pricePerDayEtb, region, attractionIds  
#### `POST /bookings`
```json
{
  "guideId": "usr_guide_01",
  "requestedDate": "2026-08-02",
  "note": "Family of four, Amharic ok"
}
```
**201:** `{ "booking": { "id", "status": "requested", … } }`

#### `GET /bookings/mine` (traveler)
#### `GET /guides/me/bookings` (guide)
#### `PATCH /bookings/{id}`  
Body: `{ "status": "confirmed"|"declined"|"cancelled"|"completed" }`  
Rules: guide confirms/declines/completes; traveler cancels while `requested`.

---

### 7.9 Recaps, feed, comments, AI

#### `POST /media/upload`
**Roles:** traveler, guide  
multipart `file` → `{ "url": "https://…", "kind": "image"|"video", "id": "med_01" }`

#### `POST /recaps`
**Flag:** text always; AI fields need `ai_recaps`  
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
**201:** full recap object.

#### `GET /recaps/{id}`
#### `DELETE /recaps/{id}` — author, if published  
#### `GET /feed`
Query: `tab=for_you|following`, `page`, `pageSize`  
Flag: `discovery_feed` (if false, return empty for_you or 404 with clear code)  
Item includes author (with badge/title), attraction, caption, media, counts, `likedByMe`, `visitedOn`, flags.

#### `POST /recaps/{id}/like` / `DELETE /recaps/{id}/like`
#### `POST /recaps/{id}/share` → `{ "shareCount": N, "shareUrl": "https://viseth.et/r/…" }`  
#### `GET /recaps/{id}/comments` / `POST /recaps/{id}/comments` `{ "body" }`

#### `POST /ai/transcribe`
**Upstream:** Whisperflow · multipart `audio`  
**Response:** `{ "text": "…" }` · do not durable-store audio >24h

#### `POST /ai/tts`
**Upstream:** ElevenLabs  
**Body:** `{ "text": "…", "recapId"? }`  
**Response:** `{ "audioUrl": "https://…", "durationSeconds": 42 }`

#### `POST /ai/image`
**Upstream:** Fal · Body `{ "prompt", "purpose": "recap"|"avatar" }` → `{ "imageUrl" }`

#### `POST /platform/attractions/{id}/enrich` (also alias Section 7.13)
**Upstream:** Firecrawl → `enrichedFacts`, `enrichmentStatus`

---

### 7.10 Reports & announcements & notifications

#### `POST /reports`
```json
{
  "category": "violence",
  "contentType": "recap",
  "targetId": "pst_05",
  "postId": "pst_05",
  "notes": "Threatening language at the gate"
}
```
**201:** `{ "id": "rpt_01", "status": "open" }`

#### `GET /announcements`
#### `GET /notifications` / `POST /notifications/read` `{ "ids": ["…"] }` or `{ "all": true }`

---

### 7.11 Admin auth

#### `POST /admin/auth/login`
```json
{ "email": "superadmin@viseth.et", "password": "••••••••" }
```
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
Place admin: `"role":"place_admin","attractionId":"atr_adwa"`.

#### `POST /admin/auth/refresh` `{ "refreshToken" }`
#### `POST /admin/auth/logout`
#### `POST /admin/auth/change-password` `{ "currentPassword", "newPassword" }`
#### `GET /admin/me` / `PATCH /admin/me`

---

### 7.12 Attraction Admin — `/place/*`

All require `place_admin` JWT. Server scopes `attractionId`.

| Method | Path | Purpose / response highlights |
|---|---|---|
| GET | `/place/dashboard` | attraction, gross, commission, visitsToday, validTickets, recentScans[] |
| GET | `/place/visits` | paginated visits |
| GET | `/place/tickets` | `?status=` |
| GET | `/place/attraction` | site profile |
| PATCH | `/place/attraction` | `{ description?, coverImageUrl? }` only |
| GET | `/place/gatekeepers` | list |
| POST | `/place/gatekeepers` | `{ name, email, phone }` → creates gatekeeper user invite |
| PATCH | `/place/gatekeepers/{id}` | `{ active?, displayName? }` |
| GET | `/place/payouts` | |
| GET | `/place/revenue` | totals |
| GET | `/place/credentials` | prefix/metadata only |

**Dashboard response**
```json
{
  "attraction": { "id": "atr_adwa", "name": "…" },
  "gross": 22200.00,
  "commission": 2664.00,
  "partnerShare": 19536.00,
  "visitsToday": 18,
  "validTickets": 42,
  "recentScans": [
    { "visitorName": "Selam Tesfaye", "scannedAt": "2026-07-25T09:12:00Z", "type": "solo_ticket" }
  ]
}
```

---

### 7.13 Platform Admin — `/platform/*`

All require `super_admin`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/platform/overview` | KPIs + queues + chart series |
| GET/POST | `/platform/attractions` | list/create |
| GET/PATCH | `/platform/attractions/{id}` | read/update (price, geo, active fields allowed) |
| POST | `/platform/attractions/{id}/activate` | `{ "active": true\|false }` |
| POST | `/platform/attractions/{id}/enrich` | Firecrawl |
| GET/POST | `/platform/place-admins` | `{ name, email, phone, attractionId, temporaryPassword }` |
| PATCH | `/platform/place-admins/{id}` | |
| GET/PATCH | `/platform/guides` | approval: `{ "active", "verified" }` |
| GET | `/platform/recaps?status=` | moderation |
| POST | `/platform/recaps/{id}/keep` | |
| POST | `/platform/recaps/{id}/remove` | `{ "reason" }` required |
| GET | `/platform/social-reports` | filters status, category, page, pageSize |
| POST | `/platform/social-reports/{id}/resolve` | `{ status: actioned\|dismissed, resolutionNote, suspendUser? }` |
| GET | `/platform/revenue/by-attraction` | live totals |
| GET | `/platform/revenue/stream` | optional SSE |
| GET | `/platform/transactions` | ledger |
| GET | `/platform/payouts` | |
| POST | `/platform/payouts/{id}/hold` | `{ reason }` |
| POST | `/platform/payouts/{id}/release` | |
| POST | `/platform/payouts/{id}/mark-paid` | |
| GET | `/platform/support-cases` | |
| POST | `/platform/support-cases/{id}/status` | `{ status, resolution? }` |
| GET/PUT | `/platform/settings` | commercial + maintenance |
| GET/PATCH | `/platform/feature-flags/{key}` | `{ enabled, rollout }` |
| GET/POST | `/platform/announcements` | |
| GET/POST | `/platform/api-credentials` | issue (secret once) |
| POST | `/platform/api-credentials/{id}/rotate` | secret once |
| POST | `/platform/api-credentials/{id}/revoke` | |
| GET | `/platform/integrations` | |
| POST | `/platform/integrations/{id}/recheck` | |
| GET/PUT | `/platform/gamification/…` | see 7.7 |
| GET | `/platform/audit-log` | |
| GET | `/platform/exports/sites.csv` | |
| GET | `/platform/exports/payments.csv` | |
| GET | `/platform/exports/social-reports.csv` | |
| GET | `/platform/exports/audit.csv` | |

**Overview response**
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
    "openSocialReports": 5,
    "guidesPending": 2
  },
  "visitsByDay": [{ "date": "2026-07-12", "visits": 12 }],
  "revenueByAttraction": [{ "attractionId": "atr_adwa", "name": "…", "gross": 22200.00 }]
}
```

**Create attraction body**
```json
{
  "name": "Sof Omar Cave",
  "amharicName": "…",
  "address": "Bale Zone, Oromia",
  "region": "Oromia",
  "category": "natural",
  "description": "…",
  "summary": "…",
  "lat": 6.9,
  "lng": 40.85,
  "ticketPrice": 200.00,
  "openHours": "08:00–17:00",
  "isUnesco": false,
  "tags": ["cave"],
  "active": true
}
```

---

## 8. Third-party integrations (exact duties)

| Service | Called by | When | Purpose | Secrets |
|---|---|---|---|---|
| **Chapa** | Custom API | checkout, webhook, refund, verify | Ticket / gift / booking / hotel pay | `CHAPA_SECRET_KEY`, webhook secret |
| **Firebase Auth** | Apps + Admin SDK | identity | Login; verify ID tokens server-side | service account |
| **Firecrawl** | Custom API | Super Admin enrich | Fill `enrichedFacts` | server env |
| **Whisperflow** | `/ai/transcribe` | Recap voice | Speech → text | server env |
| **ElevenLabs** | `/ai/tts` | Read-aloud | Text → audio URL | server env |
| **Fal** | `/ai/image` | Recap/avatar | Image gen | server env |
| **Google Maps** | Platform Admin **frontend only** | Pin picker | Geocode | `VITE_GOOGLE_MAPS_API_KEY` — backend stores lat/lng only |
| **SMS (optional)** | Custom API | After gift success | Deliver keycode | server env; if absent, UI-only keycode |
| **Object storage** | Custom API | media upload | Images/video | S3/GCS/Firebase Storage |
| **Live streaming SDK** | Client only if flag | backlog | Not backend MVP |

### Chapa requirements
- Verify webhook signature.  
- Idempotent on `reference`.  
- Map to `pending|succeeded|failed`.  
- Sandbox keys in staging only.

### AI proxy requirements
- Enforce feature flags + rollout %.  
- Timeout 30s → `502` `UPSTREAM_TIMEOUT` / `UPSTREAM_ERROR`.  
- Strip PII from logs; delete raw audio within 24h.

---

## 9. Authz matrix (quick)

| Action | traveler | guide | gatekeeper | place_admin | super_admin |
|---|---|---|---|---|---|
| Browse attractions | Y | Y | Y | via place | Y |
| Checkout ticket/gift | Y | — | — | — | — |
| Scan verify | — | — | Y (scoped) | — | — |
| Passport /me | Y | Y | Y | — | — |
| Guide bookings inbox | — | Y | — | — | — |
| Place dashboard | — | — | — | Y (own) | — |
| Refund / enrich / flags | — | — | — | — | Y |
| AI proxies | Y | Y (avatar) | — | — | — |

---

## 10. Jobs & schedulers

| Job | Schedule | Action |
|---|---|---|
| Expire tickets/gifts | hourly | → `expired` |
| Monthly payouts | `payoutDay` 00:05 Africa/Addis_Ababa | create payout rows |
| Integration health | every 5–15 min | ping vendors |
| Streak risk notify | daily | optional backlog |

---

## 11. Non-functional

- p95 scan verify < 800ms server time.  
- Checkout init < 2s excluding Chapa redirect.  
- Rate limit: scan 30/min/device; AI 10/min/user; login 10/min/IP; checkout 20/min/user.  
- Structured logs: requestId, userId, attractionId.  
- CORS for admin web origins only.

---

## 12. Seed data (demo)

- ≥5 attractions across ≥3 regions (Adwa, Lalibela, Harar, Gondar, Aksum, Sof Omar).  
- Super Admin `superadmin@viseth.et`.  
- ≥1 place admin per major site.  
- ≥1 gatekeeper on Harar for gift demo.  
- ≥1 active verified guide.  
- ≥3 hotels near seeded sites.  
- Seeded recaps (published + flagged) + open social reports in all 3 categories.  
- Streak tiers + follower titles seeded to PDF §9 defaults.

---

## 13. Acceptance checklist

- [ ] Traveler Chapa sandbox pay → `valid` ticket with `qrPayload`  
- [ ] Gatekeeper scan solo → one name + visit + passport update  
- [ ] Gift: pay N names → keycode → scan lists all names + sender + greeting  
- [ ] Passport: visits, heritageScore, streak badge, title  
- [ ] Recap: text + Whisperflow + ElevenLabs audioUrl  
- [ ] Firecrawl enrich visible on attraction detail  
- [ ] Place Admin sees only own site  
- [ ] Super Admin: attractions, place admins, guides, moderation, reports, revenue, support, flags, keys, audit CSV  
- [ ] Maintenance blocks pay + scan  
- [ ] Webhooks idempotent; refunds void unused tickets  
- [ ] No vendor secrets in any client  
- [ ] Multi-guest ticket amount = price × guests  
- [ ] Feed + nearby endpoints respond for customer UI  

---

## 14. Explicit decisions (do not ask)

| Topic | Decision |
|---|---|
| Gift redeem | One scan redeems **all remaining** names |
| Solo multi-guest | One QR; one visit for holderName; `guests` is metadata |
| Heritage score | customer_app weighted formula (55/30/15) |
| Ticket pricing owner | Super Admin only |
| QR format | Opaque HMAC from API |
| Social auto-flag | 3 reports → `flagged` |
| Emperor title | Never; cap at Ras |
| Streaming / chat | Out of backend MVP |
| Hotels | Soft-book endpoints included; payment optional |
| Admin traveler CRUD | Not required |
| Payment methods UI (telebirr/CBE) | Client labels only; **server always uses Chapa** for MVP sandbox |

---

## 15. Suggested build order (hackathon)

1. Auth verify + `GET/PATCH /me` + `GET /config`  
2. Attractions CRUD (platform) + public list/detail + Firecrawl enrich  
3. Chapa ticket checkout + webhook + `GET /tickets/mine`  
4. `POST /scans/verify` + visits + passport recompute  
5. Gift checkout + keycode + gift scan path  
6. Guides + bookings  
7. Recaps + AI proxies  
8. Place admin routes  
9. Platform overview, revenue, moderation, reports, settings  
10. Feed, nearby, hotels, notifications (UI parity)

---

*End of Backend Technical Specification v2.0*
