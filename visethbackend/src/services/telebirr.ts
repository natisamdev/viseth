import fs from 'fs';
import path from 'path';
import { C2B } from 'telebirr-nodejs';
import { env } from '../config/env';
import { upstream } from '../utils/errors';

export type TelebirrInitResult = {
  checkoutUrl: string;
  reference: string;
  provider: 'telebirr';
};

let client: C2B | null = null;

function loadPrivateKey(): string {
  if (env.telebirrPrivateKey.trim()) {
    return env.telebirrPrivateKey.replace(/\\n/g, '\n');
  }
  const keyPath = path.resolve(process.cwd(), env.telebirrPrivateKeyPath);
  if (!fs.existsSync(keyPath)) {
    throw new Error(
      `Telebirr private key missing. Set TELEBIRR_PRIVATE_KEY or place PEM at ${keyPath}`,
    );
  }
  return fs.readFileSync(keyPath, 'utf8');
}

function getClient(redirectUrl?: string): C2B {
  if (!env.telebirrConfigured) {
    throw upstream('Telebirr is not configured', 'PAYMENT_NOT_CONFIGURED');
  }

  // Recreate when redirect URL differs (per-checkout return URL)
  const notifyUrl = env.telebirrNotifyUrl || `${env.baseUrl}/v1/webhooks/telebirr`;
  const redirect = redirectUrl || env.telebirrRedirectUrl || `${env.baseUrl}/v1/payments/return`;

  client = new C2B({
    mode: env.telebirrMode,
    appId: env.telebirrFabricAppId,
    appSecret: env.telebirrAppSecret,
    merchantAppId: env.telebirrMerchantAppId,
    merchantCode: env.telebirrShortCode,
    privateKey: loadPrivateKey(),
    notifyUrl,
    redirectUrl: redirect,
    http: env.telebirrMode !== 'production',
  });
  return client;
}

export async function initializePayment(input: {
  amount: number;
  title: string;
  reference: string;
  returnUrl: string;
  callbackInfo?: string;
}): Promise<TelebirrInitResult> {
  if (env.isMockPayments) {
    return {
      checkoutUrl: `${env.baseUrl}/v1/payments/mock-checkout?tx_ref=${input.reference}`,
      reference: input.reference,
      provider: 'telebirr',
    };
  }

  try {
    const c2b = getClient(input.returnUrl);
    const checkoutUrl = await c2b.checkout({
      merchOrderId: input.reference,
      title: input.title.slice(0, 120),
      amount: input.amount.toFixed(2),
      callbackInfo: input.callbackInfo ?? 'viseth',
    });

    if (!checkoutUrl || typeof checkoutUrl !== 'string') {
      throw upstream('Telebirr did not return a checkout URL');
    }

    return {
      checkoutUrl,
      reference: input.reference,
      provider: 'telebirr',
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e);
    console.error('Telebirr initialize failed:', msg);
    throw upstream(`Telebirr initialize failed: ${msg}`, 'UPSTREAM_ERROR');
  }
}

export async function verifyPayment(
  reference: string,
): Promise<'succeeded' | 'failed' | 'pending'> {
  if (env.isMockPayments) return 'succeeded';

  try {
    const c2b = getClient();
    const result = await c2b.queryOrder(reference);
    if (!result || typeof result === 'undefined') return 'pending';

    const status = String(result.biz_content?.order_status ?? '').toUpperCase();
    if (status === 'PAY_SUCCESS') return 'succeeded';
    if (status === 'PAY_FAILED' || status === 'ORDER_CLOSED') return 'failed';
    return 'pending';
  } catch (e) {
    console.error('Telebirr queryOrder failed:', e);
    throw upstream('Telebirr verify failed');
  }
}

export async function refundPayment(
  reference: string,
  amount: number,
  reason: string,
): Promise<void> {
  if (env.isMockPayments) return;

  try {
    const c2b = getClient();
    const refundRequestNo = `RFD${Date.now()}`;
    const result = await c2b.refundOrder({
      merchOrderId: reference,
      refundRequestNo,
      amount: amount.toFixed(2),
      refundReason: reason.slice(0, 80),
    });
    const status = String(result?.biz_content?.refund_status ?? '').toUpperCase();
    if (status && status !== 'REFUND_SUCCESS' && status !== 'REFUNDING') {
      throw upstream(`Telebirr refund status: ${status}`);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : JSON.stringify(e);
    throw upstream(`Telebirr refund failed: ${msg}`);
  }
}

/** Parse Telebirr notify callback body (form or JSON). */
export function parseNotifyPayload(body: unknown): {
  merchOrderId: string | null;
  tradeStatus: string | null;
  raw: Record<string, unknown>;
} {
  const raw = (body ?? {}) as Record<string, unknown>;
  // Telebirr may nest under biz_content or flatten
  const biz =
    typeof raw.biz_content === 'string'
      ? (JSON.parse(raw.biz_content) as Record<string, unknown>)
      : ((raw.biz_content as Record<string, unknown>) ?? raw);

  const merchOrderId = String(
    biz.merch_order_id ?? raw.merch_order_id ?? raw.merchOrderId ?? '',
  ) || null;
  const tradeStatus = String(
    biz.trade_status ?? biz.order_status ?? raw.trade_status ?? raw.order_status ?? '',
  ) || null;

  return { merchOrderId, tradeStatus, raw };
}

export function isSuccessStatus(status: string | null): boolean {
  if (!status) return false;
  const s = status.toUpperCase();
  return s === 'PAY_SUCCESS' || s === 'SUCCESS' || s === 'Completed'.toUpperCase();
}
