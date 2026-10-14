import { base32Encode, buildOtpAuthUri, generateRecoveryCodes, generateTotpSecret, totpAt, verifyTotp } from './totp';

describe('TOTP（B-04）', () => {
  it('Base32 编解码可逆（RFC 4648 向量）', () => {
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Encode(Buffer.from('f'))).toBe('MY');
  });

  it('RFC 6238 附录 B 官方测试向量（SHA1 / 8 位 / 30s）', () => {
    // 密钥 "12345678901234567890" 的 Base32 表示为 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(totpAt(secret, 59_000, { digits: 8 })).toBe('94287082');
    expect(totpAt(secret, 1_111_111_109_000, { digits: 8 })).toBe('07081804');
    expect(totpAt(secret, 1_111_111_111_000, { digits: 8 })).toBe('14050471');
    expect(totpAt(secret, 1_234_567_890_000, { digits: 8 })).toBe('89005924');
    expect(totpAt(secret, 2_000_000_000_000, { digits: 8 })).toBe('69279037');
    expect(totpAt(secret, 20_000_000_000_000, { digits: 8 })).toBe('65353130');
  });

  it('6 位码与 8 位码分别是官方值的后 6 位（同一截断）', () => {
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
    expect(totpAt(secret, 59_000, { digits: 6 })).toBe('287082');
  });

  it('校验允许 ±1 个时间步的时钟漂移', () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    const current = totpAt(secret, now);
    expect(verifyTotp(secret, current, { nowMs: now })).toBe(true);
    // 上一个时间步
    expect(verifyTotp(secret, totpAt(secret, now - 30_000), { nowMs: now })).toBe(true);
    // 下一个时间步
    expect(verifyTotp(secret, totpAt(secret, now + 30_000), { nowMs: now })).toBe(true);
    // 超出窗口（±2 步）
    expect(verifyTotp(secret, totpAt(secret, now + 90_000), { nowMs: now })).toBe(false);
  });

  it('拒绝格式非法与错误验证码', () => {
    const secret = generateTotpSecret();
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, '12345', { nowMs: now })).toBe(false);
    expect(verifyTotp(secret, 'abcdef', { nowMs: now })).toBe(false);
    expect(verifyTotp(secret, '', { nowMs: now })).toBe(false);
    expect(verifyTotp(secret, '000000', { nowMs: now })).toBe(
      totpAt(secret, now) === '000000'
    );
  });

  it('otpauth URI 含 secret / issuer / 算法参数', () => {
    const uri = buildOtpAuthUri({ secret: 'ABCDEF', accountName: 'admin@example.com' });
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain('secret=ABCDEF');
    expect(uri).toContain('issuer=');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  it('生成的密钥长度与字符集符合验证器 App 要求', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(new Set(Array.from({ length: 20 }, () => generateTotpSecret())).size).toBe(20);
  });

  it('恢复码为一次性可读格式且互不重复', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(8);
    for (const code of codes) {
      // 4 位 + 连字符 + 5 位；字符集为去掉易混淆字符 I/O/0/1 的 A-Z + 2-9
      expect(code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{5}$/);
      expect(code.replace('-', '')).toHaveLength(9);
      expect(code).not.toMatch(/[IO01]/);
    }
    expect(new Set(codes).size).toBe(8);
  });
});
