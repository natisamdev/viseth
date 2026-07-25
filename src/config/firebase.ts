import fs from 'fs';
import { initializeApp, cert, getApps, type App, type ServiceAccount } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';
import { env } from './env';

let app: App;

function loadServiceAccount(): ServiceAccount {
  // Prefer inline JSON for Render / Railway (no file on disk)
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (inline) {
    return JSON.parse(inline) as ServiceAccount;
  }

  if (!fs.existsSync(env.firebaseServiceAccountPath)) {
    throw new Error(
      `Firebase credentials missing. Set FIREBASE_SERVICE_ACCOUNT_JSON or place the key at ${env.firebaseServiceAccountPath}`,
    );
  }

  return JSON.parse(
    fs.readFileSync(env.firebaseServiceAccountPath, 'utf8'),
  ) as ServiceAccount;
}

export function initFirebase(): App {
  if (getApps().length) {
    app = getApps()[0]!;
    return app;
  }

  const serviceAccount = loadServiceAccount();
  const projectId =
    (serviceAccount as { projectId?: string; project_id?: string }).projectId ??
    (serviceAccount as { project_id?: string }).project_id;

  app = initializeApp({
    credential: cert(serviceAccount),
    projectId,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET || `${projectId}.appspot.com`,
  });

  return app;
}

export function db() {
  return getFirestore();
}

export function auth() {
  return getAuth();
}

export function storage() {
  return getStorage();
}

export { FieldValue, Timestamp };
