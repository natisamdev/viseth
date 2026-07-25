import type { FollowerTitle, StreakTier, UserDoc } from '../types';

export const DEFAULT_STREAK_TIERS: StreakTier[] = [
  { id: 'tier_dula', badgeName: 'Dula', item: 'Wooden fighting stick', minMonths: 1, maxMonths: 2 },
  { id: 'tier_jile', badgeName: 'Jile', item: 'Curved dagger', minMonths: 3, maxMonths: 4 },
  { id: 'tier_tor', badgeName: 'Tor', item: 'Spear', minMonths: 5, maxMonths: 7 },
  { id: 'tier_gasha', badgeName: 'Gasha', item: 'Shield', minMonths: 8, maxMonths: 10 },
  { id: 'tier_shotel', badgeName: 'Shotel', item: 'Sickle sword', minMonths: 11, maxMonths: 15 },
  {
    id: 'tier_yezellan',
    badgeName: 'Ye Zellan Silt',
    item: 'Full warrior kit',
    minMonths: 16,
    maxMonths: null,
    requiresAllRegions: true,
  },
];

export const DEFAULT_FOLLOWER_TITLES: FollowerTitle[] = [
  { id: 'ttl_traveler', title: 'Traveler', amharic: 'ተጓዥ', minFollowers: 0, maxFollowers: 50 },
  { id: 'ttl_young_noble', title: 'Young Noble', amharic: 'ወጣት መኳንንት', minFollowers: 51, maxFollowers: 200 },
  { id: 'ttl_commander', title: 'Commander', amharic: 'አዛዥ', minFollowers: 201, maxFollowers: 500 },
  { id: 'ttl_vanguard', title: 'Vanguard Chief', amharic: 'የፊት ጦር አለቃ', minFollowers: 501, maxFollowers: 2000 },
  { id: 'ttl_governor', title: 'Governor', amharic: 'ገዥ', minFollowers: 2001, maxFollowers: 10000 },
  { id: 'ttl_ras', title: 'Ras', amharic: 'ራስ', minFollowers: 10001, maxFollowers: null },
];

export function tierForMonths(
  months: number,
  regionsVisited: string[],
  totalRegions: number,
  tiers: StreakTier[] = DEFAULT_STREAK_TIERS,
): StreakTier | null {
  if (months <= 0) return null;
  const sorted = [...tiers].sort((a, b) => b.minMonths - a.minMonths);
  for (const t of sorted) {
    if (months < t.minMonths) continue;
    if (t.maxMonths != null && months > t.maxMonths) continue;
    if (t.requiresAllRegions && regionsVisited.length < totalRegions) {
      // Fall through to Shotel-like lower tier
      continue;
    }
    return t;
  }
  // If Ye Zellan blocked, pick highest non-all-regions tier that fits
  return (
    sorted.find(
      (t) =>
        !t.requiresAllRegions &&
        months >= t.minMonths &&
        (t.maxMonths == null || months <= t.maxMonths),
    ) ?? null
  );
}

export function titleForFollowers(
  followers: number,
  titles: FollowerTitle[] = DEFAULT_FOLLOWER_TITLES,
): FollowerTitle {
  const sorted = [...titles].sort((a, b) => b.minFollowers - a.minFollowers);
  return (
    sorted.find(
      (t) =>
        followers >= t.minFollowers &&
        (t.maxFollowers == null || followers <= t.maxFollowers),
    ) ?? titles[0]
  );
}

export function heritageScore(input: {
  uniqueSitesVisited: number;
  regionsVisited: number;
  streakMonths: number;
  totalRegions: number;
}): number {
  const sitesPart = Math.min(input.uniqueSitesVisited / 20, 1) * 55;
  const regionsPart =
    Math.min(input.regionsVisited / Math.max(input.totalRegions, 1), 1) * 30;
  const streakPart = Math.min(input.streakMonths / 16, 1) * 15;
  return Math.round(sitesPart + regionsPart + streakPart);
}

export function publicBadge(tier: StreakTier | null) {
  if (!tier) return null;
  return {
    id: tier.id,
    badgeName: tier.badgeName,
    item: tier.item,
    minMonths: tier.minMonths,
    maxMonths: tier.maxMonths,
  };
}

export function publicTitle(title: FollowerTitle) {
  return {
    id: title.id,
    title: title.title,
    amharic: title.amharic,
    minFollowers: title.minFollowers,
    maxFollowers: title.maxFollowers,
  };
}

export function enrichUserPublic(
  user: UserDoc,
  totalRegions: number,
  tiers = DEFAULT_STREAK_TIERS,
  titles = DEFAULT_FOLLOWER_TITLES,
) {
  const badge = tierForMonths(
    user.streakMonths,
    user.regionsVisited,
    totalRegions,
    tiers,
  );
  const title = titleForFollowers(user.followerCount, titles);
  return {
    currentBadge: publicBadge(badge),
    currentTitle: publicTitle(title),
  };
}
