import { Router } from 'express';
import { z } from 'zod';
import { p } from '../utils/params';
import { asyncHandler } from '../middleware/asyncHandler';
import { asAppUser, optionalAppAuth, requireAppAuth, requireRoles } from '../middleware/auth';
import {
  getAttraction,
  getHotel,
  listAttractions,
  listHotels,
  nearbyAttractions,
  nearbyHotels,
  saveAttraction,
  serializeAttraction,
  unsaveAttraction,
} from '../services/attractions';
import { getFeatureFlags } from '../services/settings';
import { parsePage, paginate } from '../utils/pagination';
import { forbidden, notFound } from '../utils/errors';
import { db } from '../config/firebase';
import { id } from '../utils/ids';
import { nowIso } from '../utils/time';
import type { HotelBookingDoc } from '../types';

const router = Router();

router.get(
  '/attractions',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    const items = await listAttractions({
      region: req.query.region as string | undefined,
      category: req.query.category as string | undefined,
      q: req.query.q as string | undefined,
      active: true,
    });
    res.json(paginate(items.map((a) => serializeAttraction(a)), page, pageSize));
  }),
);

router.get(
  '/attractions/nearby',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      res.status(400).json({
        error: { code: 'VALIDATION', message: 'lat and lng required', details: {} },
      });
      return;
    }
    const radiusKm = Number(req.query.radiusKm ?? 50);
    const limit = Number(req.query.limit ?? 20);
    const attractions = await nearbyAttractions(lat, lng, radiusKm, limit);
    const includeHotels = String(req.query.include ?? '').includes('hotels');
    const result: Record<string, unknown> = { items: attractions };
    if (includeHotels) {
      result.hotels = await nearbyHotels(lat, lng, radiusKm, limit);
    }
    res.json(result);
  }),
);

router.get(
  '/attractions/:id',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    const a = await getAttraction(p(req, 'id'));
    res.json(serializeAttraction(a));
  }),
);

router.post(
  '/attractions/:id/save',
  requireAppAuth,
  requireRoles('traveler'),
  asyncHandler(async (req, res) => {
    await saveAttraction(asAppUser(req).userId, p(req, 'id'));
    res.status(204).send();
  }),
);

router.delete(
  '/attractions/:id/save',
  requireAppAuth,
  requireRoles('traveler'),
  asyncHandler(async (req, res) => {
    await unsaveAttraction(asAppUser(req).userId, p(req, 'id'));
    res.status(204).send();
  }),
);

router.get(
  '/hotels',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    const flags = await getFeatureFlags();
    if (!flags.hotels) throw forbidden('Hotels disabled', 'FEATURE_DISABLED');
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    const items = await listHotels({
      region: req.query.region as string | undefined,
      nearAttractionId: req.query.nearAttractionId as string | undefined,
      q: req.query.q as string | undefined,
    });
    res.json(paginate(items, page, pageSize));
  }),
);

router.get(
  '/hotels/nearby',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    res.json({
      items: await nearbyHotels(lat, lng, Number(req.query.radiusKm ?? 50), Number(req.query.limit ?? 20)),
    });
  }),
);

router.get(
  '/hotels/:id',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    res.json(await getHotel(p(req, 'id')));
  }),
);

router.post(
  '/hotel-bookings',
  requireAppAuth,
  requireRoles('traveler'),
  asyncHandler(async (req, res) => {
    const flags = await getFeatureFlags();
    if (!flags.hotels) throw forbidden('Hotels disabled', 'FEATURE_DISABLED');
    const body = z
      .object({
        hotelId: z.string(),
        checkIn: z.string(),
        checkOut: z.string(),
        rooms: z.number().int().min(1).default(1),
        guests: z.number().int().min(1).default(1),
      })
      .parse(req.body);
    await getHotel(body.hotelId);
    const booking: HotelBookingDoc = {
      id: id('hb'),
      hotelId: body.hotelId,
      travelerId: asAppUser(req).userId,
      checkIn: body.checkIn,
      checkOut: body.checkOut,
      rooms: body.rooms,
      guests: body.guests,
      status: 'requested',
      transactionId: null,
      amount: null,
      createdAt: nowIso(),
    };
    await db().collection('hotel_bookings').doc(booking.id).set(booking);
    res.status(201).json({ booking });
  }),
);

router.get(
  '/hotel-bookings/mine',
  requireAppAuth,
  requireRoles('traveler'),
  asyncHandler(async (req, res) => {
    const snap = await db()
      .collection('hotel_bookings')
      .where('travelerId', '==', asAppUser(req).userId)
      .get();
    res.json({
      items: snap.docs.map((d) => d.data()),
    });
  }),
);

// silence unused import lint
void optionalAppAuth;
void notFound;

export default router;
