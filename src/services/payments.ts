import { db } from '../config/firebase';
import { env } from '../config/env';
import type { GiftDoc, TicketDoc, TransactionDoc, UserDoc } from '../types';
import { attractionSlug, giftKeycode, id, paymentRef, ticketCode } from '../utils/ids';
import { commissionAmount, feeAmount, ticketAmount } from '../utils/money';
import { hoursFromNow, nowIso } from '../utils/time';
import {
  badRequest,
  conflict,
  forbidden,
  notFound,
  unauthorized,
} from '../utils/errors';
import { getAttraction } from './attractions';
import {
  initializePayment,
  isSuccessStatus,
  parseNotifyPayload,
  refundPayment,
  verifyPayment,
} from './telebirr';
import { assertNotMaintenance, getFeatureFlags, getSettings } from './settings';
import { signQrPayload } from '../utils/qr';
import { getUser } from './users';

async function findByIdempotency(key: string): Promise<TransactionDoc | null> {
  const snap = await db()
    .collection('transactions')
    .where('idempotencyKey', '==', key)
    .limit(1)
    .get();
  if (snap.empty) return null;
  return snap.docs[0].data() as TransactionDoc;
}

function emptyTxnFields(partial: Omit<TransactionDoc, 'checkoutUrl' | 'chapaCheckoutUrl' | 'paymentProvider'>): TransactionDoc {
  return {
    ...partial,
    checkoutUrl: null,
    chapaCheckoutUrl: null,
    paymentProvider: env.isMockPayments ? 'mock' : 'telebirr',
  };
}

export async function checkoutTicket(input: {
  user: UserDoc;
  attractionId: string;
  holderName: string;
  guests: number;
  visitDate: string;
  returnUrl: string;
  idempotencyKey: string;
}): Promise<Record<string, unknown>> {
  await assertNotMaintenance();
  if (!input.idempotencyKey) throw badRequest('IDEMPOTENCY_REQUIRED', 'Idempotency-Key required');
  const existing = await findByIdempotency(input.idempotencyKey);
  if (existing) return serializeCheckout(existing);

  const attraction = await getAttraction(input.attractionId);
  if (input.guests < 1 || input.guests > 20) {
    throw badRequest('INVALID_GUESTS', 'guests must be 1–20');
  }

  const settings = await getSettings();
  const amount = ticketAmount(attraction.ticketPrice, input.guests);
  const fee = feeAmount(amount, settings.platformFeePercent);
  const total = amount + fee;
  const commission = commissionAmount(amount, settings.commissionRate);
  const reference = paymentRef();
  const txnId = id('txn');
  const ticketId = id('tkt');

  const txn = emptyTxnFields({
    id: txnId,
    reference,
    kind: 'ticket',
    status: 'pending',
    payerUserId: input.user.id,
    payerName: input.user.displayName,
    attractionId: attraction.id,
    guideId: null,
    hotelId: null,
    bookingId: null,
    amount,
    fee,
    commission,
    commissionRate: settings.commissionRate,
    failureReason: null,
    metadata: { ticketId, guests: input.guests },
    idempotencyKey: input.idempotencyKey,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  const ticket: TicketDoc = {
    id: ticketId,
    code: ticketCode(attractionSlug(attraction.name)),
    qrPayload: null,
    attractionId: attraction.id,
    holderUserId: input.user.id,
    holderName: input.holderName,
    guests: input.guests,
    visitDate: input.visitDate,
    purchaserUserId: input.user.id,
    purchaserName: input.user.displayName,
    amount,
    status: 'pending_payment',
    giftId: null,
    transactionId: txnId,
    purchasedAt: null,
    usedAt: null,
    expiresAt: null,
    voidReason: null,
  };

  const pay = await initializePayment({
    amount: total,
    title: `Viseth ticket · ${attraction.name}`,
    reference,
    returnUrl: input.returnUrl,
    callbackInfo: txnId,
  });
  txn.checkoutUrl = pay.checkoutUrl;
  txn.chapaCheckoutUrl = pay.checkoutUrl;
  txn.paymentProvider = pay.provider === 'telebirr' ? 'telebirr' : 'mock';

  await db().collection('transactions').doc(txnId).set(txn);
  await db().collection('tickets').doc(ticketId).set(ticket);

  return serializeCheckout(txn);
}

export async function checkoutGift(input: {
  user: UserDoc;
  attractionId: string;
  recipientNames: string[];
  greeting?: string;
  visitDate?: string;
  returnUrl: string;
  idempotencyKey: string;
}): Promise<Record<string, unknown>> {
  await assertNotMaintenance();
  const flags = await getFeatureFlags();
  if (!flags.diaspora_gifting) throw forbidden('Diaspora gifting disabled', 'FEATURE_DISABLED');
  if (!input.idempotencyKey) throw badRequest('IDEMPOTENCY_REQUIRED', 'Idempotency-Key required');

  const existing = await findByIdempotency(input.idempotencyKey);
  if (existing) return { ...serializeCheckout(existing), recipients: input.recipientNames.length };

  if (input.recipientNames.length < 1 || input.recipientNames.length > 20) {
    throw badRequest('INVALID_RECIPIENTS', 'recipientNames length must be 1–20');
  }
  for (const n of input.recipientNames) {
    if (n.trim().length < 2 || n.trim().length > 80) {
      throw badRequest('INVALID_NAME', 'Each recipient name must be 2–80 chars');
    }
  }

  const attraction = await getAttraction(input.attractionId);
  const settings = await getSettings();
  const guests = input.recipientNames.length;
  const amount = ticketAmount(attraction.ticketPrice, guests);
  const fee = feeAmount(amount, settings.platformFeePercent);
  const total = amount + fee;
  const commission = commissionAmount(amount, settings.commissionRate);
  const reference = paymentRef();
  const txnId = id('txn');
  const giftId = id('gft');

  const txn = emptyTxnFields({
    id: txnId,
    reference,
    kind: 'gift',
    status: 'pending',
    payerUserId: input.user.id,
    payerName: input.user.displayName,
    attractionId: attraction.id,
    guideId: null,
    hotelId: null,
    bookingId: null,
    amount,
    fee,
    commission,
    commissionRate: settings.commissionRate,
    failureReason: null,
    metadata: { giftId, recipients: guests },
    idempotencyKey: input.idempotencyKey,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });

  const gift: GiftDoc = {
    id: giftId,
    keycode: null,
    attractionId: attraction.id,
    senderUserId: input.user.id,
    senderName: input.user.displayName,
    recipientNames: input.recipientNames.map((n) => n.trim()),
    greeting: input.greeting ?? null,
    visitDate: input.visitDate ?? null,
    recipientsTotal: guests,
    redeemedCount: 0,
    status: 'pending_payment',
    transactionId: txnId,
    createdAt: nowIso(),
    expiresAt: null,
    revokeReason: null,
  };

  const pay = await initializePayment({
    amount: total,
    title: `Viseth gift · ${attraction.name}`,
    reference,
    returnUrl: input.returnUrl,
    callbackInfo: txnId,
  });
  txn.checkoutUrl = pay.checkoutUrl;
  txn.chapaCheckoutUrl = pay.checkoutUrl;
  txn.paymentProvider = pay.provider === 'telebirr' ? 'telebirr' : 'mock';

  await db().collection('transactions').doc(txnId).set(txn);
  await db().collection('gifts').doc(giftId).set(gift);

  return { ...serializeCheckout(txn), recipients: guests };
}

function serializeCheckout(txn: TransactionDoc) {
  const checkoutUrl = txn.checkoutUrl ?? txn.chapaCheckoutUrl;
  return {
    transactionId: txn.id,
    reference: txn.reference,
    checkoutUrl,
    amount: txn.amount,
    fee: txn.fee,
    total: txn.amount + txn.fee,
    currency: 'ETB',
    kind: txn.kind,
    provider: txn.paymentProvider ?? 'telebirr',
  };
}

export async function getTransaction(txnId: string, requesterUserId?: string, isSuper = false) {
  const snap = await db().collection('transactions').doc(txnId).get();
  if (!snap.exists) throw notFound('Payment not found');
  const txn = snap.data() as TransactionDoc;
  if (!isSuper && requesterUserId && txn.payerUserId !== requesterUserId) {
    throw forbidden();
  }
  return {
    id: txn.id,
    reference: txn.reference,
    kind: txn.kind,
    status: txn.status,
    amount: txn.amount,
    fee: txn.fee,
    total: txn.amount + txn.fee,
    currency: 'ETB',
    provider: txn.paymentProvider ?? 'telebirr',
    attractionId: txn.attractionId,
    metadata: txn.metadata,
    createdAt: txn.createdAt,
    updatedAt: txn.updatedAt,
  };
}

export async function finalizeSuccessfulPayment(reference: string): Promise<TransactionDoc> {
  const snap = await db()
    .collection('transactions')
    .where('reference', '==', reference)
    .limit(1)
    .get();
  if (snap.empty) throw notFound('Transaction not found');
  const txn = snap.docs[0].data() as TransactionDoc;
  if (txn.status === 'succeeded') return txn;

  const settings = await getSettings();
  const now = nowIso();

  if (txn.kind === 'ticket') {
    const ticketId = String(txn.metadata.ticketId);
    const ticketSnap = await db().collection('tickets').doc(ticketId).get();
    if (!ticketSnap.exists) throw notFound('Ticket missing for transaction');
    const ticket = ticketSnap.data() as TicketDoc;
    const expMs = Date.now() + settings.ticketExpiryHours * 3600_000;
    const qrPayload = signQrPayload({
      ticketId: ticket.id,
      attractionId: ticket.attractionId,
      exp: Math.floor(expMs / 1000),
    });
    await db()
      .collection('tickets')
      .doc(ticket.id)
      .set(
        {
          status: 'valid',
          qrPayload,
          purchasedAt: now,
          expiresAt: new Date(expMs).toISOString(),
        },
        { merge: true },
      );
  }

  if (txn.kind === 'gift') {
    const giftId = String(txn.metadata.giftId);
    const giftSnap = await db().collection('gifts').doc(giftId).get();
    if (!giftSnap.exists) throw notFound('Gift missing for transaction');
    const gift = giftSnap.data() as GiftDoc;
    const attraction = await getAttraction(gift.attractionId, { allowInactive: true });
    const slug = attractionSlug(attraction.name).slice(0, 3);
    let keycode = giftKeycode(slug);
    for (let i = 0; i < 5; i++) {
      const exists = await db().collection('gifts').where('keycode', '==', keycode).limit(1).get();
      if (exists.empty) break;
      keycode = giftKeycode(slug);
    }
    await db()
      .collection('gifts')
      .doc(gift.id)
      .set(
        {
          status: 'active',
          keycode,
          expiresAt: hoursFromNow(settings.giftKeycodeExpiryHours),
        },
        { merge: true },
      );

    await db().collection('notifications').add({
      id: id('ntf'),
      userId: gift.senderUserId,
      type: 'gift_ready',
      title: 'Gift keycode ready',
      body: `Share ${keycode} with your guests.`,
      readAt: null,
      createdAt: now,
    });
  }

  const updated: Partial<TransactionDoc> = {
    status: 'succeeded',
    updatedAt: now,
  };
  await db().collection('transactions').doc(txn.id).set(updated, { merge: true });
  return { ...txn, ...updated, status: 'succeeded' };
}

export async function failPayment(reference: string, reason: string) {
  const snap = await db()
    .collection('transactions')
    .where('reference', '==', reference)
    .limit(1)
    .get();
  if (snap.empty) return;
  const txn = snap.docs[0].data() as TransactionDoc;
  if (txn.status !== 'pending') return;
  await db()
    .collection('transactions')
    .doc(txn.id)
    .set({ status: 'failed', failureReason: reason, updatedAt: nowIso() }, { merge: true });
}

/** Telebirr server-to-server notify callback */
export async function handleTelebirrWebhook(body: unknown): Promise<{ code: string; msg: string }> {
  const { merchOrderId, tradeStatus } = parseNotifyPayload(body);
  if (!merchOrderId) {
    throw badRequest('MISSING_REF', 'merch_order_id required');
  }

  if (isSuccessStatus(tradeStatus)) {
    // Prefer re-query for trust
    try {
      const verified = await verifyPayment(merchOrderId);
      if (verified === 'succeeded') {
        await finalizeSuccessfulPayment(merchOrderId);
      } else if (verified === 'failed') {
        await failPayment(merchOrderId, tradeStatus ?? 'failed');
      } else {
        // Still mark success if notify says success and query is lagging
        await finalizeSuccessfulPayment(merchOrderId);
      }
    } catch {
      await finalizeSuccessfulPayment(merchOrderId);
    }
  } else if (
    tradeStatus &&
    ['PAY_FAILED', 'ORDER_CLOSED', 'FAILED', 'CANCELLED'].includes(tradeStatus.toUpperCase())
  ) {
    await failPayment(merchOrderId, tradeStatus);
  }

  // Telebirr expects a success acknowledgement
  return { code: '0', msg: 'success' };
}

/** @deprecated kept for old paths — use handleTelebirrWebhook */
export async function handleChapaWebhook(body: {
  tx_ref?: string;
  status?: string;
}): Promise<void> {
  if (body.tx_ref) {
    await handleTelebirrWebhook({
      merch_order_id: body.tx_ref,
      trade_status: body.status === 'success' ? 'PAY_SUCCESS' : body.status,
    });
  }
}

export async function mockComplete(reference: string) {
  const verified = await verifyPayment(reference);
  if (verified === 'succeeded') return finalizeSuccessfulPayment(reference);
  throw conflict('PAYMENT_NOT_SUCCESS', 'Payment not successful');
}

/** Poll Telebirr + finalize if paid (for client return URL). */
export async function syncPaymentStatus(reference: string) {
  const status = await verifyPayment(reference);
  if (status === 'succeeded') {
    const txn = await finalizeSuccessfulPayment(reference);
    return { status: 'succeeded' as const, transactionId: txn.id };
  }
  if (status === 'failed') {
    await failPayment(reference, 'PAY_FAILED');
    return { status: 'failed' as const };
  }
  return { status: 'pending' as const };
}

export async function refundTransaction(txnId: string, reason: string, adminId: string) {
  const snap = await db().collection('transactions').doc(txnId).get();
  if (!snap.exists) throw notFound('Transaction not found');
  const txn = snap.data() as TransactionDoc;
  if (txn.status !== 'succeeded') throw badRequest('NOT_REFUNDABLE', 'Only succeeded payments');

  await refundPayment(txn.reference, txn.amount + txn.fee, reason);

  if (txn.kind === 'ticket' && txn.metadata.ticketId) {
    const tSnap = await db().collection('tickets').doc(String(txn.metadata.ticketId)).get();
    if (tSnap.exists) {
      const t = tSnap.data() as TicketDoc;
      if (t.status === 'valid') {
        await db()
          .collection('tickets')
          .doc(t.id)
          .set({ status: 'voided', voidReason: reason }, { merge: true });
      }
    }
  }
  if (txn.kind === 'gift' && txn.metadata.giftId) {
    const gSnap = await db().collection('gifts').doc(String(txn.metadata.giftId)).get();
    if (gSnap.exists) {
      const g = gSnap.data() as GiftDoc;
      if (g.status === 'active') {
        await db()
          .collection('gifts')
          .doc(g.id)
          .set({ status: 'revoked', revokeReason: reason }, { merge: true });
      }
    }
  }

  await db()
    .collection('transactions')
    .doc(txn.id)
    .set({ status: 'refunded', updatedAt: nowIso() }, { merge: true });

  await db().collection('audit_log').add({
    id: id('aud'),
    category: 'money',
    action: 'refund',
    actorAdminId: adminId,
    targetId: txn.id,
    reason,
    createdAt: nowIso(),
  });
}

export async function requireTraveler(userId: string): Promise<UserDoc> {
  const user = await getUser(userId);
  if (!userId) throw unauthorized();
  return user;
}
