# Viseth Platform Super Admin — Integration Guide (Cursor-ready)

**Audience:** Platform Admin web (React)  
**Live API base:** `https://viseth.onrender.com/v1`  
**Origin:** `https://viseth.onrender.com`  
**Auth:** Admin JWT (`super_admin`)  
**Payments:** Telebirr (list/refund via API; never call Telebirr from the browser)  
**Full contract:** [`INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md)

Paste into Cursor: *“Integrate Platform Super Admin using PLATFORM_ADMIN_INTEGRATION.md. Base URL https://viseth.onrender.com/v1”*

---

## 1. Configure

```env
VITE_VISETH_API_BASE=https://viseth.onrender.com/v1
```

Health: `GET https://viseth.onrender.com/v1/health`  
Root: [https://viseth.onrender.com/](https://viseth.onrender.com/)

---

## 2. Headers

```http
Authorization: Bearer <accessToken>
Content-Type: application/json
Accept: application/json
X-Client: platform_admin
```

---

## 3. Login

```http
POST https://viseth.onrender.com/v1/admin/auth/login
```

```json
{ "email": "superadmin@viseth.et", "password": "VisethAdmin2026!" }
```

(Use `SEED_ADMIN_PASSWORD` if changed at seed time.)

**200** → `admin.role === "super_admin"`, `admin.attractionId === null`

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

- Refresh: `POST /admin/auth/refresh` `{ "refreshToken" }`  
- Logout: `POST /admin/auth/logout`  
- Me: `GET /admin/me`

---

## 4. Platform surfaces

```http
GET  /platform/overview
GET  /platform/analytics
GET  /platform/attractions
POST /platform/attractions
POST /platform/attractions/{id}/enrich
POST /platform/attraction-admins
GET  /platform/place-admins
GET  /platform/guides
PATCH /platform/guides/{id}
GET  /platform/transactions
GET  /platform/moderation/reports
POST /platform/posts/{id}/moderate
GET  /platform/settings
PUT  /platform/settings
GET  /platform/feature-flags
PATCH /platform/feature-flags/{key}
GET  /platform/integrations
GET  /platform/audit-logs
```

### Moderate post

```json
{ "action": "remove" | "keep" | "dismiss", "reason": "optional" }
```

### Refund (Telebirr / mock)

```http
POST /payments/{transactionId}/refund
{ "reason": "…" }
```

---

## 5. Create place admin

```http
POST /platform/attraction-admins
```

```json
{
  "email": "gondar.admin@viseth.et",
  "displayName": "Gondar Admin",
  "attractionId": "atr_gondar",
  "password": "…"
}
```

Place admins then log in via the same `/admin/auth/login` and are scoped to one attraction.

---

## 6. Seeded demo

| Account | Email | Password |
|---|---|---|
| Super Admin | `superadmin@viseth.et` | `VisethAdmin2026!` |
| Place Admin (Harar) | `harar.admin@viseth.et` | same |

Demo attractions: `atr_adwa`, `atr_lalibela`, `atr_harar`, `atr_gondar`, `atr_aksum`, `atr_sofomar`.

If login fails on a fresh deploy, run seed once against production Firestore (`npm run seed` with prod Firebase env).

---

## 7. Do not

- Embed Telebirr Fabric secrets or Firebase service-account JSON in the SPA  
- Call Telebirr / Chapa / AI vendors from the browser  
- Bypass API for attraction price/name policy  

---

## 8. Quick test

```bash
curl https://viseth.onrender.com/v1/health
curl -X POST https://viseth.onrender.com/v1/admin/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"superadmin@viseth.et\",\"password\":\"VisethAdmin2026!\"}"
```
