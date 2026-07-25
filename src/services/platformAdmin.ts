import { db } from '../config/firebase';
import type { RecapDoc, TransactionDoc, VisitDoc } from '../types';
import { id } from '../utils/ids';
import { nowIso } from '../utils/time';
import { getSettings, putSettings, getFeatureFlags, setFeatureFlag } from './settings';
import { createAdmin, publicAdmin } from './adminAuth';
import { createAttraction, listAttractions, patchAttraction } from './attractions';
import { enrichAttractionWithFirecrawl } from './ai';
import { badRequest, notFound } from '../utils/errors';
import type { AdminDoc, AttractionDoc, GuideDoc } from '../types';
import { env } from '../config/env';

export async function platformOverview() {
  const [attractions, txSnap, visitsSnap, adminsSnap, reportsSnap, recapsSnap, guidesSnap] =
    await Promise.all([
      listAttractions({ includeInactive: true }),
      db().collection('transactions').get(),
      db().collection('visits').get(),
      db().collection('admins').get(),
      db().collection('social_reports').where('status', '==', 'open').get(),
      db().collection('recap_posts').where('status', '==', 'flagged').get(),
      db().collection('guides').get(),
    ]);

  const txs = txSnap.docs.map((d) => d.data() as TransactionDoc);
  const succeeded = txs.filter((t) => t.status === 'succeeded');
  const grossVolume = succeeded.reduce((s, t) => s + t.amount, 0);
  const commissionTotal = succeeded.reduce((s, t) => s + t.commission, 0);

  const placeAdmins = adminsSnap.docs
    .map((d) => d.data() as AdminDoc)
    .filter((a) => a.role === 'place_admin' && a.active);
  const sitesWithAdmin = new Set(placeAdmins.map((a) => a.attractionId).filter(Boolean));
  const sitesWithoutAdmin = attractions.filter((a) => a.active && !sitesWithAdmin.has(a.id)).length;

  const guides = guidesSnap.docs.map((d) => d.data() as GuideDoc);
  const guidesPending = guides.filter((g) => !g.active || !g.verified).length;

  const supportSnap = await db().collection('support_cases').where('status', '==', 'open').get();

  // visits by day (last 14)
  const visits = visitsSnap.docs.map((d) => d.data() as VisitDoc);
  const byDay = new Map<string, number>();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    byDay.set(d, 0);
  }
  for (const v of visits) {
    const day = v.scannedAt.slice(0, 10);
    if (byDay.has(day)) byDay.set(day, (byDay.get(day) ?? 0) + 1);
  }

  const revenueByAttraction = attractions.map((a) => {
    const gross = succeeded
      .filter((t) => t.attractionId === a.id)
      .reduce((s, t) => s + t.amount, 0);
    return { attractionId: a.id, name: a.name, gross: Number(gross.toFixed(2)) };
  });

  return {
    netRevenue: Number(commissionTotal.toFixed(2)),
    grossVolume: Number(grossVolume.toFixed(2)),
    verifiedVisits: visits.length,
    liveSites: attractions.filter((a) => a.active).length,
    activePlaceAdmins: placeAdmins.length,
    queues: {
      sitesWithoutAdmin,
      openSupport: supportSnap.size,
      flaggedRecaps: recapsSnap.size,
      openSocialReports: reportsSnap.size,
      guidesPending,
    },
    visitsByDay: [...byDay.entries()].map(([date, visitCount]) => ({
      date,
      visits: visitCount,
    })),
    revenueByAttraction,
  };
}

export async function createPlatformAttraction(body: Partial<AttractionDoc>) {
  if (!body.name || !body.region || body.ticketPrice == null || body.lat == null || body.lng == null) {
    throw badRequest('VALIDATION', 'name, region, ticketPrice, lat, lng required');
  }
  return createAttraction({
    name: body.name,
    amharicName: body.amharicName ?? null,
    address: body.address ?? '',
    region: body.region,
    category: body.category ?? 'heritage',
    description: body.description ?? '',
    summary: body.summary ?? '',
    lat: body.lat,
    lng: body.lng,
    ticketPrice: body.ticketPrice,
    active: body.active ?? true,
    isUnesco: body.isUnesco ?? false,
    openHours: body.openHours ?? '09:00–17:00',
    tags: body.tags ?? [],
    coverImageUrl: body.coverImageUrl ?? null,
  });
}

export async function activateAttraction(attractionId: string, active: boolean) {
  return patchAttraction(attractionId, { active });
}

export async function createPlaceAdmin(input: {
  name: string;
  email: string;
  phone?: string;
  attractionId: string;
  temporaryPassword: string;
}) {
  await getAttractionSafe(input.attractionId);
  const admin = await createAdmin({
    email: input.email,
    displayName: input.name,
    phone: input.phone,
    role: 'place_admin',
    attractionId: input.attractionId,
    password: input.temporaryPassword,
  });
  return { ...publicAdmin(admin), temporaryPassword: input.temporaryPassword };
}

async function getAttractionSafe(id: string) {
  const snap = await db().collection('attractions').doc(id).get();
  if (!snap.exists) throw notFound('Attraction not found');
  return snap.data() as AttractionDoc;
}

export async function listPlaceAdmins() {
  const snap = await db().collection('admins').where('role', '==', 'place_admin').get();
  return snap.docs.map((d) => publicAdmin(d.data() as AdminDoc));
}

export async function patchPlaceAdmin(adminId: string, patch: Partial<AdminDoc>) {
  await db()
    .collection('admins')
    .doc(adminId)
    .set({ ...patch, updatedAt: nowIso() }, { merge: true });
  const snap = await db().collection('admins').doc(adminId).get();
  return publicAdmin(snap.data() as AdminDoc);
}

export async function listPlatformGuides() {
  const snap = await db().collection('guides').get();
  return snap.docs.map((d) => d.data() as GuideDoc);
}

export async function patchPlatformGuide(
  userId: string,
  patch: { active?: boolean; verified?: boolean },
) {
  await db().collection('guides').doc(userId).set(patch, { merge: true });
  const snap = await db().collection('guides').doc(userId).get();
  if (!snap.exists) throw notFound('Guide not found');
  return snap.data();
}

export async function listPlatformRecaps(status?: string) {
  const snap = await db().collection('recap_posts').get();
  let items = snap.docs.map((d) => d.data() as RecapDoc);
  if (status) items = items.filter((r) => r.status === status);
  return items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function keepRecap(recapId: string) {
  await db()
    .collection('recap_posts')
    .doc(recapId)
    .set({ status: 'published' }, { merge: true });
}

export async function removeRecap(recapId: string, reason: string, adminId: string) {
  if (!reason?.trim()) throw badRequest('REASON_REQUIRED', 'reason required');
  await db()
    .collection('recap_posts')
    .doc(recapId)
    .set({ status: 'removed', removalReason: reason }, { merge: true });
  await db().collection('audit_log').add({
    id: id('aud'),
    category: 'content',
    action: 'remove_recap',
    actorAdminId: adminId,
    targetId: recapId,
    reason,
    createdAt: nowIso(),
  });
}

export async function listSocialReports(filters: { status?: string; category?: string }) {
  const snap = await db().collection('social_reports').get();
  let items = snap.docs.map((d) => d.data() as Record<string, unknown>);
  if (filters.status) items = items.filter((r) => r.status === filters.status);
  if (filters.category) items = items.filter((r) => r.category === filters.category);
  return items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

export async function resolveSocialReport(
  reportId: string,
  input: {
    status: 'actioned' | 'dismissed';
    resolutionNote: string;
    suspendUser?: boolean;
    adminId: string;
  },
) {
  if (!input.resolutionNote?.trim()) {
    throw badRequest('NOTE_REQUIRED', 'resolutionNote required');
  }
  const snap = await db().collection('social_reports').doc(reportId).get();
  if (!snap.exists) throw notFound('Report not found');
  const report = snap.data() as { reportedUserId?: string };
  await db()
    .collection('social_reports')
    .doc(reportId)
    .set(
      {
        status: input.status,
        resolutionNote: input.resolutionNote,
        resolvedByAdminId: input.adminId,
        resolvedAt: nowIso(),
      },
      { merge: true },
    );
  if (input.suspendUser && report.reportedUserId) {
    await db()
      .collection('users')
      .doc(report.reportedUserId)
      .set({ status: 'suspended', updatedAt: nowIso() }, { merge: true });
  }
}

export async function listTransactions() {
  const snap = await db().collection('transactions').get();
  return snap.docs
    .map((d) => d.data() as TransactionDoc)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listPayouts() {
  const snap = await db().collection('payouts').get();
  return snap.docs.map((d) => d.data());
}

export async function payoutAction(
  payoutId: string,
  action: 'hold' | 'release' | 'mark-paid',
  adminId: string,
  reason?: string,
) {
  const status =
    action === 'hold' ? 'on_hold' : action === 'release' ? 'scheduled' : 'paid';
  await db()
    .collection('payouts')
    .doc(payoutId)
    .set({ status, reason: reason ?? null, updatedAt: nowIso() }, { merge: true });
  await db().collection('audit_log').add({
    id: id('aud'),
    category: 'money',
    action: `payout_${action}`,
    actorAdminId: adminId,
    targetId: payoutId,
    reason: reason ?? null,
    createdAt: nowIso(),
  });
}

export async function listSupportCases() {
  const snap = await db().collection('support_cases').get();
  return snap.docs.map((d) => d.data());
}

export async function updateSupportCase(
  caseId: string,
  status: string,
  resolution?: string,
) {
  await db()
    .collection('support_cases')
    .doc(caseId)
    .set({ status, resolution: resolution ?? null, updatedAt: nowIso() }, { merge: true });
}

export async function getPlatformSettings() {
  return getSettings();
}

export async function updatePlatformSettings(patch: Record<string, unknown>) {
  return putSettings(patch as never);
}

export async function getFlags() {
  return getFeatureFlags();
}

export async function patchFlag(key: string, enabled: boolean) {
  return setFeatureFlag(key as never, enabled);
}

export async function listAnnouncements() {
  const snap = await db().collection('announcements').get();
  return snap.docs.map((d) => d.data());
}

export async function createAnnouncement(input: {
  title: string;
  body: string;
  audience: string;
}) {
  const doc = {
    id: id('ann'),
    ...input,
    createdAt: nowIso(),
  };
  await db().collection('announcements').doc(doc.id).set(doc);
  return doc;
}

export async function listApiCredentials() {
  const snap = await db().collection('api_credentials').get();
  return snap.docs.map((d) => {
    const data = d.data() as Record<string, unknown>;
    const { secretHash: _, ...rest } = data;
    return rest;
  });
}

export async function issueApiCredential(scope: string, adminId: string) {
  const secret = `vk_live_${id('key')}`;
  const bcrypt = await import('bcryptjs');
  const doc = {
    id: id('key'),
    scope,
    prefix: secret.slice(0, 12),
    secretHash: await bcrypt.hash(secret, 10),
    active: true,
    createdBy: adminId,
    createdAt: nowIso(),
  };
  await db().collection('api_credentials').doc(doc.id).set(doc);
  return { ...doc, secret, secretHash: undefined };
}

export async function integrationsHealth() {
  return [
    {
      id: 'telebirr',
      name: 'Telebirr',
      status: env.isMockPayments ? 'mock' : env.telebirrConfigured ? 'configured' : 'missing',
    },
    { id: 'firebase', name: 'Firebase', status: 'configured' },
    { id: 'firecrawl', name: 'Firecrawl', status: env.firecrawlApiKey ? 'configured' : 'stub' },
    {
      id: 'whisperflow',
      name: 'Whisperflow',
      status: env.whisperflowApiKey ? 'configured' : 'stub',
    },
    {
      id: 'elevenlabs',
      name: 'ElevenLabs',
      status: env.elevenLabsApiKey ? 'configured' : 'stub',
    },
    { id: 'fal', name: 'Fal', status: env.falApiKey ? 'configured' : 'stub' },
  ];
}

export async function auditLog() {
  const snap = await db().collection('audit_log').get();
  return snap.docs
    .map((d) => d.data())
    .sort((a, b) =>
      String((b as { createdAt: string }).createdAt).localeCompare(
        String((a as { createdAt: string }).createdAt),
      ),
    );
}

export async function enrichAttraction(attractionId: string) {
  return enrichAttractionWithFirecrawl(attractionId);
}

export { listAttractions, patchAttraction };
