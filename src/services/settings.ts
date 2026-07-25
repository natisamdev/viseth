import { db } from '../config/firebase';
import type { FeatureFlags, PlatformSettings } from '../types';
import {
  DEFAULT_FOLLOWER_TITLES,
  DEFAULT_STREAK_TIERS,
} from './gamification';

const SETTINGS_ID = 'default';

export const DEFAULT_SETTINGS: PlatformSettings = {
  commissionRate: 12,
  payoutDay: 1,
  supportEmail: 'support@viseth.et',
  maintenanceMode: false,
  giftKeycodeExpiryHours: 72,
  ticketExpiryHours: 168,
  platformFeePercent: 2,
  totalRegions: 12,
};

export const DEFAULT_FLAGS: FeatureFlags = {
  diaspora_gifting: true,
  ai_recaps: true,
  guide_booking: true,
  streak_badges: true,
  discovery_feed: true,
  live_streaming: false,
  hotels: true,
};

export async function getSettings(): Promise<PlatformSettings> {
  const snap = await db().collection('platform_settings').doc(SETTINGS_ID).get();
  if (!snap.exists) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...(snap.data() as Partial<PlatformSettings>) };
}

export async function putSettings(
  patch: Partial<PlatformSettings>,
): Promise<PlatformSettings> {
  const next = { ...(await getSettings()), ...patch };
  await db().collection('platform_settings').doc(SETTINGS_ID).set(next, { merge: true });
  return next;
}

export async function getFeatureFlags(): Promise<FeatureFlags> {
  const snap = await db().collection('feature_flags').doc(SETTINGS_ID).get();
  if (!snap.exists) return { ...DEFAULT_FLAGS };
  return { ...DEFAULT_FLAGS, ...(snap.data() as Partial<FeatureFlags>) };
}

export async function setFeatureFlag(
  key: keyof FeatureFlags,
  enabled: boolean,
): Promise<FeatureFlags> {
  const flags = await getFeatureFlags();
  flags[key] = enabled;
  await db().collection('feature_flags').doc(SETTINGS_ID).set(flags, { merge: true });
  return flags;
}

export async function getStreakTiers() {
  const snap = await db().collection('gamification').doc('streak_tiers').get();
  if (!snap.exists) return DEFAULT_STREAK_TIERS;
  return (snap.data()?.tiers as typeof DEFAULT_STREAK_TIERS) ?? DEFAULT_STREAK_TIERS;
}

export async function getFollowerTitles() {
  const snap = await db().collection('gamification').doc('follower_titles').get();
  if (!snap.exists) return DEFAULT_FOLLOWER_TITLES;
  return (
    (snap.data()?.titles as typeof DEFAULT_FOLLOWER_TITLES) ?? DEFAULT_FOLLOWER_TITLES
  );
}

export async function assertNotMaintenance(): Promise<void> {
  const s = await getSettings();
  if (s.maintenanceMode) {
    const { maintenance } = await import('../utils/errors');
    throw maintenance();
  }
}
