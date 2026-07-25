import bcrypt from 'bcryptjs';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { db } from '../config/firebase';
import { env } from '../config/env';
import type { AdminDoc, AdminRole } from '../types';
import { id } from '../utils/ids';
import { nowIso } from '../utils/time';
import { forbidden, notFound, unauthorized } from '../utils/errors';

type TokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

function signTokens(admin: AdminDoc): TokenPair {
  const accessToken = jwt.sign(
    {
      sub: admin.id,
      role: admin.role,
      attractionId: admin.attractionId,
      email: admin.email,
      typ: 'access',
    },
    env.jwtAccessSecret,
    { expiresIn: env.jwtAccessTtlSeconds as SignOptions['expiresIn'] },
  );
  const refreshToken = jwt.sign(
    { sub: admin.id, typ: 'refresh' },
    env.jwtRefreshSecret,
    { expiresIn: env.jwtRefreshTtlSeconds as SignOptions['expiresIn'] },
  );
  return {
    accessToken,
    refreshToken,
    expiresIn: env.jwtAccessTtlSeconds,
  };
}

function publicAdmin(admin: AdminDoc) {
  return {
    id: admin.id,
    email: admin.email,
    displayName: admin.displayName,
    role: admin.role,
    attractionId: admin.attractionId,
  };
}

export async function loginAdmin(email: string, password: string) {
  const snap = await db().collection('admins').where('email', '==', email.toLowerCase()).limit(1).get();
  if (snap.empty) throw unauthorized('Invalid credentials');
  const admin = snap.docs[0].data() as AdminDoc;
  if (!admin.active) throw forbidden('Admin inactive');
  const ok = await bcrypt.compare(password, admin.passwordHash);
  if (!ok) throw unauthorized('Invalid credentials');
  const tokens = signTokens(admin);
  await db().collection('admin_refresh_tokens').doc(admin.id).set({
    adminId: admin.id,
    tokenHash: await bcrypt.hash(tokens.refreshToken, 8),
    updatedAt: nowIso(),
  });
  return { ...tokens, admin: publicAdmin(admin) };
}

export async function refreshAdmin(refreshToken: string) {
  let payload: { sub: string; typ: string };
  try {
    payload = jwt.verify(refreshToken, env.jwtRefreshSecret) as { sub: string; typ: string };
  } catch {
    throw unauthorized('Invalid refresh token');
  }
  if (payload.typ !== 'refresh') throw unauthorized('Invalid refresh token');
  const stored = await db().collection('admin_refresh_tokens').doc(payload.sub).get();
  if (!stored.exists) throw unauthorized('Refresh revoked');
  const ok = await bcrypt.compare(
    refreshToken,
    (stored.data() as { tokenHash: string }).tokenHash,
  );
  if (!ok) throw unauthorized('Refresh revoked');
  const adminSnap = await db().collection('admins').doc(payload.sub).get();
  if (!adminSnap.exists) throw unauthorized();
  const admin = adminSnap.data() as AdminDoc;
  if (!admin.active) throw forbidden('Admin inactive');
  const tokens = signTokens(admin);
  await db().collection('admin_refresh_tokens').doc(admin.id).set({
    adminId: admin.id,
    tokenHash: await bcrypt.hash(tokens.refreshToken, 8),
    updatedAt: nowIso(),
  });
  return { ...tokens, admin: publicAdmin(admin) };
}

export async function logoutAdmin(adminId: string) {
  await db().collection('admin_refresh_tokens').doc(adminId).delete();
}

export async function changePassword(
  adminId: string,
  currentPassword: string,
  newPassword: string,
) {
  const snap = await db().collection('admins').doc(adminId).get();
  if (!snap.exists) throw notFound();
  const admin = snap.data() as AdminDoc;
  const ok = await bcrypt.compare(currentPassword, admin.passwordHash);
  if (!ok) throw unauthorized('Current password incorrect');
  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db()
    .collection('admins')
    .doc(adminId)
    .set({ passwordHash, updatedAt: nowIso() }, { merge: true });
}

export async function getAdmin(adminId: string): Promise<AdminDoc> {
  const snap = await db().collection('admins').doc(adminId).get();
  if (!snap.exists) throw notFound('Admin not found');
  return snap.data() as AdminDoc;
}

export async function createAdmin(input: {
  email: string;
  displayName: string;
  phone?: string;
  role: AdminRole;
  attractionId: string | null;
  password: string;
}): Promise<AdminDoc> {
  const admin: AdminDoc = {
    id: id('au'),
    email: input.email.toLowerCase(),
    displayName: input.displayName,
    phone: input.phone ?? null,
    avatarUrl: null,
    role: input.role,
    attractionId: input.attractionId,
    passwordHash: await bcrypt.hash(input.password, 10),
    active: true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await db().collection('admins').doc(admin.id).set(admin);
  return admin;
}

export { publicAdmin };
