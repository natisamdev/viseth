import { customAlphabet } from 'nanoid';

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
const nano = customAlphabet(alphabet, 10);

export function id(prefix: string): string {
  return `${prefix}_${nano()}`;
}

/** Merchant order id for Telebirr (alphanumeric, unique). */
export function paymentRef(): string {
  return `VST${customAlphabet('0123456789ABCDEF', 14)()}`;
}

/** @deprecated use paymentRef */
export function chapaRef(): string {
  return paymentRef();
}

export function ticketCode(attractionSlug: string): string {
  const slug = attractionSlug.toUpperCase().slice(0, 4).padEnd(4, 'X');
  const n = customAlphabet('0123456789', 4)();
  return `VSTH-${slug}-${n}`;
}

export function giftKeycode(siteSlug: string): string {
  const slug = siteSlug
    .replace(/[^a-zA-Z]/g, '')
    .toUpperCase()
    .slice(0, 3)
    .padEnd(3, 'X');
  const n = customAlphabet('0123456789', 4)();
  return `${slug}-${n}`;
}

export function attractionSlug(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9]+/g, '')
    .slice(0, 4)
    .toUpperCase() || 'SITE';
}
