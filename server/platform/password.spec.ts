import { hashPassword, verifyPassword } from './password';

describe('password', () => {
  it('accepts the original password', () => {
    const stored = hashPassword('secret-1');
    expect(verifyPassword('secret-1', stored)).toBe(true);
  });

  it('rejects a different password', () => {
    const stored = hashPassword('secret-1');
    expect(verifyPassword('other', stored)).toBe(false);
  });

  it('rejects a malformed hash', () => {
    expect(verifyPassword('secret-1', 'plain')).toBe(false);
  });
});
