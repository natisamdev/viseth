import type { Request } from 'express';

/** Express 5 types params as string | string[] — normalize to string. */
export function p(req: Request, key: string): string {
  const v = req.params[key];
  return Array.isArray(v) ? String(v[0]) : String(v);
}
