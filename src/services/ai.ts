import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { env } from '../config/env';
import { getFeatureFlags } from './settings';
import { forbidden, upstream } from '../utils/errors';
import { id } from '../utils/ids';
import { db } from '../config/firebase';
import { nowIso } from '../utils/time';

const uploadsDir = path.join(process.cwd(), 'uploads');

function ensureUploads() {
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
}

export async function transcribeAudio(filePath: string): Promise<{ text: string }> {
  const flags = await getFeatureFlags();
  if (!flags.ai_recaps) throw forbidden('AI recaps disabled', 'FEATURE_DISABLED');

  if (!env.whisperflowApiKey) {
    void filePath;
    return {
      text: 'Stub transcription: The rock-hewn churches of Lalibela feel eternal at sunrise.',
    };
  }

  try {
    const res = await axios.post(
      'https://api.whisperflow.ai/v1/transcribe',
      { audio_base64: fs.readFileSync(filePath).toString('base64') },
      {
        headers: {
          Authorization: `Bearer ${env.whisperflowApiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      },
    );
    return { text: String(res.data?.text ?? '') };
  } catch {
    throw upstream('Whisperflow failed', 'UPSTREAM_ERROR');
  }
}

export async function textToSpeech(text: string, recapId?: string): Promise<{
  audioUrl: string;
  durationSeconds: number;
}> {
  const flags = await getFeatureFlags();
  if (!flags.ai_recaps) throw forbidden('AI recaps disabled', 'FEATURE_DISABLED');

  ensureUploads();
  const mediaId = id('med');
  const filename = `${mediaId}.mp3`;
  const localPath = path.join(uploadsDir, filename);

  if (!env.elevenLabsApiKey) {
    fs.writeFileSync(localPath, Buffer.from('STUB_AUDIO'));
    const audioUrl = `${env.baseUrl}/uploads/${filename}`;
    if (recapId) {
      await db().collection('recap_posts').doc(recapId).set({ audioUrl }, { merge: true });
    }
    await db().collection('media_assets').doc(mediaId).set({
      id: mediaId,
      url: audioUrl,
      kind: 'audio',
      createdAt: nowIso(),
    });
    return { audioUrl, durationSeconds: Math.max(3, Math.round(text.length / 14)) };
  }

  try {
    const voiceId = env.elevenLabsVoiceId || '21m00Tcm4TlvDq8ikWAM';
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      { text },
      {
        headers: {
          'xi-api-key': env.elevenLabsApiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        responseType: 'arraybuffer',
        timeout: 30_000,
      },
    );
    fs.writeFileSync(localPath, Buffer.from(res.data));
    const audioUrl = `${env.baseUrl}/uploads/${filename}`;
    if (recapId) {
      await db().collection('recap_posts').doc(recapId).set({ audioUrl }, { merge: true });
    }
    return { audioUrl, durationSeconds: Math.max(3, Math.round(text.length / 14)) };
  } catch {
    throw upstream('ElevenLabs failed', 'UPSTREAM_ERROR');
  }
}

export async function generateImage(prompt: string, purpose: string) {
  const flags = await getFeatureFlags();
  if (!flags.ai_recaps) throw forbidden('AI recaps disabled', 'FEATURE_DISABLED');

  if (!env.falApiKey) {
    return {
      imageUrl: `https://placehold.co/800x1000/D98A1C/211509?text=${encodeURIComponent(purpose)}`,
    };
  }

  try {
    const res = await axios.post(
      'https://fal.run/fal-ai/flux/dev',
      { prompt },
      {
        headers: { Authorization: `Key ${env.falApiKey}`, 'Content-Type': 'application/json' },
        timeout: 30_000,
      },
    );
    const imageUrl = res.data?.images?.[0]?.url ?? res.data?.image?.url;
    if (!imageUrl) throw upstream('Fal returned no image');
    return { imageUrl };
  } catch {
    throw upstream('Fal failed', 'UPSTREAM_ERROR');
  }
}

export async function enrichAttractionWithFirecrawl(attractionId: string): Promise<string[]> {
  await db()
    .collection('attractions')
    .doc(attractionId)
    .set({ enrichmentStatus: 'pending' }, { merge: true });

  const snap = await db().collection('attractions').doc(attractionId).get();
  const name = (snap.data() as { name?: string })?.name ?? attractionId;

  if (!env.firecrawlApiKey) {
    const facts = [
      `${name} is a landmark of Ethiopian heritage.`,
      'Visitors should carry their Viseth QR ticket for gate entry.',
      'Best experienced with a licensed local guide.',
    ];
    await db()
      .collection('attractions')
      .doc(attractionId)
      .set({ enrichedFacts: facts, enrichmentStatus: 'ready' }, { merge: true });
    return facts;
  }

  try {
    const res = await axios.post(
      'https://api.firecrawl.dev/v1/scrape',
      {
        url: `https://www.google.com/search?q=${encodeURIComponent(name + ' Ethiopia heritage')}`,
        formats: ['extract'],
        extract: {
          prompt: 'Extract 3 short factual bullets about this Ethiopian heritage site.',
        },
      },
      {
        headers: {
          Authorization: `Bearer ${env.firecrawlApiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      },
    );
    const facts: string[] =
      res.data?.data?.extract?.facts ??
      res.data?.data?.extract ??
      [`Enriched facts for ${name}`];
    const normalized = Array.isArray(facts) ? facts.map(String).slice(0, 5) : [String(facts)];
    await db()
      .collection('attractions')
      .doc(attractionId)
      .set({ enrichedFacts: normalized, enrichmentStatus: 'ready' }, { merge: true });
    return normalized;
  } catch {
    await db()
      .collection('attractions')
      .doc(attractionId)
      .set({ enrichmentStatus: 'failed' }, { merge: true });
    throw upstream('Firecrawl failed', 'UPSTREAM_ERROR');
  }
}

export function saveUploadedFile(buffer: Buffer, originalName: string, kind: 'image' | 'video') {
  ensureUploads();
  const mediaId = id('med');
  const ext = path.extname(originalName) || (kind === 'image' ? '.jpg' : '.mp4');
  const filename = `${mediaId}${ext}`;
  fs.writeFileSync(path.join(uploadsDir, filename), buffer);
  const url = `${env.baseUrl}/uploads/${filename}`;
  return { id: mediaId, url, kind };
}
