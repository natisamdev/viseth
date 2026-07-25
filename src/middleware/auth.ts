import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { auth as firebaseAuth, db } from '../config/firebase';
import type { AdminDoc, AdminRole, AppRole, AuthAdmin, AuthPrincipal, AuthUser } from '../types';
import { forbidden, unauthorized } from '../utils/errors';
import {
  attractionIdsForUser,
  findUserByFirebaseUid,
  upsertFromFirebase,
} from '../services/users';

declare global {
  namespace Express {
    interface Request {
      principal?: AuthPrincipal;
      requestId?: string;
    }
  }
}

export async function requireAppAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    const token = header.slice(7);

    // Dev bypass: Authorization: Bearer dev:<userId|firebaseUid|role>
    if (env.nodeEnv !== 'production' && token.startsWith('dev:')) {
      const key = token.slice(4);
      const byId = await db().collection('users').doc(key).get();
      let userDoc = byId.exists ? (byId.data() as import('../types').UserDoc) : null;
      if (!userDoc) {
        const byUid = await findUserByFirebaseUid(key);
        userDoc = byUid;
      }
      if (!userDoc) {
        const byRole = await db().collection('users').where('role', '==', key).limit(1).get();
        if (!byRole.empty) userDoc = byRole.docs[0].data() as import('../types').UserDoc;
      }
      if (!userDoc) throw unauthorized('Unknown dev user');
      if (userDoc.status === 'suspended') throw forbidden('Account suspended', 'SUSPENDED');
      req.principal = {
        kind: 'app',
        userId: userDoc.id,
        firebaseUid: userDoc.firebaseUid,
        role: userDoc.role,
        attractionIds: await attractionIdsForUser(userDoc),
      };
      next();
      return;
    }

    // Prefer Firebase ID tokens for mobile
    try {
      const decoded = await firebaseAuth().verifyIdToken(token);
      let user = await findUserByFirebaseUid(decoded.uid);
      if (!user) user = await upsertFromFirebase(decoded);
      if (user.status === 'suspended') throw forbidden('Account suspended', 'SUSPENDED');
      const attractionIds = await attractionIdsForUser(user);
      const principal: AuthUser = {
        kind: 'app',
        userId: user.id,
        firebaseUid: user.firebaseUid,
        role: user.role,
        attractionIds,
      };
      req.principal = principal;
      next();
      return;
    } catch (e) {
      if ((e as { status?: number }).status) throw e;
      // fall through to admin JWT if Firebase fails
    }

    // Admin JWT may also hit some shared routes
    const payload = jwt.verify(token, env.jwtAccessSecret) as {
      sub: string;
      role: AdminRole;
      attractionId: string | null;
      email: string;
      typ: string;
    };
    if (payload.typ !== 'access') throw unauthorized('Invalid token');
    req.principal = {
      kind: 'admin',
      adminId: payload.sub,
      role: payload.role,
      attractionId: payload.attractionId,
      email: payload.email,
    };
    next();
  } catch (err) {
    next(err instanceof Error && 'status' in err ? err : unauthorized());
  }
}

export function requireRoles(...roles: Array<AppRole | AdminRole>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const p = req.principal;
    if (!p) return next(unauthorized());
    const role = p.kind === 'app' ? p.role : p.role;
    if (!roles.includes(role)) return next(forbidden());
    next();
  };
}

export async function optionalAppAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    next();
    return;
  }
  return requireAppAuth(req, _res, next);
}

export async function requireAdminAuth(req: Request, _res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    const token = header.slice(7);
    const payload = jwt.verify(token, env.jwtAccessSecret) as {
      sub: string;
      role: AdminRole;
      attractionId: string | null;
      email: string;
      typ: string;
    };
    if (payload.typ !== 'access') throw unauthorized('Invalid token');
    const snap = await db().collection('admins').doc(payload.sub).get();
    if (!snap.exists) throw unauthorized();
    const admin = snap.data() as AdminDoc;
    if (!admin.active) throw forbidden('Admin inactive');
    const principal: AuthAdmin = {
      kind: 'admin',
      adminId: admin.id,
      role: admin.role,
      attractionId: admin.attractionId,
      email: admin.email,
    };
    req.principal = principal;
    next();
  } catch (err) {
    next(err instanceof Error && 'status' in err ? err : unauthorized());
  }
}

export function requireAdminRoles(...roles: AdminRole[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const p = req.principal;
    if (!p || p.kind !== 'admin') return next(unauthorized());
    if (!roles.includes(p.role)) return next(forbidden());
    next();
  };
}

export function asAppUser(req: Request): AuthUser {
  if (!req.principal || req.principal.kind !== 'app') {
    throw unauthorized();
  }
  return req.principal;
}

export function asAdmin(req: Request): AuthAdmin {
  if (!req.principal || req.principal.kind !== 'admin') {
    throw unauthorized();
  }
  return req.principal;
}
