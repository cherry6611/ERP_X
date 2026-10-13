import { readCookie, readSession, signSession } from './jwt';

describe('jwt', () => {
  it('round-trips a session', () => {
    const token = signSession({ userId: 'u1', userName: '甲', roles: ['admin'] }, 'secret', 60);
    const claims = readSession(token, 'secret');
    expect(claims?.userId).toBe('u1');
    expect(claims?.roles).toEqual(['admin']);
    expect(claims?.jti).toEqual(expect.any(String));
  });

  it('rejects a tampered token', () => {
    const token = signSession({ userId: 'u1', userName: '甲', roles: [] }, 'secret', 60);
    expect(readSession(`${token}x`, 'secret')).toBeNull();
  });

  it('rejects an expired token', () => {
    const token = signSession({ userId: 'u1', userName: '甲', roles: [] }, 'secret', -10);
    expect(readSession(token, 'secret')).toBeNull();
  });
});

describe('cookie', () => {
  it('reads the named cookie', () => {
    expect(readCookie('a=1; erp_session=abc%20d', 'erp_session')).toBe('abc d');
  });

  it('returns null when missing', () => {
    expect(readCookie(undefined, 'erp_session')).toBeNull();
  });
});
