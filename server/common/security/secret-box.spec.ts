import { decryptSecret, encryptSecret, isEncryptedSecret } from './secret-box';

describe('secret box', () => {
  const key = 'unit-test-secret-key-32b!!';

  it('round-trips a secret', () => {
    const stored = encryptSecret('app-secret-value', key);
    expect(isEncryptedSecret(stored)).toBe(true);
    expect(decryptSecret(stored, key)).toBe('app-secret-value');
  });

  it('rejects legacy plaintext', () => {
    expect(() => decryptSecret('plain-secret', key)).toThrow(/enc1/);
  });

  it('hashes a 32-byte key the same way as any other key', () => {
    const longKey = '12345678901234567890123456789012';
    const stored = encryptSecret('v', longKey);
    expect(decryptSecret(stored, longKey)).toBe('v');
  });

  it('refuses to decrypt without a key', () => {
    const stored = encryptSecret('app-secret-value', key);
    expect(() => decryptSecret(stored, undefined)).toThrow(/SECRET_ENC_KEY/);
  });
});
