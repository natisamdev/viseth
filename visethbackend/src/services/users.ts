import { auth, db, FieldValue } from '../config/firebase';
import type { DecodedIdToken } from 'firebase-admin/auth';
import type { AppRole, GatekeeperDoc, GuideDoc, UserDoc, VisitDoc } from '../types';
import { id } from '../utils/ids';
import { nowIso } from '../utils/time';
import { notFound } from '../utils/errors';
import {
  enrichUserPublic,
  heritageScore,
  tierForMonths,
  titleForFollowers,
} from './gamification';
import { getFollowerTitles, getSettings, getStreakTiers } from './settings';
import { monthKey } from '../utils/time';

export async function findUserByFirebaseUid(uid: string): Promise<UserDoc | null> {
  const snap = await db().collection('users').where('firebaseUid', '==', uid).limit(1).get();
  if (snap.empty) return null;
  return snap.docs[0].data() as UserDoc;
}

export async function getUser(userId: string): Promise<UserDoc> {
  const snap = await db().collection('users').doc(userId).get();
  if (!snap.exists) throw notFound('User not found');
  return snap.data() as UserDoc;
}

export async function upsertFromFirebase(token: DecodedIdToken): Promise<UserDoc> {
  const existing = await findUserByFirebaseUid(token.uid);
  if (existing) {
    const patch: Partial<UserDoc> = { updatedAt: nowIso() };
    if (token.email && !existing.email) patch.email = token.email;
    if (token.phone_number && !existing.phone) patch.phone = token.phone_number;
    if (token.name && existing.displayName.startsWith('Traveler')) {
      patch.displayName = token.name;
    }
    if (Object.keys(patch).length > 1) {
      await db().collection('users').doc(existing.id).set(patch, { merge: true });
      return { ...existing, ...patch };
    }
    return existing;
  }

  const userId = id('usr');
  const user: UserDoc = {
    id: userId,
    firebaseUid: token.uid,
    email: token.email ?? null,
    phone: token.phone_number ?? null,
    displayName: token.name ?? token.email?.split('@')[0] ?? 'Traveler',
    username: null,
    photoUrl: token.picture ?? null,
    bio: '',
    region: null,
    role: 'traveler',
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
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  await db().collection('users').doc(userId).set(user);
  return user;
}

export async function patchUser(
  userId: string,
  patch: Partial<
    Pick<
      UserDoc,
      | 'displayName'
      | 'photoUrl'
      | 'phone'
      | 'bio'
      | 'region'
      | 'username'
      | 'isDiaspora'
      | 'hasCompletedFirstPurchase'
    >
  >,
): Promise<UserDoc> {
  const data = { ...patch, updatedAt: nowIso() };
  await db().collection('users').doc(userId).set(data, { merge: true });
  return getUser(userId);
}

export async function getGuide(userId: string): Promise<GuideDoc | null> {
  const snap = await db().collection('guides').doc(userId).get();
  return snap.exists ? (snap.data() as GuideDoc) : null;
}

export async function getGatekeeper(userId: string): Promise<GatekeeperDoc | null> {
  const snap = await db().collection('gatekeepers').doc(userId).get();
  return snap.exists ? (snap.data() as GatekeeperDoc) : null;
}

export async function attractionIdsForUser(user: UserDoc): Promise<string[]> {
  if (user.role === 'gatekeeper') {
    const gk = await getGatekeeper(user.id);
    return gk?.attractionIds ?? [];
  }
  if (user.role === 'guide') {
    const g = await getGuide(user.id);
    return g?.attractionIds ?? [];
  }
  return [];
}

export async function toMeResponse(user: UserDoc) {
  const settings = await getSettings();
  const tiers = await getStreakTiers();
  const titles = await getFollowerTitles();
  const { currentBadge, currentTitle } = enrichUserPublic(
    user,
    settings.totalRegions,
    tiers,
    titles,
  );
  const attractionIds = await attractionIdsForUser(user);
  return {
    user: {
      id: user.id,
      email: user.email,
      phone: user.phone,
      displayName: user.displayName,
      username: user.username,
      photoUrl: user.photoUrl,
      bio: user.bio,
      region: user.region,
      role: user.role,
      status: user.status,
      isDiaspora: user.isDiaspora,
      followerCount: user.followerCount,
      followingCount: user.followingCount,
      heritageScore: user.heritageScore,
      streakMonths: user.streakMonths,
      sitesVisitedCount: user.sitesVisitedCount,
      regionsVisited: user.regionsVisited,
      hasCompletedFirstPurchase: user.hasCompletedFirstPurchase,
      currentBadge,
      currentTitle,
      gatekeeperAttractionIds: user.role === 'gatekeeper' ? attractionIds : [],
      guideProfileId: user.role === 'guide' ? user.id : null,
    },
  };
}

export async function recomputeProgress(userId: string): Promise<UserDoc> {
  const user = await getUser(userId);
  const settings = await getSettings();
  const tiers = await getStreakTiers();
  const titles = await getFollowerTitles();

  const visitsSnap = await db()
    .collection('visits')
    .where('userId', '==', userId)
    .get();

  const visits = visitsSnap.docs.map((d) => d.data() as VisitDoc);
  const siteIds = [...new Set(visits.map((v) => v.attractionId))];
  const regions = [...new Set(visits.map((v) => v.region).filter(Boolean))];

  // Streak: consecutive calendar months ending at latest visit month
  const months = [...new Set(visits.map((v) => monthKey(v.scannedAt)))].sort();
  let streakMonths = 0;
  if (months.length) {
    const latest = months[months.length - 1] as string;
    const [y, m] = latest.split('-').map(Number);
    let cy = y;
    let cm = m;
    const set = new Set(months);
    while (set.has(`${cy}-${String(cm).padStart(2, '0')}`)) {
      streakMonths += 1;
      cm -= 1;
      if (cm === 0) {
        cm = 12;
        cy -= 1;
      }
    }
  }

  const badge = tierForMonths(streakMonths, regions, settings.totalRegions, tiers);
  const title = titleForFollowers(user.followerCount, titles);
  const score = heritageScore({
    uniqueSitesVisited: siteIds.length,
    regionsVisited: regions.length,
    streakMonths,
    totalRegions: settings.totalRegions,
  });

  const patch: Partial<UserDoc> = {
    streakMonths,
    regionsVisited: regions,
    sitesVisitedCount: siteIds.length,
    heritageScore: score,
    currentBadgeId: badge?.id ?? null,
    currentTitleId: title.id,
    updatedAt: nowIso(),
  };
  await db().collection('users').doc(userId).set(patch, { merge: true });
  return { ...user, ...patch };
}

export async function followUser(followerId: string, followeeId: string): Promise<void> {
  if (followerId === followeeId) return;
  const pairId = `${followerId}_${followeeId}`;
  const ref = db().collection('follows').doc(pairId);
  const existing = await ref.get();
  if (existing.exists) return;
  await db().runTransaction(async (tx) => {
    tx.set(ref, { followerId, followeeId, createdAt: nowIso() });
    tx.set(
      db().collection('users').doc(followerId),
      { followingCount: FieldValue.increment(1), updatedAt: nowIso() },
      { merge: true },
    );
    tx.set(
      db().collection('users').doc(followeeId),
      { followerCount: FieldValue.increment(1), updatedAt: nowIso() },
      { merge: true },
    );
  });
  await recomputeProgress(followeeId);
}

export async function unfollowUser(followerId: string, followeeId: string): Promise<void> {
  const pairId = `${followerId}_${followeeId}`;
  const ref = db().collection('follows').doc(pairId);
  const existing = await ref.get();
  if (!existing.exists) return;
  await db().runTransaction(async (tx) => {
    tx.delete(ref);
    tx.set(
      db().collection('users').doc(followerId),
      { followingCount: FieldValue.increment(-1), updatedAt: nowIso() },
      { merge: true },
    );
    tx.set(
      db().collection('users').doc(followeeId),
      { followerCount: FieldValue.increment(-1), updatedAt: nowIso() },
      { merge: true },
    );
  });
  await recomputeProgress(followeeId);
}

export async function isFollowing(followerId: string, followeeId: string): Promise<boolean> {
  const snap = await db().collection('follows').doc(`${followerId}_${followeeId}`).get();
  return snap.exists;
}

export async function setUserRole(
  userId: string,
  role: AppRole,
): Promise<void> {
  await db().collection('users').doc(userId).set({ role, updatedAt: nowIso() }, { merge: true });
}

/** Provision a Firebase user (or reuse) for staff invites. */
export async function ensureFirebaseUser(email: string, displayName: string, password: string) {
  try {
    const existing = await auth().getUserByEmail(email);
    return existing;
  } catch {
    return auth().createUser({ email, displayName, password, emailVerified: true });
  }
}
