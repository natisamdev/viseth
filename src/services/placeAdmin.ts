import { db } from '../config/firebase';
import type { GatekeeperDoc, TicketDoc, VisitDoc } from '../types';
import { id } from '../utils/ids';
import { nowIso } from '../utils/time';
import { getAttraction, patchAttraction } from './attractions';
import { ensureFirebaseUser, setUserRole } from './users';
import { badRequest } from '../utils/errors';

export async function placeDashboard(attractionId: string) {
  const attraction = await getAttraction(attractionId, { allowInactive: true });
  const txSnap = await db()
    .collection('transactions')
    .where('attractionId', '==', attractionId)
    .where('status', '==', 'succeeded')
    .get();
  let gross = 0;
  let commission = 0;
  for (const d of txSnap.docs) {
    const t = d.data() as { amount: number; commission: number };
    gross += t.amount;
    commission += t.commission;
  }

  const today = nowIso().slice(0, 10);
  const visitsSnap = await db()
    .collection('visits')
    .where('attractionId', '==', attractionId)
    .get();
  const visits = visitsSnap.docs.map((d) => d.data() as VisitDoc);
  const visitsToday = visits.filter((v) => v.scannedAt.startsWith(today)).length;

  const ticketsSnap = await db()
    .collection('tickets')
    .where('attractionId', '==', attractionId)
    .where('status', '==', 'valid')
    .get();

  const recentScans = visits
    .sort((a, b) => b.scannedAt.localeCompare(a.scannedAt))
    .slice(0, 10)
    .map((v) => ({
      visitorName: v.visitorName,
      scannedAt: v.scannedAt,
      type: v.wasGift ? 'gift_keycode' : 'solo_ticket',
    }));

  return {
    attraction: { id: attraction.id, name: attraction.name },
    gross: Number(gross.toFixed(2)),
    commission: Number(commission.toFixed(2)),
    partnerShare: Number((gross - commission).toFixed(2)),
    visitsToday,
    validTickets: ticketsSnap.size,
    recentScans,
  };
}

export async function placeVisits(attractionId: string) {
  const snap = await db().collection('visits').where('attractionId', '==', attractionId).get();
  return snap.docs
    .map((d) => d.data() as VisitDoc)
    .sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));
}

export async function placeTickets(attractionId: string, status?: string) {
  const snap = await db().collection('tickets').where('attractionId', '==', attractionId).get();
  let items = snap.docs.map((d) => d.data() as TicketDoc);
  if (status) items = items.filter((t) => t.status === status);
  return items.sort((a, b) => (b.purchasedAt ?? '').localeCompare(a.purchasedAt ?? ''));
}

export async function patchPlaceAttraction(
  attractionId: string,
  body: { description?: string; coverImageUrl?: string | null },
) {
  const allowed: Partial<{ description: string; coverImageUrl: string | null }> = {};
  if (body.description != null) allowed.description = body.description;
  if (body.coverImageUrl !== undefined) allowed.coverImageUrl = body.coverImageUrl;
  return patchAttraction(attractionId, allowed);
}

export async function listGatekeepers(attractionId: string) {
  const snap = await db().collection('gatekeepers').get();
  return snap.docs
    .map((d) => d.data() as GatekeeperDoc)
    .filter((g) => g.attractionIds.includes(attractionId));
}

export async function createGatekeeper(
  attractionId: string,
  input: { name: string; email: string; phone: string; temporaryPassword?: string },
) {
  const password = input.temporaryPassword ?? `Gate-${id('tmp').slice(-8)}`;
  const fb = await ensureFirebaseUser(input.email, input.name, password);
  const userId = id('usr');
  const now = nowIso();
  await db()
    .collection('users')
    .doc(userId)
    .set({
      id: userId,
      firebaseUid: fb.uid,
      email: input.email.toLowerCase(),
      phone: input.phone,
      displayName: input.name,
      username: null,
      photoUrl: null,
      bio: '',
      region: null,
      role: 'gatekeeper',
      status: 'active',
      isDiaspora: false,
      followerCount: 0,
      followingCount: 0,
      streakMonths: 0,
      streakBrokenAt: null,
      currentBadgeId: null,
      currentTitleId: 'ttl_traveler',
      heritageScore: 0,
      regionsVisited: [],
      sitesVisitedCount: 0,
      hasCompletedFirstPurchase: false,
      createdAt: now,
      updatedAt: now,
    });

  const gk: GatekeeperDoc = {
    userId,
    attractionIds: [attractionId],
    active: true,
    displayName: input.name,
    email: input.email.toLowerCase(),
    phone: input.phone,
    deviceIds: [],
  };
  await db().collection('gatekeepers').doc(userId).set(gk);
  await setUserRole(userId, 'gatekeeper');
  return { ...gk, temporaryPassword: password };
}

export async function patchGatekeeper(
  attractionId: string,
  userId: string,
  patch: { active?: boolean; displayName?: string },
) {
  const snap = await db().collection('gatekeepers').doc(userId).get();
  if (!snap.exists) throw badRequest('NOT_FOUND', 'Gatekeeper not found');
  const gk = snap.data() as GatekeeperDoc;
  if (!gk.attractionIds.includes(attractionId)) throw badRequest('WRONG_SITE', 'Not your gatekeeper');
  await db().collection('gatekeepers').doc(userId).set(patch, { merge: true });
  if (patch.displayName) {
    await db()
      .collection('users')
      .doc(userId)
      .set({ displayName: patch.displayName, updatedAt: nowIso() }, { merge: true });
  }
  return { ...(await db().collection('gatekeepers').doc(userId).get()).data(), userId };
}

export async function placePayouts(attractionId: string) {
  const snap = await db().collection('payouts').where('attractionId', '==', attractionId).get();
  return snap.docs.map((d) => d.data());
}

export async function placeRevenue(attractionId: string) {
  const dash = await placeDashboard(attractionId);
  return {
    gross: dash.gross,
    commission: dash.commission,
    partnerShare: dash.partnerShare,
  };
}
