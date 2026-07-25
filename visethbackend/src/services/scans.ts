import { db } from '../config/firebase';
import type { GiftDoc, TicketDoc, VisitDoc } from '../types';
import { id } from '../utils/ids';
import { nowIso } from '../utils/time';
import { forbidden, notFound } from '../utils/errors';
import { getAttraction } from './attractions';
import { assertNotMaintenance } from './settings';
import { verifyQrPayload } from '../utils/qr';
import { recomputeProgress } from './users';

export type ScanResult = {
  valid: boolean;
  type: 'solo_ticket' | 'gift_keycode' | null;
  names: string[];
  guests: number;
  attractionName: string;
  senderName: string | null;
  greeting: string | null;
  visitIds: string[];
  ticketId: string | null;
  giftId: string | null;
  errorCode?: string;
  errorMessage?: string;
};

function fail(
  attractionName: string,
  errorCode: string,
  errorMessage: string,
): ScanResult {
  return {
    valid: false,
    type: null,
    names: [],
    guests: 0,
    attractionName,
    senderName: null,
    greeting: null,
    visitIds: [],
    ticketId: null,
    giftId: null,
    errorCode,
    errorMessage,
  };
}

export async function verifyScan(input: {
  code: string;
  attractionId: string;
  gatekeeperUserId: string;
  gatekeeperAttractionIds: string[];
}): Promise<ScanResult> {
  try {
    await assertNotMaintenance();
  } catch {
    const attraction = await getAttraction(input.attractionId, { allowInactive: true }).catch(
      () => null,
    );
    return fail(attraction?.name ?? '', 'MAINTENANCE', 'Platform is in maintenance mode');
  }

  if (!input.gatekeeperAttractionIds.includes(input.attractionId)) {
    throw forbidden('Gatekeeper not assigned to this attraction');
  }

  const attraction = await getAttraction(input.attractionId, { allowInactive: true });
  const code = input.code.trim();

  // Gift keycode path: XXX-1234
  if (/^[A-Z]{3}-\d{4}$/i.test(code)) {
    return redeemGift(code.toUpperCase(), attraction.id, attraction.name, input.gatekeeperUserId);
  }

  // QR payload path
  const claims = verifyQrPayload(code);
  if (!claims) {
    // maybe raw ticket code display
    const byCode = await db().collection('tickets').where('code', '==', code).limit(1).get();
    if (!byCode.empty) {
      const ticket = byCode.docs[0].data() as TicketDoc;
      return redeemTicket(ticket, attraction.id, attraction.name, input.gatekeeperUserId);
    }
    return fail(attraction.name, 'INVALID_CODE', 'This code is not recognized.');
  }

  if (claims.exp * 1000 < Date.now()) {
    return fail(attraction.name, 'EXPIRED', 'This ticket has expired.');
  }

  const ticketSnap = await db().collection('tickets').doc(claims.ticketId).get();
  if (!ticketSnap.exists) {
    return fail(attraction.name, 'INVALID_CODE', 'This code is not recognized.');
  }
  const ticket = ticketSnap.data() as TicketDoc;
  return redeemTicket(ticket, attraction.id, attraction.name, input.gatekeeperUserId);
}

async function redeemTicket(
  ticket: TicketDoc,
  attractionId: string,
  attractionName: string,
  gatekeeperUserId: string,
): Promise<ScanResult> {
  if (ticket.attractionId !== attractionId) {
    return fail(attractionName, 'WRONG_ATTRACTION', 'This ticket is for a different site.');
  }
  if (ticket.status === 'used') {
    return fail(attractionName, 'ALREADY_USED', 'This ticket was already scanned.');
  }
  if (ticket.status === 'expired' || (ticket.expiresAt && new Date(ticket.expiresAt) < new Date())) {
    if (ticket.status !== 'expired') {
      await db().collection('tickets').doc(ticket.id).set({ status: 'expired' }, { merge: true });
    }
    return fail(attractionName, 'EXPIRED', 'This ticket has expired.');
  }
  if (ticket.status !== 'valid') {
    return fail(attractionName, 'INVALID_CODE', 'This ticket is not valid for entry.');
  }

  const visitId = id('vis');
  const attraction = await getAttraction(attractionId, { allowInactive: true });
  const visit: VisitDoc = {
    id: visitId,
    userId: ticket.holderUserId,
    visitorName: ticket.holderName,
    attractionId,
    region: attraction.region,
    ticketId: ticket.id,
    giftId: null,
    wasGift: false,
    scannedByUserId: gatekeeperUserId,
    scannedAt: nowIso(),
  };

  await db().collection('visits').doc(visitId).set(visit);
  await db()
    .collection('tickets')
    .doc(ticket.id)
    .set({ status: 'used', usedAt: nowIso() }, { merge: true });

  if (ticket.holderUserId) {
    await recomputeProgress(ticket.holderUserId);
    await db().collection('notifications').add({
      id: id('ntf'),
      userId: ticket.holderUserId,
      type: 'visit_verified',
      title: 'Visit verified',
      body: `Welcome to ${attractionName}. Your passport was stamped.`,
      readAt: null,
      createdAt: nowIso(),
    });
  }

  return {
    valid: true,
    type: 'solo_ticket',
    names: [ticket.holderName],
    guests: ticket.guests,
    attractionName,
    senderName: null,
    greeting: null,
    visitIds: [visitId],
    ticketId: ticket.id,
    giftId: null,
  };
}

async function redeemGift(
  keycode: string,
  attractionId: string,
  attractionName: string,
  gatekeeperUserId: string,
): Promise<ScanResult> {
  const snap = await db().collection('gifts').where('keycode', '==', keycode).limit(1).get();
  if (snap.empty) {
    return fail(attractionName, 'INVALID_CODE', 'This code is not recognized.');
  }
  const gift = snap.docs[0].data() as GiftDoc;

  if (gift.attractionId !== attractionId) {
    return fail(attractionName, 'WRONG_ATTRACTION', 'This gift is for a different site.');
  }
  if (gift.status === 'fully_used' || gift.status === 'partially_used') {
    return fail(attractionName, 'ALREADY_USED', 'This gift keycode was already redeemed.');
  }
  if (gift.status === 'expired' || (gift.expiresAt && new Date(gift.expiresAt) < new Date())) {
    await db().collection('gifts').doc(gift.id).set({ status: 'expired' }, { merge: true });
    return fail(attractionName, 'EXPIRED', 'This gift keycode has expired.');
  }
  if (gift.status !== 'active') {
    return fail(attractionName, 'INVALID_CODE', 'This gift is not active.');
  }

  const attraction = await getAttraction(attractionId, { allowInactive: true });
  const names = gift.recipientNames.slice(gift.redeemedCount);
  const visitIds: string[] = [];
  const batch = db().batch();

  for (const name of names) {
    const visitId = id('vis');
    visitIds.push(visitId);
    const visit: VisitDoc = {
      id: visitId,
      userId: null,
      visitorName: name,
      attractionId,
      region: attraction.region,
      ticketId: null,
      giftId: gift.id,
      wasGift: true,
      scannedByUserId: gatekeeperUserId,
      scannedAt: nowIso(),
    };
    batch.set(db().collection('visits').doc(visitId), visit);
  }

  batch.set(
    db().collection('gifts').doc(gift.id),
    {
      status: 'fully_used',
      redeemedCount: gift.recipientsTotal,
    },
    { merge: true },
  );
  await batch.commit();

  await db().collection('notifications').add({
    id: id('ntf'),
    userId: gift.senderUserId,
    type: 'gift_redeemed',
    title: 'Gift redeemed',
    body: `Your gift at ${attractionName} was scanned.`,
    readAt: null,
    createdAt: nowIso(),
  });

  return {
    valid: true,
    type: 'gift_keycode',
    names,
    guests: names.length,
    attractionName,
    senderName: gift.senderName,
    greeting: gift.greeting,
    visitIds,
    ticketId: null,
    giftId: gift.id,
  };
}

export async function getTicketOrThrow(ticketId: string): Promise<TicketDoc> {
  const snap = await db().collection('tickets').doc(ticketId).get();
  if (!snap.exists) throw notFound('Ticket not found');
  return snap.data() as TicketDoc;
}
