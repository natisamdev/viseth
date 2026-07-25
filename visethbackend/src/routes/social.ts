import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { p } from '../utils/params';
import { asyncHandler } from '../middleware/asyncHandler';
import { asAppUser, requireAppAuth, requireRoles } from '../middleware/auth';
import {
  addComment,
  createRecap,
  createReport,
  deleteRecap,
  getFeed,
  getRecap,
  likeRecap,
  listComments,
  recordFeedEvent,
  shareRecap,
  unlikeRecap,
} from '../services/recaps';
import {
  createBooking,
  getGuideOrThrow,
  listGuideBookings,
  listGuides,
  listTravelerBookings,
  patchBooking,
  patchGuideMe,
} from '../services/guides';
import { generateImage, saveUploadedFile, textToSpeech, transcribeAudio } from '../services/ai';
import { db } from '../config/firebase';
import { parsePage, paginate } from '../utils/pagination';
import { nowIso } from '../utils/time';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = Router();

router.get(
  '/guides',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    const items = await listGuides({
      region: req.query.region as string | undefined,
      q: req.query.q as string | undefined,
    });
    res.json(paginate(items, page, pageSize));
  }),
);

router.get(
  '/guides/me/bookings',
  requireAppAuth,
  requireRoles('guide'),
  asyncHandler(async (req, res) => {
    res.json({ items: await listGuideBookings(asAppUser(req).userId) });
  }),
);

router.patch(
  '/guides/me',
  requireAppAuth,
  requireRoles('guide'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        bio: z.string().optional(),
        languages: z.array(z.string()).optional(),
        specialties: z.array(z.string()).optional(),
        photoUrl: z.string().nullable().optional(),
        pricePerDayEtb: z.number().optional(),
        region: z.string().optional(),
        attractionIds: z.array(z.string()).optional(),
        respondsIn: z.string().optional(),
      })
      .parse(req.body);
    res.json({ guide: await patchGuideMe(asAppUser(req).userId, body) });
  }),
);

router.get(
  '/guides/:id',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    res.json({ guide: await getGuideOrThrow(p(req, 'id')) });
  }),
);

router.post(
  '/bookings',
  requireAppAuth,
  requireRoles('traveler'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        guideId: z.string(),
        requestedDate: z.string(),
        note: z.string().optional(),
      })
      .parse(req.body);
    const booking = await createBooking({
      travelerId: asAppUser(req).userId,
      ...body,
    });
    res.status(201).json({ booking });
  }),
);

router.get(
  '/bookings/mine',
  requireAppAuth,
  requireRoles('traveler'),
  asyncHandler(async (req, res) => {
    res.json({ items: await listTravelerBookings(asAppUser(req).userId) });
  }),
);

router.patch(
  '/bookings/:id',
  requireAppAuth,
  requireRoles('traveler', 'guide'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        status: z.enum(['confirmed', 'declined', 'cancelled', 'completed']),
      })
      .parse(req.body);
    const booking = await patchBooking(p(req, 'id'), asAppUser(req).userId, body.status);
    res.json({ booking });
  }),
);

router.get(
  '/feed',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    const scope = String(req.query.scope ?? req.query.tab ?? 'for_you');
    const tab = scope === 'following' ? 'following' : 'for_you';
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    let items = await getFeed(tab, asAppUser(req).userId);
    if (scope === 'attraction' && req.query.attractionId) {
      items = items.filter(
        (i) =>
          (i as { attraction?: { id: string } }).attraction?.id ===
          String(req.query.attractionId),
      );
    }
    res.json(paginate(items, page, pageSize));
  }),
);

/** Engagement events for cultural For You personalization (watch / skip / favorite). */
router.post(
  '/feed/events',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        postId: z.string().min(1),
        type: z.enum(['like', 'share', 'comment', 'favorite', 'watch', 'skip']),
        watchRatio: z.number().min(0).max(1).optional(),
      })
      .parse(req.body);
    const result = await recordFeedEvent({
      userId: asAppUser(req).userId,
      postId: body.postId,
      type: body.type,
      watchRatio: body.watchRatio,
    });
    res.status(201).json(result);
  }),
);

router.post(
  '/recaps',
  requireAppAuth,
  requireRoles('traveler', 'guide'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        attractionId: z.string(),
        visitId: z.string().optional(),
        body: z.string().min(1),
        media: z
          .array(z.object({ url: z.string(), kind: z.enum(['image', 'video']), name: z.string().optional() }))
          .optional(),
        aiAssisted: z.boolean().optional(),
        hasVoiceStory: z.boolean().optional(),
      })
      .parse(req.body);
    const recap = await createRecap({ authorId: asAppUser(req).userId, ...body });
    res.status(201).json(recap);
  }),
);

router.get(
  '/recaps/:id',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    res.json(await getRecap(p(req, 'id')));
  }),
);

router.delete(
  '/recaps/:id',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    await deleteRecap(p(req, 'id'), asAppUser(req).userId);
    res.status(204).send();
  }),
);

router.post(
  '/recaps/:id/like',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    await likeRecap(asAppUser(req).userId, p(req, 'id'));
    res.status(204).send();
  }),
);

router.delete(
  '/recaps/:id/like',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    await unlikeRecap(asAppUser(req).userId, p(req, 'id'));
    res.status(204).send();
  }),
);

router.post(
  '/recaps/:id/share',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    res.json(await shareRecap(p(req, 'id'), asAppUser(req).userId));
  }),
);

router.get(
  '/recaps/:id/comments',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    res.json({ items: await listComments(p(req, 'id')) });
  }),
);

router.post(
  '/recaps/:id/comments',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    const body = z.object({ body: z.string().min(1) }).parse(req.body);
    const comment = await addComment(p(req, 'id'), asAppUser(req).userId, body.body);
    res.status(201).json(comment);
  }),
);

router.post(
  '/reports',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        category: z.enum(['violence', 'sexual_abuse', 'other']),
        contentType: z.enum(['recap', 'comment', 'profile', 'message']),
        targetId: z.string(),
        postId: z.string().optional(),
        notes: z.string().optional(),
      })
      .parse(req.body);
    const report = await createReport({
      reporterUserId: asAppUser(req).userId,
      ...body,
    });
    res.status(201).json(report);
  }),
);

router.post(
  '/media/upload',
  requireAppAuth,
  requireRoles('traveler', 'guide'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400).json({
        error: { code: 'NO_FILE', message: 'file required', details: {} },
      });
      return;
    }
    const kind = req.file.mimetype.startsWith('video') ? 'video' : 'image';
    const saved = saveUploadedFile(req.file.buffer, req.file.originalname, kind);
    await db().collection('media_assets').doc(saved.id).set({
      ...saved,
      ownerUserId: asAppUser(req).userId,
      createdAt: nowIso(),
    });
    res.status(201).json(saved);
  }),
);

router.post(
  '/ai/transcribe',
  requireAppAuth,
  upload.single('audio'),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      res.status(400).json({
        error: { code: 'NO_FILE', message: 'audio required', details: {} },
      });
      return;
    }
    const fs = await import('fs');
    const path = await import('path');
    const tmp = path.join(process.cwd(), 'uploads', `tmp_${Date.now()}`);
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, req.file.buffer);
    try {
      res.json(await transcribeAudio(tmp));
    } finally {
      fs.unlinkSync(tmp);
    }
  }),
);

router.post(
  '/ai/tts',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    const body = z.object({ text: z.string().min(1), recapId: z.string().optional() }).parse(req.body);
    res.json(await textToSpeech(body.text, body.recapId));
  }),
);

router.post(
  '/ai/image',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    const body = z
      .object({ prompt: z.string().min(1), purpose: z.enum(['recap', 'avatar']) })
      .parse(req.body);
    res.json(await generateImage(body.prompt, body.purpose));
  }),
);

router.get(
  '/notifications',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    const snap = await db()
      .collection('notifications')
      .where('userId', '==', asAppUser(req).userId)
      .get();
    const items = snap.docs
      .map((d) => d.data())
      .sort((a, b) =>
        String((b as { createdAt: string }).createdAt).localeCompare(
          String((a as { createdAt: string }).createdAt),
        ),
      );
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    res.json(paginate(items, page, pageSize));
  }),
);

router.post(
  '/notifications/read',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        ids: z.array(z.string()).optional(),
        all: z.boolean().optional(),
      })
      .parse(req.body);
    const userId = asAppUser(req).userId;
    const snap = await db().collection('notifications').where('userId', '==', userId).get();
    const batch = db().batch();
    for (const doc of snap.docs) {
      const data = doc.data() as { id?: string };
      if (body.all || (body.ids && data.id && body.ids.includes(data.id))) {
        batch.set(doc.ref, { readAt: nowIso() }, { merge: true });
      }
    }
    await batch.commit();
    res.status(204).send();
  }),
);

router.get(
  '/announcements',
  requireAppAuth,
  asyncHandler(async (_req, res) => {
    const snap = await db().collection('announcements').get();
    res.json({ items: snap.docs.map((d) => d.data()) });
  }),
);

export default router;
