import { createHash } from 'node:crypto';

export function sha1(text: string | Uint8Array): string {
  return createHash('sha1').update(text).digest('hex');
}
