import axios, { type AxiosError } from 'axios';
import { env } from '../config/env';

export type AiEventType =
  | 'like'
  | 'share'
  | 'comment'
  | 'favorite'
  | 'watch'
  | 'skip';

export type AiVideoUpsertInput = {
  id: string;
  creatorId: string;
  title: string;
  description: string;
  tags: string[];
  thumbnailUrl?: string;
  mediaUrl?: string;
  durationSeconds?: number;
  likeCount?: number;
  shareCount?: number;
  commentCount?: number;
  creatorDisplayName?: string;
  contentSignals?: Record<string, unknown>;
  /** When false, only sync metadata/counters (feed hydrate). Default true. */
  runModeration?: boolean;
};

export type AiModerationResult = {
  id: string;
  creator_id: string;
  status: 'pending' | 'approved' | 'auto_banned' | 'admin_banned' | 'rejected';
  ban_reason: string;
  ban_explanation: string;
  nsfw_score: number;
  cultural_score: number;
  cultural_label: string;
  feed_eligible: boolean;
};

export type AiFeedItem = {
  id: string;
  feed_score: number;
  status: string;
  cultural_score: number;
  cultural_label: string;
  tags: string[];
};

export type AiReportResult = {
  id: string;
  video_id: string;
  status: string;
  ai_decision: string;
  ai_confidence: number;
  ai_explanation: string;
  video_status?: string | null;
  ban_reason?: string | null;
};

function enabled(): boolean {
  return Boolean(env.culturalAiBaseUrl && env.culturalAiServiceKey);
}

function client() {
  return axios.create({
    baseURL: env.culturalAiBaseUrl.replace(/\/$/, ''),
    timeout: 8_000,
    headers: {
      'Content-Type': 'application/json',
      'X-Service-Key': env.culturalAiServiceKey,
    },
  });
}

function logAiError(action: string, err: unknown) {
  const ax = err as AxiosError;
  const detail =
    (ax.response?.data as { detail?: string } | undefined)?.detail ?? ax.message;
  console.warn(`[culturalFeedAi] ${action} failed:`, detail);
}

/** Map AI video status → Viseth RecapStatus + removal reason. */
export function mapAiStatusToRecap(status: AiModerationResult['status']): {
  status: 'published' | 'flagged' | 'removed';
  removalReason: string | null;
} {
  switch (status) {
    case 'approved':
      return { status: 'published', removalReason: null };
    case 'pending':
      return { status: 'flagged', removalReason: 'ai_pending_review' };
    case 'auto_banned':
    case 'admin_banned':
    case 'rejected':
      return { status: 'removed', removalReason: `ai_${status}` };
    default:
      return { status: 'published', removalReason: null };
  }
}

export async function upsertVideoForModeration(
  input: AiVideoUpsertInput,
): Promise<AiModerationResult | null> {
  if (!enabled()) return null;
  try {
    const res = await client().post<AiModerationResult>('/v1/internal/videos/upsert', {
      id: input.id,
      creator_id: input.creatorId,
      title: input.title,
      description: input.description,
      tags: input.tags,
      thumbnail_url: input.thumbnailUrl ?? '',
      media_url: input.mediaUrl ?? '',
      duration_seconds: input.durationSeconds ?? 15,
      like_count: input.likeCount ?? 0,
      share_count: input.shareCount ?? 0,
      comment_count: input.commentCount ?? 0,
      creator_display_name: input.creatorDisplayName ?? '',
      content_signals: input.contentSignals ?? { is_cultural: true },
      run_moderation: input.runModeration !== false,
    });
    return res.data;
  } catch (err) {
    logAiError('upsertVideo', err);
    return null;
  }
}

export async function getRankedFeedIds(
  userId: string,
  limit = 20,
): Promise<AiFeedItem[]> {
  if (!enabled()) return [];
  try {
    const res = await client().get<AiFeedItem[]>(`/v1/internal/feed/${userId}`, {
      params: { limit },
    });
    return res.data ?? [];
  } catch (err) {
    logAiError('getRankedFeed', err);
    return [];
  }
}

export async function recordAiEvent(input: {
  userId: string;
  videoId: string;
  type: AiEventType;
  watchRatio?: number;
}): Promise<boolean> {
  if (!enabled()) return false;
  try {
    await client().post('/v1/internal/events', {
      user_id: input.userId,
      video_id: input.videoId,
      type: input.type,
      watch_ratio: input.watchRatio ?? 0,
    });
    return true;
  } catch (err) {
    logAiError('recordEvent', err);
    return false;
  }
}

export async function reviewReportWithAi(input: {
  reporterId: string;
  videoId: string;
  reason: string;
  details?: string;
}): Promise<AiReportResult | null> {
  if (!enabled()) return null;
  try {
    const res = await client().post<AiReportResult>('/v1/internal/reports', {
      reporter_id: input.reporterId,
      video_id: input.videoId,
      reason: input.reason,
      details: input.details ?? '',
    });
    return res.data;
  } catch (err) {
    logAiError('reviewReport', err);
    return null;
  }
}

/** Best-effort tags from attraction + caption for cultural ranking. */
export function buildCulturalTags(opts: {
  attractionName?: string;
  region?: string;
  category?: string;
  body?: string;
}): string[] {
  const tags = new Set<string>(['ethiopia', 'heritage']);
  if (opts.region) tags.add(opts.region.toLowerCase().replace(/\s+/g, '_'));
  if (opts.category) tags.add(opts.category.toLowerCase().replace(/\s+/g, '_'));
  const name = (opts.attractionName ?? '').toLowerCase();
  for (const key of [
    'lalibela',
    'axum',
    'adwa',
    'gondar',
    'omo',
    'harar',
    'coffee',
    'museum',
  ]) {
    if (name.includes(key) || (opts.body ?? '').toLowerCase().includes(key)) {
      tags.add(key === 'coffee' ? 'coffee_ceremony' : key);
    }
  }
  return [...tags];
}
