import { Router } from 'express';
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
  checkoutGift,
  checkoutTicket,
  getTransaction,
  handleTelebirrWebhook,
  mockComplete,
  refundTransaction,
  syncPaymentStatus,
} from '../services/payments';
import { getUser } from '../services/users';
import { listMyGifts, listMyTickets, getTicketForOwner } from '../services/tickets';
import { verifyScan } from '../services/scans';
import { getPassport } from '../services/passport';
import { parsePage, paginate } from '../utils/pagination';
import { badRequest } from '../utils/errors';
import { env } from '../config/env';

const router = Router();

router.post(
  '/payments/tickets/checkout',
  requireAppAuth,
  requireRoles('traveler'),
  asyncHandler(async (req, res) => {
    const user = await getUser(asAppUser(req).userId);
    const body = z
      .object({
        attractionId: z.string(),
        holderName: z.string().min(2).max(80),
        guests: z.number().int().min(1).max(20),
        visitDate: z.string(),
        returnUrl: z.string().min(1),
      })
      .parse(req.body);
    const key = req.header('Idempotency-Key');
    if (!key) throw badRequest('IDEMPOTENCY_REQUIRED', 'Idempotency-Key required');
    const result = await checkoutTicket({
      user,
      ...body,
      idempotencyKey: key,
    });
    res.status(201).json(result);
  }),
);

router.post(
  '/payments/gifts/checkout',
  requireAppAuth,
  requireRoles('traveler'),
  asyncHandler(async (req, res) => {
    const user = await getUser(asAppUser(req).userId);
    const body = z
      .object({
        attractionId: z.string(),
        recipientNames: z.array(z.string()).min(1).max(20),
        greeting: z.string().max(500).optional(),
        visitDate: z.string().optional(),
        returnUrl: z.string().min(1),
      })
      .parse(req.body);
    const key = req.header('Idempotency-Key');
    if (!key) throw badRequest('IDEMPOTENCY_REQUIRED', 'Idempotency-Key required');
    const result = await checkoutGift({
      user,
      ...body,
      idempotencyKey: key,
    });
    res.status(201).json(result);
  }),
);

/** Browser return landing (Telebirr redirect_url) — must be before :transactionId */
router.get(
  '/payments/return',
  asyncHandler(async (req, res) => {
    const ref = String(
      req.query.merch_order_id ?? req.query.tx_ref ?? req.query.outTradeNo ?? '',
    );
    if (ref) {
      try {
        await syncPaymentStatus(ref);
      } catch {
        /* client will poll */
      }
    }
    res.send(`<!doctype html><html><body style="font-family:sans-serif;padding:2rem">
      <h1>Payment processing</h1>
      <p>You can return to the Viseth app. Reference: ${ref || '—'}</p>
      <p>Provider: Telebirr · mode: ${env.telebirrMode}</p>
    </body></html>`);
  }),
);

/** Dev helper: complete a mock Telebirr payment */
router.get(
  '/payments/mock-checkout',
  asyncHandler(async (req, res) => {
    const txRef = String(req.query.tx_ref ?? '');
    if (!txRef) {
      res.status(400).send('Missing tx_ref');
      return;
    }
    await mockComplete(txRef);
    res.send(
      `<html><body style="font-family:sans-serif;padding:2rem">
        <h1>Payment succeeded (mock Telebirr)</h1>
        <p>Reference: ${txRef}</p>
        <p>Return to the Viseth app.</p>
      </body></html>`,
    );
  }),
);

/** Telebirr notify_url (server-to-server) — no user auth */
router.post(
  '/webhooks/telebirr',
  asyncHandler(async (req, res) => {
    const ack = await handleTelebirrWebhook(req.body);
    res.json(ack);
  }),
);

/** Legacy alias */
router.post(
  '/webhooks/chapa',
  asyncHandler(async (req, res) => {
    const ack = await handleTelebirrWebhook({
      merch_order_id: req.body?.tx_ref ?? req.body?.merch_order_id,
      trade_status:
        req.body?.status === 'success' || req.body?.status === 'successful'
          ? 'PAY_SUCCESS'
          : req.body?.trade_status ?? req.body?.status,
    });
    res.json(ack);
  }),
);

router.get(
  '/payments/:transactionId',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    const principal = req.principal!;
    if (principal.kind === 'admin') {
      res.json(
        await getTransaction(
          p(req, 'transactionId'),
          undefined,
          principal.role === 'super_admin',
        ),
      );
      return;
    }
    res.json(await getTransaction(p(req, 'transactionId'), principal.userId));
  }),
);

/** Sync status from Telebirr after user returns from paygate */
router.post(
  '/payments/:transactionId/sync',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    const txn = await getTransaction(
      p(req, 'transactionId'),
      req.principal?.kind === 'app' ? req.principal.userId : undefined,
      req.principal?.kind === 'admin' && req.principal.role === 'super_admin',
    );
    const synced = await syncPaymentStatus(txn.reference);
    res.json({ ...synced, transactionId: txn.id, reference: txn.reference });
  }),
);

router.post(
  '/payments/:transactionId/refund',
  requireAdminAuth,
  requireAdminRoles('super_admin'),
  asyncHandler(async (req, res) => {
    const body = z.object({ reason: z.string().min(1) }).parse(req.body);
    await refundTransaction(p(req, 'transactionId'), body.reason, asAdmin(req).adminId);
    res.status(204).send();
  }),
);

router.get(
  '/tickets/mine',
  requireAppAuth,
  requireRoles('traveler', 'guide'),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    const items = await listMyTickets(
      asAppUser(req).userId,
      req.query.status as string | undefined,
    );
    res.json(paginate(items, page, pageSize));
  }),
);

router.get(
  '/tickets/:id',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    res.json(await getTicketForOwner(p(req, 'id'), asAppUser(req).userId));
  }),
);

router.get(
  '/gifts/mine',
  requireAppAuth,
  requireRoles('traveler'),
  asyncHandler(async (req, res) => {
    res.json(await listMyGifts(asAppUser(req).userId));
  }),
);

router.post(
  '/scans/verify',
  requireAppAuth,
  requireRoles('gatekeeper'),
  asyncHandler(async (req, res) => {
    const body = z
      .object({
        code: z.string().min(1),
        attractionId: z.string(),
      })
      .parse(req.body);
    const user = asAppUser(req);
    const result = await verifyScan({
      code: body.code,
      attractionId: body.attractionId,
      gatekeeperUserId: user.userId,
      gatekeeperAttractionIds: user.attractionIds,
    });
    res.status(result.valid ? 200 : 422).json(result);
  }),
);

router.get(
  '/passport/me',
  requireAppAuth,
  requireRoles('traveler', 'guide', 'gatekeeper'),
  asyncHandler(async (req, res) => {
    res.json(await getPassport(asAppUser(req).userId));
  }),
);

export default router;
