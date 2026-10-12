import { decryptSecret, encryptSecret, isEncryptedSecret } from './secret-box';

describe('secret box', () => {
  const key = 'unit-test-secret-key-32b!!';

  it('round-trips a secret', () => {
    const stored = encryptSecret('app-secret-value', key);
    expect(isEncryptedSecret(stored)).toBe(true);
    expect(decryptSecret(stored, key)).toBe('app-secret-value');
  });

  it('leaves legacy plaintext untouched', () => {
    expect(decryptSecret('plain-secret', undefined)).toBe('plain-secret');
  });

  it('refuses to decrypt without a key', () => {
    const stored = encryptSecret('app-secret-value', key);
    expect(() => decryptSecret(stored, undefined)).toThrow(/SECRET_ENC_KEY/);
  });
});
