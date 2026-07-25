import crypto from 'crypto';
import { env } from '../config/env';

export type QrClaims = {
  ticketId: string;
  attractionId: string;
  exp: number;
};

export function signQrPayload(claims: QrClaims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', env.qrHmacSecret)
    .update(body)
    .digest('base64url');
  return `vise1.${body}.${sig}`;
}

export function verifyQrPayload(payload: string): QrClaims | null {
  const parts = payload.split('.');
  if (parts.length !== 3 || parts[0] !== 'vise1') return null;
  const [, body, sig] = parts;
  const expected = crypto
    .createHmac('sha256', env.qrHmacSecret)
    .update(body)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as QrClaims;
    if (!claims.ticketId || !claims.attractionId || !claims.exp) return null;
    return claims;
  } catch {
    return null;
  }
}
