import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Request } from 'express';

export const sessionEvents = new EventEmitter<{ revoke: [keys: string[]] }>();

export function sessionHash(req: Request): string {
  const value = req.headers.cookie?.match(/(?:^|;\s*)wj_session=([0-9a-f]{64})(?:;|$)/)?.[1] ?? '';
  return createHash('sha256').update(value).digest('hex');
}
