# Viseth Attraction Place Admin — Integration Guide (Cursor-ready)

**Audience:** Attraction / Place Admin web (React)  
**Live API base:** `https://viseth.onrender.com/v1`  
**Origin:** `https://viseth.onrender.com`  
**Auth:** Admin JWT (`place_admin`) — not Firebase  
**Payments:** Telebirr (view sales via API; never call Telebirr from the browser)  
**Full contract:** [`INTEGRATION_GUIDE.md`](./INTEGRATION_GUIDE.md)

Paste into Cursor: *“Integrate Attraction Place Admin using ATTRACTION_ADMIN_INTEGRATION.md. Base URL https://viseth.onrender.com/v1”*

---

## 1. Configure

```env
VITE_VISETH_API_BASE=https://viseth.onrender.com/v1
```

Health: `GET https://viseth.onrender.com/v1/health`

---

## 2. Headers

```http
Authorization: Bearer <accessToken>
Content-Type: application/json
Accept: application/json
X-Client: attraction_admin
```

---

## 3. Login

```http
POST https://viseth.onrender.com/v1/admin/auth/login
```

```json
{ "email": "harar.admin@viseth.et", "password": "VisethAdmin2026!" }
```

(Use `SEED_ADMIN_PASSWORD` if you changed it when seeding.)

**200**

```json
{
  "accessToken": "eyJ…",
  "refreshToken": "eyJ…",
  "expiresIn": 900,
  "admin": {
    "id": "au_…",
    "email": "harar.admin@viseth.et",
    "displayName": "…",
    "role": "place_admin",
    "attractionId": "atr_harar"
  }
}
```

- Store `accessToken` + `refreshToken`  
- Route dashboard using `admin.attractionId`  
- Refresh: `POST /admin/auth/refresh` `{ "refreshToken" }`  
- Logout: `POST /admin/auth/logout`  
- Me: `GET /admin/me` or `GET /auth/me`

**Never send `attractionId` overrides on mutations** — server scopes from JWT.

Aliases: `POST /auth/session`, `GET /auth/me`.

---

## 4. Dashboard / sales

```http
GET /admin/attractions/{attractionId}
GET /admin/attractions/{attractionId}/summary?days=30
GET /admin/attractions/{attractionId}/visits
GET /admin/attractions/{attractionId}/tickets?status=paid
GET /admin/attractions/{attractionId}/tickets.csv
GET /admin/notifications
```

Older aliases: `GET /place/dashboard`, `/place/visits`, `/place/tickets`.

---

## 5. Listing settings

```http
GET /admin/attractions/{attractionId}
PATCH /admin/attractions/{attractionId}
```

```json
{ "description": "…", "coverImageUrl": "…" }
```

English name / ticket price changes are blocked server-side for place admins.

```http
POST /admin/attractions/{attractionId}/cover
# multipart field: file
```

---

## 6. Gatekeepers / guides

```http
GET /admin/gatekeepers
POST /admin/gatekeepers
POST /admin/gatekeepers/{id}/active  { "active": false }

GET /admin/guides
POST /admin/guides
POST /admin/guides/{id}/status  { "status": "suspended" | "active" }
```

Staff Auth users are **created by this API** — never `createUserWithEmailAndPassword` in the browser.

---

## 7. Do not

- Put Telebirr / Firebase Admin / JWT secrets in the SPA  
- Call Telebirr or Chapa from the client  
- Trust client-side role checks alone — always use API 403s  

---

## 8. Quick test

```bash
curl -X POST https://viseth.onrender.com/v1/admin/auth/login \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"harar.admin@viseth.et\",\"password\":\"VisethAdmin2026!\"}"
```
