import { db } from '../config/firebase';
import type { BookingDoc, GuideDoc } from '../types';
import { id } from '../utils/ids';
import { nowIso } from '../utils/time';
import { badRequest, forbidden, notFound } from '../utils/errors';
import { getFeatureFlags } from './settings';
import { getUser } from './users';

export async function listGuides(filters: {
  region?: string;
  q?: string;
  activeOnly?: boolean;
}): Promise<GuideDoc[]> {
  const snap = await db().collection('guides').get();
  let items = snap.docs.map((d) => d.data() as GuideDoc);
  if (filters.activeOnly !== false) items = items.filter((g) => g.active && g.verified);
  if (filters.region) items = items.filter((g) => g.region === filters.region);
  if (filters.q) {
    const q = filters.q.toLowerCase();
    items = items.filter(
      (g) =>
        g.displayName.toLowerCase().includes(q) ||
        g.bio.toLowerCase().includes(q) ||
        g.specialties.some((s) => s.toLowerCase().includes(q)),
    );
  }
  return items;
}

export async function getGuideOrThrow(userId: string): Promise<GuideDoc> {
  const snap = await db().collection('guides').doc(userId).get();
  if (!snap.exists) throw notFound('Guide not found');
  return snap.data() as GuideDoc;
}

export async function patchGuideMe(
  userId: string,
  patch: Partial<
    Pick<
      GuideDoc,
      | 'bio'
      | 'languages'
      | 'specialties'
      | 'photoUrl'
      | 'pricePerDayEtb'
      | 'region'
      | 'attractionIds'
      | 'respondsIn'
    >
  >,
): Promise<GuideDoc> {
  await getGuideOrThrow(userId);
  await db().collection('guides').doc(userId).set(patch, { merge: true });
  return getGuideOrThrow(userId);
}

export async function createBooking(input: {
  travelerId: string;
  guideId: string;
  requestedDate: string;
  note?: string;
}): Promise<BookingDoc> {
  const flags = await getFeatureFlags();
  if (!flags.guide_booking) throw forbidden('Guide booking disabled', 'FEATURE_DISABLED');
  await getGuideOrThrow(input.guideId);
  const booking: BookingDoc = {
    id: id('bkg'),
    guideId: input.guideId,
    travelerId: input.travelerId,
    requestedDate: input.requestedDate,
    note: input.note ?? null,
    status: 'requested',
    transactionId: null,
    amount: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await db().collection('bookings').doc(booking.id).set(booking);
  await db().collection('notifications').add({
    id: id('ntf'),
    userId: input.guideId,
    type: 'booking_request',
    title: 'New booking request',
    body: `Requested for ${input.requestedDate}`,
    readAt: null,
    createdAt: nowIso(),
  });
  return booking;
}

export async function listTravelerBookings(travelerId: string) {
  const snap = await db().collection('bookings').where('travelerId', '==', travelerId).get();
  return snap.docs
    .map((d) => d.data() as BookingDoc)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listGuideBookings(guideId: string) {
  const snap = await db().collection('bookings').where('guideId', '==', guideId).get();
  return snap.docs
    .map((d) => d.data() as BookingDoc)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function patchBooking(
  bookingId: string,
  actorUserId: string,
  status: BookingDoc['status'],
): Promise<BookingDoc> {
  const snap = await db().collection('bookings').doc(bookingId).get();
  if (!snap.exists) throw notFound('Booking not found');
  const booking = snap.data() as BookingDoc;
  const user = await getUser(actorUserId);

  if (status === 'cancelled') {
    if (booking.travelerId !== actorUserId) throw forbidden();
    if (booking.status !== 'requested') {
      throw badRequest('INVALID_STATUS', 'Can only cancel requested bookings');
    }
  } else if (['confirmed', 'declined', 'completed'].includes(status)) {
    if (booking.guideId !== actorUserId && user.role !== 'guide') throw forbidden();
    if (booking.guideId !== actorUserId) throw forbidden();
  } else {
    throw badRequest('INVALID_STATUS', 'Unsupported status');
  }

  const updated = { status, updatedAt: nowIso() };
  await db().collection('bookings').doc(bookingId).set(updated, { merge: true });
  return { ...booking, ...updated };
}
