# Viseth Backend

Custom API for Customer, Staff, Attraction Admin, and Platform Admin.

- **Payments: Telebirr** (Fabric H5 C2B) — not Chapa  
- **Auth:** Firebase ID tokens (mobile) · Admin JWT (web)  
- **DB:** Firestore via Firebase Admin  
- **Host:** Render (`render.yaml`)

## Live API

**Base:** `https://viseth.onrender.com/v1`  
**Health:** https://viseth.onrender.com/v1/health  
**Origin:** https://viseth.onrender.com/

Set server env `BASE_URL=https://viseth.onrender.com` on Render.

## Docs for client teams (Cursor AI)

| Team | Guide |
|---|---|
| All surfaces | [INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md) |
| Staff (gatekeeper + guide) | [STAFF_INTEGRATION.md](./STAFF_INTEGRATION.md) |
| Attraction Place Admin | [ATTRACTION_ADMIN_INTEGRATION.md](./ATTRACTION_ADMIN_INTEGRATION.md) |
| Platform Super Admin | [PLATFORM_ADMIN_INTEGRATION.md](./PLATFORM_ADMIN_INTEGRATION.md) |

## Quick start

```bash
npm install
# Ensure secrets/telebirr_private.pem exists (gitignored)
npm run seed
npm run dev
```

Health: `GET http://localhost:8080/v1/health`

## Telebirr env

| Variable | Meaning |
|---|---|
| `TELEBIRR_FABRIC_APP_ID` | Fabric App ID (UUID) |
| `TELEBIRR_APP_SECRET` | App Secret |
| `TELEBIRR_MERCHANT_APP_ID` | Merchant App ID |
| `TELEBIRR_SHORT_CODE` | ShortCode / merch_code |
| `TELEBIRR_PRIVATE_KEY_PATH` | Path to PEM (or use `TELEBIRR_PRIVATE_KEY`) |
| `TELEBIRR_MODE` | `sandbox` \| `production` \| `simulate` |
| `TELEBIRR_MOCK` | `true` = local mock checkout without Telebirr |

Notify URL: `https://viseth.onrender.com/v1/webhooks/telebirr`

**Never commit** `secrets/`, `*.pem`, or service-account JSON.

## Render

In this monorepo, set **Root Directory** to `visethbackend` (already in `render.yaml`).

**Render settings (do not swap these):**

| Field | Value |
|---|---|
| Root Directory | `visethbackend` |
| Build Command | `npm install` |
| Start Command | `npm start` |

- Build must finish and exit. Never put `npm start` in Build (that hangs the deploy).
- Start runs `tsx src/index.ts` — no `dist/` folder required.
- Health: `/v1/health`
- Set `BASE_URL=https://viseth.onrender.com`  
- Set `FIREBASE_SERVICE_ACCOUNT_JSON`, Telebirr vars (`TELEBIRR_PRIVATE_KEY` as PEM with `\n`), JWT/QR secrets, `CORS_ORIGINS`  
- Whitelist Render outbound IP in Telebirr portal if sandbox requires it  
- `npm run seed` once from this folder against prod Firebase if needed  

## Seeded admins

| Role | Email | Password |
|---|---|---|
| Super Admin | `superadmin@viseth.et` | `VisethAdmin2026!` |
| Place Admin (Harar) | `harar.admin@viseth.et` | same |

Dev Flutter: `Authorization: Bearer dev:usr_seed_traveler`
