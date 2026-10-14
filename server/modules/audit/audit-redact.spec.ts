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
});
