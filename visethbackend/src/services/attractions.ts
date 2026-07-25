import { db } from '../config/firebase';
import type { AttractionDoc, HotelDoc } from '../types';
import { id } from '../utils/ids';
import { nowIso } from '../utils/time';
import { notFound } from '../utils/errors';

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function listAttractions(filters: {
  active?: boolean;
  region?: string;
  category?: string;
  q?: string;
  includeInactive?: boolean;
}): Promise<AttractionDoc[]> {
  const snap = await db().collection('attractions').get();
  let items = snap.docs.map((d) => d.data() as AttractionDoc);
  if (!filters.includeInactive) {
    items = items.filter((a) => a.active);
  } else if (filters.active != null) {
    items = items.filter((a) => a.active === filters.active);
  }
  if (filters.region) items = items.filter((a) => a.region === filters.region);
  if (filters.category) items = items.filter((a) => a.category === filters.category);
  if (filters.q) {
    const q = filters.q.toLowerCase();
    items = items.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.summary.toLowerCase().includes(q) ||
        (a.amharicName ?? '').includes(filters.q!),
    );
  }
  return items.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getAttraction(
  attractionId: string,
  opts?: { allowInactive?: boolean },
): Promise<AttractionDoc> {
  const snap = await db().collection('attractions').doc(attractionId).get();
  if (!snap.exists) throw notFound('Attraction not found');
  const a = snap.data() as AttractionDoc;
  if (!a.active && !opts?.allowInactive) throw notFound('Attraction not found');
  return a;
}

export function serializeAttraction(a: AttractionDoc, distanceKm: number | null = null) {
  return { ...a, distanceKm };
}

export async function nearbyAttractions(
  lat: number,
  lng: number,
  radiusKm = 50,
  limit = 20,
) {
  const items = await listAttractions({ active: true });
  return items
    .map((a) => ({
      ...serializeAttraction(a, Number(haversineKm(lat, lng, a.lat, a.lng).toFixed(2))),
    }))
    .filter((a) => (a.distanceKm ?? 999) <= radiusKm)
    .sort((a, b) => (a.distanceKm ?? 0) - (b.distanceKm ?? 0))
    .slice(0, limit);
}

export async function createAttraction(
  input: Omit<AttractionDoc, 'id' | 'createdAt' | 'updatedAt' | 'enrichedFacts' | 'enrichmentStatus' | 'rating' | 'reviewCount'> &
    Partial<Pick<AttractionDoc, 'rating' | 'reviewCount' | 'enrichedFacts' | 'enrichmentStatus'>>,
): Promise<AttractionDoc> {
  const doc: AttractionDoc = {
    rating: 0,
    reviewCount: 0,
    enrichedFacts: [],
    enrichmentStatus: 'none',
    ...input,
    id: id('atr'),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await db().collection('attractions').doc(doc.id).set(doc);
  return doc;
}

export async function patchAttraction(
  attractionId: string,
  patch: Partial<AttractionDoc>,
): Promise<AttractionDoc> {
  await db()
    .collection('attractions')
    .doc(attractionId)
    .set({ ...patch, updatedAt: nowIso() }, { merge: true });
  return getAttraction(attractionId, { allowInactive: true });
}

export async function listHotels(filters: {
  region?: string;
  nearAttractionId?: string;
  q?: string;
}): Promise<HotelDoc[]> {
  const snap = await db().collection('hotels').get();
  let items = snap.docs.map((d) => d.data() as HotelDoc).filter((h) => h.active);
  if (filters.region) items = items.filter((h) => h.region === filters.region);
  if (filters.nearAttractionId) {
    items = items.filter((h) => h.nearAttractionId === filters.nearAttractionId);
  }
  if (filters.q) {
    const q = filters.q.toLowerCase();
    items = items.filter((h) => h.name.toLowerCase().includes(q));
  }
  return items;
}

export async function getHotel(hotelId: string): Promise<HotelDoc> {
  const snap = await db().collection('hotels').doc(hotelId).get();
  if (!snap.exists) throw notFound('Hotel not found');
  return snap.data() as HotelDoc;
}

export async function nearbyHotels(lat: number, lng: number, radiusKm = 50, limit = 20) {
  const hotels = await listHotels({});
  return hotels
    .map((h) => ({
      ...h,
      distanceKm: Number(haversineKm(lat, lng, h.lat, h.lng).toFixed(2)),
    }))
    .filter((h) => h.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);
}

export async function saveAttraction(userId: string, attractionId: string) {
  await getAttraction(attractionId);
  await db()
    .collection('saved_attractions')
    .doc(`${userId}_${attractionId}`)
    .set({ userId, attractionId, createdAt: nowIso() });
}

export async function unsaveAttraction(userId: string, attractionId: string) {
  await db().collection('saved_attractions').doc(`${userId}_${attractionId}`).delete();
}

export async function listSavedAttractions(userId: string) {
  const snap = await db().collection('saved_attractions').where('userId', '==', userId).get();
  const ids = snap.docs.map((d) => (d.data() as { attractionId: string }).attractionId);
  const attractions: AttractionDoc[] = [];
  for (const attractionId of ids) {
    try {
      attractions.push(await getAttraction(attractionId, { allowInactive: true }));
    } catch {
      /* skip missing */
    }
  }
  return attractions;
}
