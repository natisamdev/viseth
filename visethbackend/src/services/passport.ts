import { db } from '../config/firebase';
import type { TicketDoc, VisitDoc } from '../types';
import { getAttraction } from './attractions';
import {
  enrichUserPublic,
} from './gamification';
import { getFollowerTitles, getSettings, getStreakTiers } from './settings';
import { getUser } from './users';

export async function getPassport(userId: string) {
  const user = await getUser(userId);
  const settings = await getSettings();
  const tiers = await getStreakTiers();
  const titles = await getFollowerTitles();
  const { currentBadge, currentTitle } = enrichUserPublic(
    user,
    settings.totalRegions,
    tiers,
    titles,
  );

  const visitsSnap = await db().collection('visits').where('userId', '==', userId).get();
  const visitsRaw = visitsSnap.docs
    .map((d) => d.data() as VisitDoc)
    .sort((a, b) => b.scannedAt.localeCompare(a.scannedAt));

  const visits: Array<{
    id: string;
    attractionId: string;
    attractionName: string;
    region: string;
    scannedAt: string;
    wasGift: boolean;
  }> = [];
  for (const v of visitsRaw) {
    const attraction = await getAttraction(v.attractionId, { allowInactive: true });
    visits.push({
      id: v.id,
      attractionId: v.attractionId,
      attractionName: attraction.name,
      region: v.region,
      scannedAt: v.scannedAt,
      wasGift: v.wasGift,
    });
  }

  const ticketsSnap = await db()
    .collection('tickets')
    .where('holderUserId', '==', userId)
    .get();
  const upcomingTickets = ticketsSnap.docs
    .map((d) => d.data() as TicketDoc)
    .filter((t) => t.status === 'valid')
    .map((t) => ({
      id: t.id,
      attractionId: t.attractionId,
      visitDate: t.visitDate,
      status: t.status,
    }));

  return {
    heritageScore: user.heritageScore,
    sitesVisited: user.sitesVisitedCount,
    regionsCovered: user.regionsVisited,
    streakMonths: user.streakMonths,
    badge: currentBadge
      ? {
          badgeName: currentBadge.badgeName,
          item: currentBadge.item,
          minMonths: currentBadge.minMonths,
          maxMonths: currentBadge.maxMonths,
        }
      : null,
    title: currentTitle
      ? { title: currentTitle.title, amharic: currentTitle.amharic }
      : null,
    visits,
    upcomingTickets,
    isFirstPurchaseCelebrationEligible: !user.hasCompletedFirstPurchase,
  };
}
