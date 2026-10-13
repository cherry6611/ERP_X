import { timingSafeEqual } from 'node:crypto';

export function oauthStateMatches(expected: string | null, actual: string | undefined): boolean {
  if (!expected || !actual || expected.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}
