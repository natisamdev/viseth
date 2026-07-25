import { Router } from 'express';
import { z } from 'zod';
import { p } from '../utils/params';
import { asyncHandler } from '../middleware/asyncHandler';
import {
  asAdmin,
  requireAdminAuth,
  requireAdminRoles,
} from '../middleware/auth';
import {
  changePassword,
  getAdmin,
  loginAdmin,
  logoutAdmin,
  publicAdmin,
  refreshAdmin,
} from '../services/adminAuth';
import {
  placeDashboard,
  placeVisits,
  placeTickets,
  patchPlaceAttraction,
  listGatekeepers,
  createGatekeeper,
  patchGatekeeper,
  placePayouts,
  placeRevenue,
} from '../services/placeAdmin';
import {
  platformOverview,
  createPlatformAttraction,
  activateAttraction,
  createPlaceAdmin,
  listPlaceAdmins,
  patchPlaceAdmin,
  listPlatformGuides,
  patchPlatformGuide,
  listPlatformRecaps,
  keepRecap,
  removeRecap,
  listSocialReports,
  resolveSocialReport,
  listTransactions,
  listPayouts,
  payoutAction,
  listSupportCases,
  updateSupportCase,
  getPlatformSettings,
  updatePlatformSettings,
  getFlags,
  patchFlag,
  listAnnouncements,
  createAnnouncement,
  listApiCredentials,
  issueApiCredential,
  integrationsHealth,
  auditLog,
  enrichAttraction,
  listAttractions,
  patchAttraction,
} from '../services/platformAdmin';
import { getAttraction } from '../services/attractions';
import { getFollowerTitles, getStreakTiers } from '../services/settings';
import { db } from '../config/firebase';
import { parsePage, paginate } from '../utils/pagination';
import { DEFAULT_FOLLOWER_TITLES, DEFAULT_STREAK_TIERS } from '../services/gamification';

const router = Router();

// ── Admin auth ──────────────────────────────────────────────
router.post(
  '/admin/auth/login',
  asyncHandler(async (req, res) => {
    const body = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
    res.json(await loginAdmin(body.email, body.password));
  }),
);

router.post(
  '/admin/auth/refresh',
  asyncHandler(async (req, res) => {
    const body = z.object({ refreshToken: z.string() }).parse(req.body);
    res.json(await refreshAdmin(body.refreshToken));
  }),
);

router.post(
  '/admin/auth/logout',
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    await logoutAdmin(asAdmin(req).adminId);
    res.status(204).send();
  }),
);

router.post(
  '/admin/auth/change-password',
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const body = z
      .object({ currentPassword: z.string(), newPassword: z.string().min(8) })
      .parse(req.body);
    await changePassword(asAdmin(req).adminId, body.currentPassword, body.newPassword);
    res.status(204).send();
  }),
);

router.get(
  '/admin/me',
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const admin = await getAdmin(asAdmin(req).adminId);
    res.json({ admin: publicAdmin(admin) });
  }),
);

router.patch(
  '/admin/me',
  requireAdminAuth,
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        displayName: z.string().optional(),
        phone: z.string().nullable().optional(),
        avatarUrl: z.string().nullable().optional(),
      })
      .parse(req.body);
    await db().collection('admins').doc(asAdmin(req).adminId).set(body, { merge: true });
    const admin = await getAdmin(asAdmin(req).adminId);
    res.json({ admin: publicAdmin(admin) });
  }),
);

// ── Place admin ─────────────────────────────────────────────
router.get(
  '/place/dashboard',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    res.json(await placeDashboard(asAdmin(req).attractionId!));
  }),
);

router.get(
  '/place/visits',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    const items = await placeVisits(asAdmin(req).attractionId!);
    res.json(paginate(items, page, pageSize));
  }),
);

router.get(
  '/place/tickets',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    const items = await placeTickets(
      asAdmin(req).attractionId!,
      req.query.status as string | undefined,
    );
    res.json(paginate(items, page, pageSize));
  }),
);

router.get(
  '/place/attraction',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    res.json(await getAttraction(asAdmin(req).attractionId!, { allowInactive: true }));
  }),
);

router.patch(
  '/place/attraction',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ description: z.string().optional(), coverImageUrl: z.string().nullable().optional() })
      .parse(req.body);
    res.json(await patchPlaceAttraction(asAdmin(req).attractionId!, body));
  }),
);

router.get(
  '/place/gatekeepers',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    res.json({ items: await listGatekeepers(asAdmin(req).attractionId!) });
  }),
);

router.post(
  '/place/gatekeepers',
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
    const gk = await createGatekeeper(asAdmin(req).attractionId!, body);
    res.status(201).json(gk);
  }),
);

router.patch(
  '/place/gatekeepers/:id',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ active: z.boolean().optional(), displayName: z.string().optional() })
      .parse(req.body);
    res.json(await patchGatekeeper(asAdmin(req).attractionId!, p(req, 'id'), body));
  }),
);

router.get(
  '/place/payouts',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    res.json({ items: await placePayouts(asAdmin(req).attractionId!) });
  }),
);

router.get(
  '/place/revenue',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (req, res) => {
    res.json(await placeRevenue(asAdmin(req).attractionId!));
  }),
);

router.get(
  '/place/credentials',
  requireAdminAuth,
  requireAdminRoles('place_admin'),
  asyncHandler(async (_req, res) => {
    res.json({ items: [] });
  }),
);

// ── Platform admin ──────────────────────────────────────────
router.get(
  '/platform/overview',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (_req, res) => {
    res.json(await platformOverview());
  }),
);

router.get(
  '/platform/attractions',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    const items = await listAttractions({ includeInactive: true });
    res.json(paginate(items, page, pageSize));
  }),
);

router.post(
  '/platform/attractions',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    res.status(201).json(await createPlatformAttraction(req.body));
  }),
);

router.get(
  '/platform/attractions/:id',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    res.json(await getAttraction(p(req, 'id'), { allowInactive: true }));
  }),
);

router.patch(
  '/platform/attractions/:id',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    res.json(await patchAttraction(p(req, 'id'), req.body));
  }),
);

router.post(
  '/platform/attractions/:id/activate',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const body = z.object({ active: z.boolean() }).parse(req.body);
    res.json(await activateAttraction(p(req, 'id'), body.active));
  }),
);

router.post(
  '/platform/attractions/:id/enrich',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const facts = await enrichAttraction(p(req, 'id'));
    res.json({ enrichedFacts: facts, enrichmentStatus: 'ready' });
  }),
);

router.get(
  '/platform/place-admins',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (_req, res) => {
    res.json({ items: await listPlaceAdmins() });
  }),
);

router.post(
  '/platform/place-admins',
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

router.patch(
  '/platform/place-admins/:id',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    res.json(await patchPlaceAdmin(p(req, 'id'), req.body));
  }),
);

router.get(
  '/platform/guides',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (_req, res) => {
    res.json({ items: await listPlatformGuides() });
  }),
);

router.patch(
  '/platform/guides/:id',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ active: z.boolean().optional(), verified: z.boolean().optional() })
      .parse(req.body);
    res.json(await patchPlatformGuide(p(req, 'id'), body));
  }),
);

router.get(
  '/platform/recaps',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    const items = await listPlatformRecaps(req.query.status as string | undefined);
    res.json(paginate(items, page, pageSize));
  }),
);

router.post(
  '/platform/recaps/:id/keep',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    await keepRecap(p(req, 'id'));
    res.status(204).send();
  }),
);

router.post(
  '/platform/recaps/:id/remove',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const body = z.object({ reason: z.string().min(1) }).parse(req.body);
    await removeRecap(p(req, 'id'), body.reason, asAdmin(req).adminId);
    res.status(204).send();
  }),
);

router.get(
  '/platform/social-reports',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    const items = await listSocialReports({
      status: req.query.status as string | undefined,
      category: req.query.category as string | undefined,
    });
    res.json(paginate(items, page, pageSize));
  }),
);

router.post(
  '/platform/social-reports/:id/resolve',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        status: z.enum(['actioned', 'dismissed']),
        resolutionNote: z.string().min(1),
        suspendUser: z.boolean().optional(),
      })
      .parse(req.body);
    await resolveSocialReport(p(req, 'id'), {
      ...body,
      adminId: asAdmin(req).adminId,
    });
    res.status(204).send();
  }),
);

router.get(
  '/platform/revenue/by-attraction',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (_req, res) => {
    const overview = await platformOverview();
    res.json({ items: overview.revenueByAttraction });
  }),
);

router.get(
  '/platform/transactions',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    res.json(paginate(await listTransactions(), page, pageSize));
  }),
);

router.get(
  '/platform/payouts',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (_req, res) => {
    res.json({ items: await listPayouts() });
  }),
);

router.post(
  '/platform/payouts/:id/hold',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const body = z.object({ reason: z.string().optional() }).parse(req.body);
    await payoutAction(p(req, 'id'), 'hold', asAdmin(req).adminId, body.reason);
    res.status(204).send();
  }),
);

router.post(
  '/platform/payouts/:id/release',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    await payoutAction(p(req, 'id'), 'release', asAdmin(req).adminId);
    res.status(204).send();
  }),
);

router.post(
  '/platform/payouts/:id/mark-paid',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    await payoutAction(p(req, 'id'), 'mark-paid', asAdmin(req).adminId);
    res.status(204).send();
  }),
);

router.get(
  '/platform/support-cases',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (_req, res) => {
    res.json({ items: await listSupportCases() });
  }),
);

router.post(
  '/platform/support-cases/:id/status',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({ status: z.string(), resolution: z.string().optional() })
      .parse(req.body);
    await updateSupportCase(p(req, 'id'), body.status, body.resolution);
    res.status(204).send();
  }),
);

router.get(
  '/platform/settings',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (_req, res) => {
    res.json(await getPlatformSettings());
  }),
);

router.put(
  '/platform/settings',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    res.json(await updatePlatformSettings(req.body));
  }),
);

router.get(
  '/platform/feature-flags',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (_req, res) => {
    res.json(await getFlags());
  }),
);

router.patch(
  '/platform/feature-flags/:key',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const body = z.object({ enabled: z.boolean() }).parse(req.body);
    res.json(await patchFlag(p(req, 'key'), body.enabled));
  }),
);

router.get(
  '/platform/announcements',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (_req, res) => {
    res.json({ items: await listAnnouncements() });
  }),
);

router.post(
  '/platform/announcements',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        title: z.string(),
        body: z.string(),
        audience: z.enum(['all', 'travelers', 'guides', 'gatekeepers']),
      })
      .parse(req.body);
    res.status(201).json(await createAnnouncement(body));
  }),
);

router.get(
  '/platform/api-credentials',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (_req, res) => {
    res.json({ items: await listApiCredentials() });
  }),
);

router.post(
  '/platform/api-credentials',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const body = z.object({ scope: z.string() }).parse(req.body);
    res.status(201).json(await issueApiCredential(body.scope, asAdmin(req).adminId));
  }),
);

router.get(
  '/platform/integrations',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (_req, res) => {
    res.json({ items: await integrationsHealth() });
  }),
);

router.post(
  '/platform/integrations/:id/recheck',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (_req, res) => {
    res.json({ items: await integrationsHealth() });
  }),
);

router.get(
  '/platform/gamification',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (_req, res) => {
    res.json({
      streakTiers: await getStreakTiers(),
      followerTitles: await getFollowerTitles(),
    });
  }),
);

router.put(
  '/platform/gamification/streak-tiers',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const tiers = z.array(z.any()).parse(req.body);
    await db().collection('gamification').doc('streak_tiers').set({ tiers });
    res.json({ tiers });
  }),
);

router.put(
  '/platform/gamification/follower-titles',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const titles = z.array(z.any()).parse(req.body);
    await db().collection('gamification').doc('follower_titles').set({ titles });
    res.json({ titles });
  }),
);

router.get(
  '/platform/audit-log',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    res.json(paginate(await auditLog(), page, pageSize));
  }),
);

router.get(
  '/platform/exports/sites.csv',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (_req, res) => {
    const sites = await listAttractions({ includeInactive: true });
    const lines = [
      'id,name,region,ticketPrice,active',
      ...sites.map((s) => `${s.id},"${s.name}",${s.region},${s.ticketPrice},${s.active}`),
    ];
    res.type('text/csv').send(lines.join('\n'));
  }),
);

router.get(
  '/platform/exports/payments.csv',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (_req, res) => {
    const txs = await listTransactions();
    const lines = [
      'id,reference,kind,status,amount,commission',
      ...txs.map(
        (t) => `${t.id},${t.reference},${t.kind},${t.status},${t.amount},${t.commission}`,
      ),
    ];
    res.type('text/csv').send(lines.join('\n'));
  }),
);

router.get(
  '/platform/exports/social-reports.csv',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (_req, res) => {
    const reports = await listSocialReports({});
    const lines = [
      'id,category,status,targetId',
      ...reports.map(
        (r) => `${r.id},${r.category},${r.status},${r.targetId}`,
      ),
    ];
    res.type('text/csv').send(lines.join('\n'));
  }),
);

router.get(
  '/platform/exports/audit.csv',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (_req, res) => {
    const logs = await auditLog();
    const lines = [
      'id,category,action,actorAdminId,createdAt',
      ...logs.map(
        (l) =>
          `${(l as { id: string }).id},${(l as { category: string }).category},${(l as { action: string }).action},${(l as { actorAdminId: string }).actorAdminId},${(l as { createdAt: string }).createdAt}`,
      ),
    ];
    res.type('text/csv').send(lines.join('\n'));
  }),
);

// silence unused defaults
void DEFAULT_FOLLOWER_TITLES;
void DEFAULT_STREAK_TIERS;

export default router;
