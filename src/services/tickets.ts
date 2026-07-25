import { db } from '../config/firebase';
import type { GiftDoc, TicketDoc } from '../types';
import { getAttraction } from './attractions';
import { forbidden, notFound } from '../utils/errors';
import { getUser } from './users';

export async function listMyTickets(
  userId: string,
  statusFilter?: string,
): Promise<Array<Record<string, unknown>>> {
  const snap = await db().collection('tickets').where('purchaserUserId', '==', userId).get();
  const held = await db().collection('tickets').where('holderUserId', '==', userId).get();
  const map = new Map<string, TicketDoc>();
  for (const d of [...snap.docs, ...held.docs]) {
    map.set(d.id, d.data() as TicketDoc);
  }
  let tickets = [...map.values()].filter((t) => t.status !== 'pending_payment');
  if (statusFilter && statusFilter !== 'all') {
    tickets = tickets.filter((t) => t.status === statusFilter);
  }
  tickets.sort((a, b) => (b.purchasedAt ?? '').localeCompare(a.purchasedAt ?? ''));

  const user = await getUser(userId);
  const items: Record<string, unknown>[] = [];
  for (const t of tickets) {
    const attraction = await getAttraction(t.attractionId, { allowInactive: true });
    items.push({
      id: t.id,
      status: t.status,
      holderName: t.holderName,
      guests: t.guests,
      visitDate: t.visitDate,
      amount: t.amount,
      code: t.code,
      qrPayload: t.qrPayload,
      giftedBy: t.giftId ? t.purchaserName : null,
      giftKeycode: null,
      attraction: {
        id: attraction.id,
        name: attraction.name,
        region: attraction.region,
        amharicName: attraction.amharicName,
      },
      purchasedAt: t.purchasedAt,
      expiresAt: t.expiresAt,
      isFirstPurchaseCelebrationEligible:
        !user.hasCompletedFirstPurchase && t.status === 'valid',
    });
  }
  return items;
}

export async function getTicketForOwner(ticketId: string, userId: string) {
  const snap = await db().collection('tickets').doc(ticketId).get();
  if (!snap.exists) throw notFound('Ticket not found');
  const t = snap.data() as TicketDoc;
  if (t.purchaserUserId !== userId && t.holderUserId !== userId) throw forbidden();
  const attraction = await getAttraction(t.attractionId, { allowInactive: true });
  const user = await getUser(userId);
  return {
    id: t.id,
    status: t.status,
    holderName: t.holderName,
    guests: t.guests,
    visitDate: t.visitDate,
    amount: t.amount,
    code: t.code,
    qrPayload: t.qrPayload,
    giftedBy: t.giftId ? t.purchaserName : null,
    giftKeycode: null,
    attraction: {
      id: attraction.id,
      name: attraction.name,
      region: attraction.region,
      amharicName: attraction.amharicName,
    },
    purchasedAt: t.purchasedAt,
    expiresAt: t.expiresAt,
    isFirstPurchaseCelebrationEligible:
      !user.hasCompletedFirstPurchase && t.status === 'valid',
  };
}

export async function listMyGifts(userId: string) {
  const snap = await db().collection('gifts').where('senderUserId', '==', userId).get();
  const gifts = snap.docs
    .map((d) => d.data() as GiftDoc)
    .filter((g) => g.status !== 'pending_payment')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const items: Record<string, unknown>[] = [];
  for (const g of gifts) {
    const attraction = await getAttraction(g.attractionId, { allowInactive: true });
    items.push({
      id: g.id,
      keycode: g.keycode,
      status: g.status,
      recipientNames: g.recipientNames,
      greeting: g.greeting,
      visitDate: g.visitDate,
      recipientsTotal: g.recipientsTotal,
      redeemedCount: g.redeemedCount,
      attraction: {
        id: attraction.id,
        name: attraction.name,
        region: attraction.region,
      },
      createdAt: g.createdAt,
      expiresAt: g.expiresAt,
    });
  }
  return { items };
}
