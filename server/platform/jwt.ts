import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export interface SessionClaims {
  userId: string;
  userName: string;
  roles: string[];
  exp: number;
  jti: string;
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export function signSession(claims: Omit<SessionClaims, 'exp' | 'jti'> & { jti?: string }, secret: string, ttlSec: number): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({
    ...claims,
    jti: claims.jti ?? randomBytes(16).toString('hex'),
    exp: Math.floor(Date.now() / 1000) + ttlSec,
  }));
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export function readSession(token: string, secret: string): SessionClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionClaims;
    if (!claims.userId || !claims.jti || !claims.exp || claims.exp < Math.floor(Date.now() / 1000)) return null;
    return claims;
  } catch {
    return null;
  }
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export const SESSION_COOKIE = 'erp_session';
