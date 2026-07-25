# Viseth Staff App — Integration Guide (Cursor-ready)

**Audience:** Staff Flutter app (gatekeeper + guide)  
**Live API base:** `https://viseth.onrender.com/v1`  
**Origin:** `https://viseth.onrender.com`  
**Payments:** Telebirr (server-side only — staff never pays)  
**Auth:** Firebase ID token  
**Full contract:** [`INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md)

Paste into Cursor: *“Integrate the Staff app using STAFF_INTEGRATION.md. Base URL https://viseth.onrender.com/v1”*

---

## 1. Configure

```bash
# Flutter
flutter run --dart-define=VISETH_API_BASE=https://viseth.onrender.com/v1
```

```dart
const apiBase = String.fromEnvironment(
  'VISETH_API_BASE',
  defaultValue: 'https://viseth.onrender.com/v1',
);
```

Health check: `GET https://viseth.onrender.com/v1/health`

---

## 2. Headers

```http
Authorization: Bearer <firebase_id_token>
Content-Type: application/json
Accept: application/json
X-Client: staff
```

Dev shortcut (seeded API only):

```http
Authorization: Bearer dev:gatekeeper
Authorization: Bearer dev:guide
```

---

## 3. Session bootstrap

1. Firebase Auth sign-in  
2. `token = await user.getIdToken()`  
3. `GET /me`  
4. `GET /staff/me` → `{ role, attractionIds, mustChangePassword, … }`  
5. Route UI by `role`: `gatekeeper` | `guide`

Optional aliases: `GET /auth/session`, `GET /auth/me`.

If `mustChangePassword`, force password change before gate tools.

---

## 4. Gatekeeper — verify ticket / gift

```http
POST https://viseth.onrender.com/v1/visits/verify
# alias: POST /scans/verify
```

```json
{
  "code": "<qrPayload OR gift keycode e.g. HRR-4821>",
  "attractionId": "atr_harar"
}
```

**Success 200**

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

**Failure 422** → show `errorMessage` calmly (no shake):

| errorCode | Meaning |
|---|---|
| `ALREADY_USED` | Already scanned |
| `EXPIRED` | Past expiry |
| `INVALID_CODE` | Bad QR / keycode |
| `WRONG_ATTRACTION` | Wrong site |
| `MAINTENANCE` | Platform blocked |

UX: camera scan of **`qrPayload` only** + manual keycode entry.

### Gate desk

```http
GET /staff/gate/today
GET /staff/gate/expected
```

---

## 5. Guide — bookings

```http
GET /guides/me/bookings
PATCH /bookings/{id}
{ "status": "confirmed" | "declined" | "completed" }
PATCH /guides/me
```

---

## 6. Do not

- Call Telebirr / Chapa / AI vendors from the staff app  
- Invent QR payloads or accept unsigned tickets  
- Create Auth users from the client  
- Hardcode secrets  

---

## 7. Quick test

```bash
curl https://viseth.onrender.com/v1/health
curl -H "Authorization: Bearer dev:gatekeeper" \
  -H "Content-Type: application/json" \
  -H "X-Client: staff" \
  https://viseth.onrender.com/v1/staff/me
```
