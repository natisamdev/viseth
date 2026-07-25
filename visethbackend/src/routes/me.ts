import { Router } from 'express';
import { z } from 'zod';
import { p } from '../utils/params';
import { asyncHandler } from '../middleware/asyncHandler';
import { asAppUser, requireAppAuth, requireRoles } from '../middleware/auth';
import {
  followUser,
  getUser,
  isFollowing,
  patchUser,
  toMeResponse,
  unfollowUser,
} from '../services/users';
import {
  enrichUserPublic,
} from '../services/gamification';
import { getFollowerTitles, getSettings, getStreakTiers } from '../services/settings';
import { listSavedAttractions } from '../services/attractions';
import { parsePage, paginate } from '../utils/pagination';

const router = Router();

router.get(
  '/me',
  requireAppAuth,
  requireRoles('traveler', 'guide', 'gatekeeper'),
  asyncHandler(async (req, res) => {
    const user = asAppUser(req);
    const doc = await getUser(user.userId);
    res.json(await toMeResponse(doc));
  }),
);

router.patch(
  '/me',
  requireAppAuth,
  requireRoles('traveler', 'guide', 'gatekeeper'),
  asyncHandler(async (req, res) => {
    const user = asAppUser(req);
    const body = z
      .object({
        displayName: z.string().min(1).max(80).optional(),
        photoUrl: z.string().url().nullable().optional(),
        phone: z.string().min(6).max(20).nullable().optional(),
        bio: z.string().max(500).optional(),
        region: z.string().max(80).nullable().optional(),
        username: z.string().min(2).max(40).nullable().optional(),
        isDiaspora: z.boolean().optional(),
      })
      .parse(req.body);
    const updated = await patchUser(user.userId, body);
    res.json(await toMeResponse(updated));
  }),
);

router.post(
  '/me/celebrations/first-purchase',
  requireAppAuth,
  requireRoles('traveler'),
  asyncHandler(async (req, res) => {
    const user = asAppUser(req);
    await patchUser(user.userId, { hasCompletedFirstPurchase: true });
    res.status(204).send();
  }),
);

router.get(
  '/me/saved-attractions',
  requireAppAuth,
  requireRoles('traveler'),
  asyncHandler(async (req, res) => {
    const user = asAppUser(req);
    const { page, pageSize } = parsePage(req.query as Record<string, unknown>);
    const items = await listSavedAttractions(user.userId);
    res.json(paginate(items, page, pageSize));
  }),
);

router.get(
  '/users/:id',
  requireAppAuth,
  asyncHandler(async (req, res) => {
    const viewer = asAppUser(req);
    const user = await getUser(p(req, 'id'));
    const settings = await getSettings();
    const tiers = await getStreakTiers();
    const titles = await getFollowerTitles();
    const { currentBadge, currentTitle } = enrichUserPublic(
      user,
      settings.totalRegions,
      tiers,
      titles,
    );
    res.json({
      id: user.id,
      displayName: user.displayName,
      username: user.username,
      photoUrl: user.photoUrl,
      bio: user.bio,
      region: user.region,
      followerCount: user.followerCount,
      followingCount: user.followingCount,
      heritageScore: user.heritageScore,
      streakMonths: user.streakMonths,
      sitesVisitedCount: user.sitesVisitedCount,
      currentBadge,
      currentTitle,
      isFollowing: await isFollowing(viewer.userId, user.id),
    });
  }),
);

router.post(
  '/users/:id/follow',
  requireAppAuth,
  requireRoles('traveler', 'guide'),
  asyncHandler(async (req, res) => {
    await followUser(asAppUser(req).userId, p(req, 'id'));
    res.status(204).send();
  }),
);

router.delete(
  '/users/:id/follow',
  requireAppAuth,
  requireRoles('traveler', 'guide'),
  asyncHandler(async (req, res) => {
    await unfollowUser(asAppUser(req).userId, p(req, 'id'));
    res.status(204).send();
  }),
);

export default router;
