import { db, FieldValue } from '../config/firebase';
import type { RecapDoc, VisitDoc } from '../types';
import { id } from '../utils/ids';
import { nowIso } from '../utils/time';
import { badRequest, forbidden, notFound } from '../utils/errors';
import { getAttraction } from './attractions';
import { getFeatureFlags, getFollowerTitles, getSettings, getStreakTiers } from './settings';
import { enrichUserPublic } from './gamification';
import { getUser, isFollowing } from './users';

export async function createRecap(input: {
  authorId: string;
  attractionId: string;
  visitId?: string;
  body: string;
  media?: RecapDoc['media'];
  aiAssisted?: boolean;
  hasVoiceStory?: boolean;
  audioUrl?: string;
}): Promise<RecapDoc> {
  if (!input.body.trim()) throw badRequest('EMPTY_BODY', 'body required');
  await getAttraction(input.attractionId);

  let isGiftedVisit = false;
  let visitedOn = nowIso().slice(0, 10);
  if (input.visitId) {
    const vSnap = await db().collection('visits').doc(input.visitId).get();
    if (!vSnap.exists) throw notFound('Visit not found');
    const visit = vSnap.data() as VisitDoc;
    if (visit.userId && visit.userId !== input.authorId) throw forbidden();
    if (visit.attractionId !== input.attractionId) {
      throw badRequest('VISIT_MISMATCH', 'visitId does not match attraction');
    }
    isGiftedVisit = visit.wasGift;
    visitedOn = visit.scannedAt.slice(0, 10);
  }

  const media = input.media ?? [];
  const recap: RecapDoc = {
    id: id('pst'),
    authorId: input.authorId,
    attractionId: input.attractionId,
    visitId: input.visitId ?? null,
    body: input.body.trim(),
    media,
    imageUrl: media.find((m) => m.kind === 'image')?.url ?? null,
    audioUrl: input.audioUrl ?? null,
    aiAssisted: Boolean(input.aiAssisted),
    hasVoiceStory: Boolean(input.hasVoiceStory),
    isGiftedVisit,
    status: 'published',
    likeCount: 0,
    commentCount: 0,
    shareCount: 0,
    reportCount: 0,
    reportReasons: [],
    removalReason: null,
    visitedOn,
    createdAt: nowIso(),
  };
  await db().collection('recap_posts').doc(recap.id).set(recap);
  return recap;
}

export async function getRecap(recapId: string): Promise<RecapDoc> {
  const snap = await db().collection('recap_posts').doc(recapId).get();
  if (!snap.exists) throw notFound('Recap not found');
  return snap.data() as RecapDoc;
}

export async function deleteRecap(recapId: string, authorId: string) {
  const recap = await getRecap(recapId);
  if (recap.authorId !== authorId) throw forbidden();
  if (recap.status === 'removed') return;
  await db()
    .collection('recap_posts')
    .doc(recapId)
    .set({ status: 'removed', removalReason: 'author_deleted' }, { merge: true });
}

async function serializeFeedItem(recap: RecapDoc, viewerId?: string) {
  const author = await getUser(recap.authorId);
  const settings = await getSettings();
  const tiers = await getStreakTiers();
  const titles = await getFollowerTitles();
  const { currentBadge, currentTitle } = enrichUserPublic(
    author,
    settings.totalRegions,
    tiers,
    titles,
  );
  const attraction = await getAttraction(recap.attractionId, { allowInactive: true });
  let likedByMe = false;
  if (viewerId) {
    const like = await db()
      .collection('post_likes')
      .doc(`${viewerId}_${recap.id}`)
      .get();
    likedByMe = like.exists;
  }
  return {
    id: recap.id,
    body: recap.body,
    media: recap.media,
    imageUrl: recap.imageUrl,
    audioUrl: recap.audioUrl,
    aiAssisted: recap.aiAssisted,
    hasVoiceStory: recap.hasVoiceStory,
    isGiftedVisit: recap.isGiftedVisit,
    likeCount: recap.likeCount,
    commentCount: recap.commentCount,
    shareCount: recap.shareCount,
    likedByMe,
    visitedOn: recap.visitedOn,
    createdAt: recap.createdAt,
    attraction: {
      id: attraction.id,
      name: attraction.name,
      region: attraction.region,
    },
    author: {
      id: author.id,
      displayName: author.displayName,
      username: author.username,
      photoUrl: author.photoUrl,
      currentBadge,
      currentTitle,
    },
  };
}

export async function getFeed(tab: 'for_you' | 'following', viewerId: string) {
  const flags = await getFeatureFlags();
  if (!flags.discovery_feed) {
    return [];
  }
  const snap = await db().collection('recap_posts').get();
  let posts = snap.docs
    .map((d) => d.data() as RecapDoc)
    .filter((p) => p.status === 'published');

  if (tab === 'following') {
    const follows = await db().collection('follows').where('followerId', '==', viewerId).get();
    const followeeIds = new Set(
      follows.docs.map((d) => (d.data() as { followeeId: string }).followeeId),
    );
    posts = posts.filter((p) => followeeIds.has(p.authorId));
  }

  posts.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const items: Awaited<ReturnType<typeof serializeFeedItem>>[] = [];
  for (const post of posts) {
    items.push(await serializeFeedItem(post, viewerId));
  }
  return items;
}

export async function likeRecap(userId: string, recapId: string) {
  const ref = db().collection('post_likes').doc(`${userId}_${recapId}`);
  if ((await ref.get()).exists) return;
  await getRecap(recapId);
  await db().runTransaction(async (tx) => {
    tx.set(ref, { userId, postId: recapId, createdAt: nowIso() });
    tx.set(
      db().collection('recap_posts').doc(recapId),
      { likeCount: FieldValue.increment(1) },
      { merge: true },
    );
  });
}

export async function unlikeRecap(userId: string, recapId: string) {
  const ref = db().collection('post_likes').doc(`${userId}_${recapId}`);
  if (!(await ref.get()).exists) return;
  await db().runTransaction(async (tx) => {
    tx.delete(ref);
    tx.set(
      db().collection('recap_posts').doc(recapId),
      { likeCount: FieldValue.increment(-1) },
      { merge: true },
    );
  });
}

export async function shareRecap(recapId: string) {
  const recap = await getRecap(recapId);
  await db()
    .collection('recap_posts')
    .doc(recapId)
    .set({ shareCount: FieldValue.increment(1) }, { merge: true });
  return {
    shareCount: recap.shareCount + 1,
    shareUrl: `https://viseth.et/r/${recapId}`,
  };
}

export async function listComments(recapId: string) {
  await getRecap(recapId);
  const snap = await db().collection('comments').where('postId', '==', recapId).get();
  return snap.docs
    .map((d) => d.data() as {
      id: string;
      authorId: string;
      body: string;
      status: string;
      createdAt: string;
    })
    .filter((c) => c.status === 'visible')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function addComment(recapId: string, authorId: string, body: string) {
  if (!body.trim()) throw badRequest('EMPTY_BODY', 'body required');
  await getRecap(recapId);
  const comment = {
    id: id('cmt'),
    postId: recapId,
    authorId,
    body: body.trim(),
    status: 'visible',
    createdAt: nowIso(),
  };
  await db().collection('comments').doc(comment.id).set(comment);
  await db()
    .collection('recap_posts')
    .doc(recapId)
    .set({ commentCount: FieldValue.increment(1) }, { merge: true });
  return comment;
}

export async function createReport(input: {
  reporterUserId: string;
  category: string;
  contentType: string;
  targetId: string;
  postId?: string;
  notes?: string;
}) {
  let reportedUserId: string | null = null;
  let contentPreview = '';
  if (input.contentType === 'recap') {
    const recap = await getRecap(input.targetId);
    reportedUserId = recap.authorId;
    contentPreview = recap.body.slice(0, 160);
    const reportCount = recap.reportCount + 1;
    const patch: Partial<RecapDoc> = {
      reportCount,
      reportReasons: [...recap.reportReasons, input.category],
    };
    if (reportCount >= 3 && recap.status === 'published') patch.status = 'flagged';
    await db().collection('recap_posts').doc(recap.id).set(patch, { merge: true });
  }

  const report = {
    id: id('rpt'),
    category: input.category,
    contentType: input.contentType,
    status: 'open',
    reporterUserId: input.reporterUserId,
    reportedUserId,
    targetId: input.targetId,
    postId: input.postId ?? input.targetId,
    contentPreview,
    notes: input.notes ?? '',
    resolutionNote: null,
    resolvedByAdminId: null,
    createdAt: nowIso(),
    resolvedAt: null,
  };
  await db().collection('social_reports').doc(report.id).set(report);
  return { id: report.id, status: report.status };
}

// re-export for feed serializer convenience
export { isFollowing };
