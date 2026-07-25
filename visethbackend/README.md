# Viseth Backend

Custom API for Customer, Staff, Attraction Admin, and Platform Admin.

- **Payments: Telebirr** (Fabric H5 C2B) — not Chapa  
- **Auth:** Firebase ID tokens (mobile) · Admin JWT (web)  
- **DB:** Firestore via Firebase Admin  
- **Host:** Render (`render.yaml`)

## Docs for client teams (Cursor AI)

→ **[INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md)** — full contract, prompts, Telebirr flow, every surface.

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

Notify URL (set after deploy): `{BASE_URL}/v1/webhooks/telebirr`

**Never commit** `secrets/`, `*.pem`, or service-account JSON.

## Render

In this monorepo, set **Root Directory** to `visethbackend` (already in `render.yaml`).

1. Build: `npm install --include=dev && npm run build`  
2. Start: `npm run start` (not yarn)  
3. Health: `/v1/health`  
4. Set `FIREBASE_SERVICE_ACCOUNT_JSON`, Telebirr vars (`TELEBIRR_PRIVATE_KEY` as PEM with `\n`), `BASE_URL`, JWT/QR secrets, `CORS_ORIGINS`  
5. Whitelist Render outbound IP in Telebirr portal if sandbox requires it  
6. `npm run seed` once from this folder  

## Seeded admins

| Role | Email | Password |
|---|---|---|
| Super Admin | `superadmin@viseth.et` | `VisethAdmin2026!` |
| Place Admin (Harar) | `harar.admin@viseth.et` | same |

Dev Flutter: `Authorization: Bearer dev:usr_seed_traveler`
