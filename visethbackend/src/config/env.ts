import dotenv from 'dotenv';
import path from 'path';

dotenv.config();
// Also load monorepo-root .env when running from visethbackend/visethbackend
dotenv.config({ path: path.resolve(process.cwd(), '../.env') });

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

const telebirrFabricAppId = process.env.TELEBIRR_FABRIC_APP_ID ?? '';
const telebirrAppSecret = process.env.TELEBIRR_APP_SECRET ?? '';
const telebirrMerchantAppId = process.env.TELEBIRR_MERCHANT_APP_ID ?? '';
const telebirrShortCode = process.env.TELEBIRR_SHORT_CODE ?? '';
const telebirrConfigured = Boolean(
  telebirrFabricAppId && telebirrAppSecret && telebirrMerchantAppId && telebirrShortCode,
);

export const env = {
  port: Number(process.env.PORT ?? 8080),
  host: process.env.HOST ?? '0.0.0.0',
  nodeEnv: process.env.NODE_ENV ?? 'development',
  baseUrl: process.env.BASE_URL ?? 'http://localhost:8080',
  firebaseServiceAccountPath: path.resolve(
    process.cwd(),
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH ??
      './viseth-hackathon-firebase-adminsdk-fbsvc-0a5622b086.json',
  ),
  firebaseStorageBucket: process.env.FIREBASE_STORAGE_BUCKET ?? '',
  jwtAccessSecret: required(
    'JWT_ACCESS_SECRET',
    'dev-access-secret-change-in-prod-32chars',
  ),
  jwtRefreshSecret: required(
    'JWT_REFRESH_SECRET',
    'dev-refresh-secret-change-in-prod-32chars',
  ),
  jwtAccessTtlSeconds: Number(process.env.JWT_ACCESS_TTL_SECONDS ?? 900),
  jwtRefreshTtlSeconds: Number(process.env.JWT_REFRESH_TTL_SECONDS ?? 2_592_000),
  qrHmacSecret: required(
    'QR_HMAC_SECRET',
    'dev-qr-hmac-secret-change-in-prod-32chars',
  ),

  // Telebirr (primary payment provider)
  telebirrMode: (process.env.TELEBIRR_MODE ?? 'sandbox') as
    | 'simulate'
    | 'sandbox'
    | 'production',
  telebirrFabricAppId,
  telebirrAppSecret,
  telebirrMerchantAppId,
  telebirrShortCode,
  telebirrPrivateKey: process.env.TELEBIRR_PRIVATE_KEY ?? '',
  telebirrPrivateKeyPath:
    process.env.TELEBIRR_PRIVATE_KEY_PATH ?? './secrets/telebirr_private.pem',
  telebirrNotifyUrl: process.env.TELEBIRR_NOTIFY_URL ?? '',
  telebirrRedirectUrl: process.env.TELEBIRR_REDIRECT_URL ?? '',
  telebirrConfigured,
  /** Mock checkout when Telebirr is not configured or TELEBIRR_MOCK=true */
  isMockPayments:
    process.env.TELEBIRR_MOCK === 'true' ||
    !telebirrConfigured ||
    process.env.PAYMENTS_MODE === 'mock',

  firecrawlApiKey: process.env.FIRECRAWL_API_KEY ?? '',
  whisperflowApiKey: process.env.WHISPERFLOW_API_KEY ?? '',
  elevenLabsApiKey: process.env.ELEVENLABS_API_KEY ?? '',
  elevenLabsVoiceId: process.env.ELEVENLABS_VOICE_ID ?? '',
  falApiKey: process.env.FAL_API_KEY ?? '',
  /** Cultural For You ranking + NSFW/non-cultural moderation (FastAPI) */
  culturalAiBaseUrl: process.env.CULTURAL_AI_BASE_URL ?? '',
  culturalAiServiceKey:
    process.env.CULTURAL_AI_SERVICE_KEY ?? 'viseth-ai-service-dev-key-change-in-prod',
  corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173,http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  seedAdminPassword: process.env.SEED_ADMIN_PASSWORD ?? 'VisethAdmin2026!',
  /**
   * Allow `Authorization: Bearer dev:<userId|role>` for Flutter/hackathon demos.
   * Defaults on when payments are mock so Render staging works without Firebase client config.
   */
  allowDevAuth:
    process.env.ALLOW_DEV_AUTH === 'true' ||
    process.env.ALLOW_DEV_AUTH === '1' ||
    process.env.TELEBIRR_MOCK === 'true' ||
    process.env.PAYMENTS_MODE === 'mock' ||
    !telebirrConfigured,
};
