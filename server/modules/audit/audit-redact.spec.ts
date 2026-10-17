import { redactValueForTest } from './audit-redact';

describe('audit redact', () => {
  it('masks password and secrets', () => {
    const out = redactValueForTest({
      username: 'admin',
      password: 'secret',
      nested: { api_key: 'k', app_secret: 's', keep: 1 },
    }) as Record<string, unknown>;
    expect(out.password).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>).api_key).toBe('[REDACTED]');
    expect((out.nested as Record<string, unknown>).app_secret).toBe(
      '[REDACTED]',
    );
    expect((out.nested as Record<string, unknown>).keep).toBe(1);
    expect(out.username).toBe('admin');
  });

  it('masks auth credential variants (newPassword/mfaToken/oldPassword/smsCode/captcha)', () => {
    const out = redactValueForTest({
      newPassword: 'p1',
      oldPassword: 'p2',
      confirmPassword: 'p3',
      currentPassword: 'p4',
      mfaToken: 't1',
      mfaCode: 'c1',
      smsCode: 's1',
      captcha: 'x1',
      verifyCode: 'v1',
    }) as Record<string, unknown>;
    for (const key of [
      'newPassword',
      'oldPassword',
      'confirmPassword',
      'currentPassword',
      'mfaToken',
      'mfaCode',
      'smsCode',
      'captcha',
      'verifyCode',
    ]) {
      expect(out[key]).toBe('[REDACTED]');
    }
  });

  it('masks newPassword nested inside objects', () => {
    const out = redactValueForTest({
      user: { profile: { newPassword: 'nested-secret', nickname: 'n' } },
    }) as Record<string, unknown>;
    const user = out.user as Record<string, unknown>;
    const profile = user.profile as Record<string, unknown>;
    expect(profile.newPassword).toBe('[REDACTED]');
    expect(profile.nickname).toBe('n');
  });

  it('does not over-mask harmless fields containing sensitive words', () => {
    const out = redactValueForTest({
      tokenCount: 3,
      secretName: 'ldap',
      passwordHint: '至少8位',
      keep: 'ok',
    }) as Record<string, unknown>;
    expect(out.tokenCount).toBe(3);
    expect(out.secretName).toBe('ldap');
    expect(out.passwordHint).toBe('至少8位');
    expect(out.keep).toBe('ok');
  });
});
