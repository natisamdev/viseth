/**
 * Compatibility aliases for the Attraction Place Admin / Customer integration guides.
 * Canonical implementations live in payments/social/admin routes; these mirror the
 * paths clients expect from `attraction place admin spec and guide`.
 */
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '../middleware/asyncHandler';
import {
  asAdmin,
  asAppUser,
  requireAdminAuth,
  requireAdminRoles,
  requireAppAuth,
  requireRoles,
} from '../middleware/auth';
import { p } from '../utils/params';
import {
  addComment,
  createRecap,
  createReport,
  deleteRecap,
  getRecap,
  likeRecap,
  listComments,
  shareRecap,
  unlikeRecap,
} from '../services/recaps';
import { forbidden } from '../utils/errors';
import { verifyScan } from '../services/scans';
import { getPassport } from '../services/passport';
import { db } from '../config/firebase';
import type { VisitDoc } from '../types';
import { getAttraction } from '../services/attractions';
import { parsePage, paginate } from '../utils/pagination';
import { getUser, toMeResponse, patchUser } from '../services/users';
import {
  placeDashboard,
  placeVisits,
  placeTickets,
  patchPlaceAttraction,
  listGatekeepers,
  createGatekeeper,
  patchGatekeeper,
  placePayouts,
} from '../services/placeAdmin';
import {
  createPlaceAdmin,
  listSocialReports,
  platformOverview,
  removeRecap,
  keepRecap,
  auditLog,
  getPlatformSettings,
  updatePlatformSettings,
  getFlags,
} from '../services/platformAdmin';
import { nowIso } from '../utils/time';
import { id } from '../utils/ids';
import { saveUploadedFile } from '../services/ai';
import { listAttractions } from '../services/attractions';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const router = Router();

// ── Auth aliases ────────────────────────────────────────────
router.post(
  '/auth/session',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    // Flutter/Admin after Firebase sign-in — upsert happens in requireAppAuth
    if (req.principal?.kind === 'app') {
      const user = await getUser(asAppUser(req).userId);
      res.json({
        ...(await toMeResponse(user)),
        role: user.role === 'traveler' ? 'visitor' : user.role,
      });
      return;
    }
    res.json({ admin: req.principal });
  }),
);

router.get(
  '/auth/me',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    if (req.principal?.kind === 'admin') {
      res.json({
        admin: {
          id: req.principal.adminId,
          email: req.principal.email,
          role:
            req.principal.role === 'place_admin'
              ? 'attraction_admin'
              : req.principal.role,
          attractionId: req.principal.attractionId,
        },
      });
      return;
    }
    const user = await getUser(asAppUser(req).userId);
    const me = await toMeResponse(user);
    res.json({
      ...me,
      role: user.role === 'traveler' ? 'visitor' : user.role,
    });
  }),
);

router.patch(
  '/users/me',
  requireAppAuth,
  requireRoles('traveler', 'guide', 'gatekeeper'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        displayName: z.string().optional(),
        photoUrl: z.string().nullable().optional(),
        phone: z.string().nullable().optional(),
        bio: z.string().optional(),
        region: z.string().nullable().optional(),
        username: z.string().nullable().optional(),
        isDiaspora: z.boolean().optional(),
        locale: z.enum(['en', 'am']).optional(),
        country: z.string().optional(),
      })
      .parse(req.body);
    const { locale: _l, country: _c, ...rest } = body;
    const updated = await patchUser(asAppUser(req).userId, rest);
    res.json(await toMeResponse(updated));
  }),
);

// ── Posts (customer feed / create) — alias of recaps ────────
router.post(
  '/posts',
  requireAppAuth,
  requireRoles('traveler', 'guide'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        attractionId: z.string(),
        visitId: z.string().optional(),
        body: z.string().min(1).max(500).optional(),
        caption: z.string().min(1).max(500).optional(),
        media: z
          .array(
            z.object({
              url: z.string(),
              kind: z.enum(['image', 'video']),
              name: z.string().optional(),
            }),
          )
          .optional(),
        aiAssisted: z.boolean().optional(),
        hasVoiceStory: z.boolean().optional(),
        visibility: z.enum(['public', 'followers']).optional(),
      })
      .parse(req.body);

    const text = (body.body ?? body.caption ?? '').trim();
    if (!text) {
      res.status(400).json({
        error: { code: 'EMPTY_BODY', message: 'body or caption required', details: {} },
      });
      return;
    }

    const post = await createRecap({
      authorId: asAppUser(req).userId,
      attractionId: body.attractionId,
      visitId: body.visitId,
      body: text,
      media: body.media,
      aiAssisted: body.aiAssisted,
      hasVoiceStory: body.hasVoiceStory,
    });
    res.status(201).json(post);
  }),
);

router.get(
  '/posts/:id',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    res.json(await getRecap(p(req, 'id')));
  }),
);

router.delete(
  '/posts/:id',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    await deleteRecap(p(req, 'id'), asAppUser(req).userId);
    res.status(204).send();
  }),
);

router.post(
  '/posts/:id/like',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    await likeRecap(asAppUser(req).userId, p(req, 'id'));
    res.status(204).send();
  }),
);

router.delete(
  '/posts/:id/like',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    await unlikeRecap(asAppUser(req).userId, p(req, 'id'));
    res.status(204).send();
  }),
);

router.post(
  '/posts/:id/comments',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    const body = z.object({ body: z.string().min(1).max(300) }).parse(req.body);
    res.status(201).json(await addComment(p(req, 'id'), asAppUser(req).userId, body.body));
  }),
);

router.get(
  '/posts/:id/comments',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    res.json({ items: await listComments(p(req, 'id')) });
  }),
);

router.post(
  '/posts/:id/report',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        reason: z.string().optional(),
        category: z.enum(['violence', 'sexual_abuse', 'other']).optional(),
        notes: z.string().optional(),
      })
      .parse(req.body);
    const report = await createReport({
      reporterUserId: asAppUser(req).userId,
      category: body.category ?? 'other',
      contentType: 'recap',
      targetId: p(req, 'id'),
      postId: p(req, 'id'),
      notes: body.notes ?? body.reason,
    });
    res.status(201).json(report);
  }),
);

router.post(
  '/posts/:id/share',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    res.json(await shareRecap(p(req, 'id')));
  }),
);

// ── Visits ──────────────────────────────────────────────────
router.post(
  '/visits/verify',
  requireAppAuth,
  requireRoles('gatekeeper'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        code: z.string().optional(),
        keycode: z.string().optional(),
        ticketId: z.string().optional(),
        attractionId: z.string(),
      })
      .parse(req.body);
    const code = body.code ?? body.keycode ?? body.ticketId;
    if (!code) {
      res.status(400).json({
        error: { code: 'VALIDATION', message: 'code or keycode required', details: {} },
      });
      return;
    }
    const user = asAppUser(req);
    const result = await verifyScan({
      code,
      attractionId: body.attractionId,
      gatekeeperUserId: user.userId,
      gatekeeperAttractionIds: user.attractionIds,
    });
    res.status(result.valid ? 200 : 422).json(result);
  }),
);

router.get(
  '/visits/me',
  requireAppAuth,
  requireRoles('traveler', 'guide', 'gatekeeper'),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    const snap = await db()
      .collection('visits')
      .where('userId', '==', asAppUser(req).userId)
      .get();
    const visits = snap.docs
      .map((d) => d.data() as VisitDoc)
      .sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));
    const items: Array<{
      id: string;
      attractionId: string;
      attractionName: string;
      region: string;
      scannedAt: string;
      wasGift: boolean;
    }> = [];
    for (const v of visits) {
      const attraction = await getAttraction(v.attractionId, { allowInactive: true });
      items.push({
        id: v.id,
        attractionId: v.attractionId,
        attractionName: attraction.name,
        region: v.region,
        scannedAt: v.scannedAt,
        wasGift: v.wasGift,
      });
    }
    res.json(paginate(items, page, pageSize));
  }),
);

router.get(
  '/users/:uid/passport',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    res.json(await getPassport(p(req, 'uid')));
  }),
);

// ── Staff desk ──────────────────────────────────────────────
router.get(
  '/staff/me',
  requireAppAuth,
  requireRoles('gatekeeper', 'guide'),
  asyncHandler(async (req, res) => {
    const user = asAppUser(req);
    const doc = await getUser(user.userId);
    res.json({
      userId: user.userId,
      role: user.role,
      displayName: doc.displayName,
      attractionIds: user.attractionIds,
      mustChangePassword: false,
    });
  }),
);

router.get(
  '/staff/gate/today',
  requireAppAuth,
  requireRoles('gatekeeper'),
  asyncHandler(async (req, res) => {
    const attractionId = asAppUser(req).attractionIds[0];
    if (!attractionId) {
      res.json({ visitsToday: 0, items: [] });
      return;
    }
    const today = nowIso().slice(0, 10);
    const snap = await db().collection('visits').where('attractionId', '==', attractionId).get();
    const items = snap.docs
      .map((d) => d.data() as VisitDoc)
      .filter((v) => v.scannedAt.startsWith(today))
      .sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));
    res.json({ visitsToday: items.length, items });
  }),
);

router.get(
  '/staff/gate/expected',
  requireAppAuth,
  requireRoles('gatekeeper'),
  asyncHandler(async (req, res) => {
    const attractionId = asAppUser(req).attractionIds[0];
    if (!attractionId) {
      res.json({ items: [] });
      return;
    }
    const snap = await db()
      .collection('tickets')
      .where('attractionId', '==', attractionId)
      .where('status', '==', 'valid')
      .get();
    const gifts = await db()
      .collection('gifts')
      .where('attractionId', '==', attractionId)
      .where('status', '==', 'active')
      .get();
    res.json({
      items: [
        ...snap.docs.map((d) => {
          const t = d.data() as { holderName: string; visitDate: string; id: string };
          return {
            type: 'ticket',
            id: t.id,
            name: t.holderName,
            visitDate: t.visitDate,
          };
        }),
        ...gifts.docs.map((d) => {
          const g = d.data() as {
            id: string;
            recipientNames: string[];
            greeting: string | null;
            visitDate: string | null;
            senderName: string;
          };
          return {
            type: 'gift',
            id: g.id,
            names: g.recipientNames,
            greeting: g.greeting,
            senderName: g.senderName,
            visitDate: g.visitDate,
          };
        }),
      ],
    });
  }),
);

// ── Attraction Admin (/admin/*) — claim-scoped via JWT attractionId ──
function placeId(req: import('express').Request): string {
  const admin = asAdmin(req);
  if (!admin.attractionId) throw forbidden('No attraction scope');
  return admin.attractionId;
}

router.get(
  '/admin/attractions/:attractionId',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    const siteId = placeId(req);
    if (p(req, 'attractionId') !== siteId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found', details: {} } });
      return;
    }
    res.json(await getAttraction(siteId, { allowInactive: true }));
  }),
);

router.patch(
  '/admin/attractions/:attractionId',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    const siteId = placeId(req);
    if (p(req, 'attractionId') !== siteId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found', details: {} } });
      return;
    }
    // Strip immutable English name per place-admin spec
    const body = { ...req.body };
    delete body.name;
    delete body.ticketPrice;
    delete body.active;
    delete body.lat;
    delete body.lng;
    res.json(
      await patchPlaceAttraction(siteId, {
        description: body.description,
        coverImageUrl: body.coverImageUrl ?? body.imageUrl,
      }),
    );
  }),
);

router.post(
  '/admin/attractions/:attractionId/cover',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const siteId = placeId(req);
    if (p(req, 'attractionId') !== siteId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found', details: {} } });
      return;
    }
    if (!req.file) {
      res.status(400).json({ error: { code: 'NO_FILE', message: 'file required', details: {} } });
      return;
    }
    const saved = saveUploadedFile(req.file.buffer, req.file.originalname, 'image');
    await patchPlaceAttraction(siteId, { coverImageUrl: saved.url });
    res.json({ imageUrl: saved.url });
  }),
);

router.get(
  '/admin/attractions/:attractionId/summary',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    const siteId = placeId(req);
    if (p(req, 'attractionId') !== siteId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found', details: {} } });
      return;
    }
    const dash = await placeDashboard(siteId);
    res.json({
      days: Number(req.query.days ?? 30),
      ...dash,
    });
  }),
);

router.get(
  '/admin/attractions/:attractionId/visits',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    const siteId = placeId(req);
    if (p(req, 'attractionId') !== siteId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found', details: {} } });
      return;
    }
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    res.json(paginate(await placeVisits(siteId), page, pageSize));
  }),
);

router.get(
  '/admin/attractions/:attractionId/tickets',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    const siteId = placeId(req);
    if (p(req, 'attractionId') !== siteId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found', details: {} } });
      return;
    }
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    res.json(
      paginate(
        await placeTickets(siteId, req.query.status as string | undefined),
        page,
        pageSize,
      ),
    );
  }),
);

router.get(
  '/admin/attractions/:attractionId/tickets.csv',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    const siteId = placeId(req);
    const tickets = await placeTickets(siteId);
    const lines = [
      'id,status,holderName,amount,purchasedAt',
      ...tickets.map(
        (t) => `${t.id},${t.status},${t.holderName},${t.amount},${t.purchasedAt ?? ''}`,
      ),
    ];
    res.type('text/csv').send(lines.join('\n'));
  }),
);

router.get(
  '/admin/gatekeepers',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    res.json({ items: await listGatekeepers(placeId(req)) });
  }),
);

router.post(
  '/admin/gatekeepers',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string(),
        email: z.string().email(),
        phone: z.string(),
        temporaryPassword: z.string().optional(),
      })
      .parse(req.body);
    res.status(201).json(await createGatekeeper(placeId(req), body));
  }),
);

router.patch(
  '/admin/gatekeepers/:id',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    res.json(await patchGatekeeper(placeId(req), p(req, 'id'), req.body));
  }),
);

router.post(
  '/admin/gatekeepers/:id/active',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    const body = z.object({ active: z.boolean() }).parse(req.body);
    res.json(await patchGatekeeper(placeId(req), p(req, 'id'), { active: body.active }));
  }),
);

router.get(
  '/admin/guides',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    const siteId = placeId(req);
    const snap = await db().collection('guides').get();
    const items = snap.docs
      .map((d) => d.data() as { attractionIds?: string[]; userId: string })
      .filter((g) => g.attractionIds?.includes(siteId));
    res.json({ items });
  }),
);

router.post(
  '/admin/guides',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string(),
        email: z.string().email(),
        phone: z.string(),
        bio: z.string().optional(),
        languages: z.array(z.string()).optional(),
        temporaryPassword: z.string().optional(),
      })
      .parse(req.body);
    const siteId = placeId(req);
    const password = body.temporaryPassword ?? `Guide-${id('tmp').slice(-8)}`;
    const { ensureFirebaseUser, setUserRole } = await import('../services/users');
    const fb = await ensureFirebaseUser(body.email, body.name, password);
    const userId = id('usr');
    const now = nowIso();
    await db()
      .collection('users')
      .doc(userId)
      .set({
        id: userId,
        firebaseUid: fb.uid,
        email: body.email.toLowerCase(),
        phone: body.phone,
        displayName: body.name,
        username: null,
        photoUrl: null,
        bio: body.bio ?? '',
        region: null,
        role: 'guide',
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
    await db()
      .collection('guides')
      .doc(userId)
      .set({
        userId,
        bio: body.bio ?? '',
        languages: body.languages ?? ['am', 'en'],
        specialties: [],
        toursCompleted: 0,
        rating: null,
        pricePerDayEtb: 2000,
        attractionIds: [siteId],
        region: (await getAttraction(siteId, { allowInactive: true })).region,
        verified: true,
        respondsIn: 'under 2 hours',
        active: true,
        photoUrl: null,
        displayName: body.name,
      });
    await setUserRole(userId, 'guide');
    res.status(201).json({ userId, email: body.email, temporaryPassword: password });
  }),
);

router.patch(
  '/admin/guides/:id',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    await db().collection('guides').doc(p(req, 'id')).set(req.body, { merge: true });
    res.json((await db().collection('guides').doc(p(req, 'id')).get()).data());
  }),
);

router.post(
  '/admin/guides/:id/status',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    const body = z.object({ status: z.enum(['active', 'suspended']) }).parse(req.body);
    await db()
      .collection('guides')
      .doc(p(req, 'id'))
      .set({ active: body.status === 'active' }, { merge: true });
    res.status(204).send();
  }),
);

router.get(
  '/admin/notifications',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    const siteId = placeId(req);
    const snap = await db()
      .collection('notifications')
      .where('attractionId', '==', siteId)
      .get();
    res.json({
      items: snap.docs.map((d) => d.data()).sort((a, b) =>
        String((b as { createdAt: string }).createdAt).localeCompare(
          String((a as { createdAt: string }).createdAt),
        ),
      ),
    });
  }),
);

router.post(
  '/admin/notifications/:id/read',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    await db()
      .collection('notifications')
      .doc(p(req, 'id'))
      .set({ readAt: nowIso() }, { merge: true });
    res.status(204).send();
  }),
);

router.get(
  '/admin/payouts',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    res.json({ items: await placePayouts(placeId(req)) });
  }),
);

// ── Platform aliases from place-admin guide ─────────────────
router.get(
  '/platform/analytics',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (_req, res) => {
    res.json(await platformOverview());
  }),
);

router.post(
  '/platform/attraction-admins',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        name: z.string(),
        email: z.string().email(),
        phone: z.string().optional(),
        attractionId: z.string(),
        temporaryPassword: z.string().min(8),
      })
      .parse(req.body);
    res.status(201).json(await createPlaceAdmin(body));
  }),
);

router.get(
  '/platform/moderation/reports',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    res.json(
      paginate(
        await listSocialReports({ status: (req.query.status as string) ?? 'open' }),
        page,
        pageSize,
      ),
    );
  }),
);

router.post(
  '/platform/posts/:id/moderate',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        action: z.enum(['hide', 'remove', 'dismiss', 'keep']),
        reason: z.string().optional(),
      })
      .parse(req.body);
    if (body.action === 'remove' || body.action === 'hide') {
      await removeRecap(p(req, 'id'), body.reason ?? body.action, asAdmin(req).adminId);
    } else {
      await keepRecap(p(req, 'id'));
    }
    res.status(204).send();
  }),
);

router.get(
  '/platform/audit-logs',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    res.json(paginate(await auditLog(), page, pageSize));
  }),
);

router.get(
  '/platform/config',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (_req, res) => {
    res.json({
      settings: await getPlatformSettings(),
      featureFlags: await getFlags(),
    });
  }),
);

router.patch(
  '/platform/config',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    res.json(await updatePlatformSettings(req.body));
  }),
);

router.get(
  '/recommendations',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    const passport = await getPassport(asAppUser(req).userId);
    const visited = new Set(passport.visits.map((v) => v.attractionId));
    const all = await listAttractions({ active: true });
    const items = all.filter((a) => !visited.has(a.id)).slice(0, 10);
    res.json({ items });
  }),
);

export default router;
