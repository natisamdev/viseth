import { db } from '../config/firebase';
import { nowIso } from '../utils/time';
import type { GiftDoc, TicketDoc } from '../types';

/** Expire valid tickets / active gifts past expiresAt. Call from cron or Render cron job. */
export async function expireTicketsAndGifts(): Promise<{ tickets: number; gifts: number }> {
  const now = new Date();
  let tickets = 0;
  let gifts = 0;

  const ticketSnap = await db().collection('tickets').where('status', '==', 'valid').get();
  for (const doc of ticketSnap.docs) {
    const t = doc.data() as TicketDoc;
    if (t.expiresAt && new Date(t.expiresAt) < now) {
      await doc.ref.set({ status: 'expired', updatedAt: nowIso() }, { merge: true });
      tickets += 1;
    }
  }

  const giftSnap = await db().collection('gifts').where('status', '==', 'active').get();
  for (const doc of giftSnap.docs) {
    const g = doc.data() as GiftDoc;
    if (g.expiresAt && new Date(g.expiresAt) < now) {
      await doc.ref.set({ status: 'expired' }, { merge: true });
      gifts += 1;
    }
  }

  return { tickets, gifts };
}
