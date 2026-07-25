import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { optionalAppAuth } from '../middleware/auth';
import { getFeatureFlags, getSettings } from '../services/settings';
import { env } from '../config/env';
import { expireTicketsAndGifts } from '../jobs/expireTickets';
import { forbidden } from '../utils/errors';

const router = Router();

router.get(
  '/config',
  optionalAppAuth,
  asyncHandler(async (_req, res) => {
    const settings = await getSettings();
    const featureFlags = await getFeatureFlags();
    res.json({
      maintenanceMode: settings.maintenanceMode,
      supportEmail: settings.supportEmail,
      platformFeePercent: settings.platformFeePercent,
      currency: 'ETB',
      totalRegions: settings.totalRegions,
      paymentProvider: 'telebirr',
      paymentsMode: env.isMockPayments ? 'mock' : env.telebirrMode,
      featureFlags,
    });
  }),
);

router.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'viseth-api',
    version: '1.0.0',
    payments: env.isMockPayments ? 'mock' : 'telebirr',
  });
});

/** Cron: GET /v1/jobs/expire-tickets with header X-Job-Token */
router.post(
  '/jobs/expire-tickets',
  asyncHandler(async (req, res) => {
    const token = req.header('X-Job-Token');
    const expected = process.env.JOB_TOKEN;
    if (!expected || token !== expected) throw forbidden('Invalid job token');
    res.json(await expireTicketsAndGifts());
  }),
);

export default router;
