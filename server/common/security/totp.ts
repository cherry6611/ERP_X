import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * B-04：TOTP（RFC 6238）与 Base32（RFC 4648）最小实现。
 *
 * 之所以不引入 `otplib` / `speakeasy`：这两者会新增 3~5 个传递依赖，
 * 而 TOTP 本身只有 30 行核心逻辑，且必须能单测断言中间值（RFC 6238 附录 B 向量）。
 * 若后续需要 HOTP 或 Steam 变体再考虑引入外部依赖。
 */

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 生成 20 字节（160 bit）随机密钥的 Base32 表示，符合 RFC 4226 推荐长度 */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const normalized = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of normalized) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`非法的 Base32 字符：${char}`);
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export interface TotpOptions {
  /** 时间步长（秒），RFC 6238 默认 30 */
  stepSeconds?: number;
  /** 输出位数，默认 6 */
  digits?: number;
  /** 使用 HMAC-SHA1（与主流验证器 App 兼容），默认 sha1 */
  algorithm?: 'sha1' | 'sha256' | 'sha512';
}

function hmacAlgorithm(algorithm: TotpOptions['algorithm']): string {
  switch (algorithm) {
    case 'sha256':
      return 'sha256';
    case 'sha512':
      return 'sha512';
    default:
      return 'sha1';
  }
}

/**
 * 计算指定时间戳（毫秒）对应的 TOTP。
 * 导出用于单测断言 RFC 6238 附录 B 的官方测试向量。
 */
export function totpAt(
  secretBase32: string,
  timestampMs: number,
  options: TotpOptions = {}
): string {
  const stepSeconds = options.stepSeconds ?? 30;
  const digits = options.digits ?? 6;
  const counter = Math.floor(timestampMs / 1000 / stepSeconds);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuffer.writeUInt32BE(counter >>> 0, 4);
  const key = base32Decode(secretBase32);
  const digest = createHmac(hmacAlgorithm(options.algorithm), key)
    .update(counterBuffer)
    .digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const otp = binary % 10 ** digits;
  return String(otp).padStart(digits, '0');
}

/** 计算当前 TOTP */
export function totpNow(secretBase32: string, options: TotpOptions = {}): string {
  return totpAt(secretBase32, Date.now(), options);
}

/**
 * 校验 TOTP 码，允许前后各 `window` 个时间步（默认 1，即 ±30s），
 * 避免客户端时钟漂移导致财务/管理员无法登录。
 * 使用定长比较防时序侧信道。
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  options: TotpOptions & { window?: number; nowMs?: number } = {}
): boolean {
  const normalized = (code ?? '').replace(/\s+/g, '');
  const digits = options.digits ?? 6;
  if (!new RegExp(`^\\d{${digits}}$`).test(normalized)) return false;
  const stepSeconds = options.stepSeconds ?? 30;
  const window = options.window ?? 1;
  const nowMs = options.nowMs ?? Date.now();
  for (let offset = -window; offset <= window; offset += 1) {
    const candidate = totpAt(
      secretBase32,
      nowMs + offset * stepSeconds * 1000,
      options
    );
    const a = Buffer.from(candidate);
    const b = Buffer.from(normalized);
    if (a.length === b.length && timingSafeEqual(a, b)) return true;
  }
  return false;
}

/**
 * 生成验证器 App 可扫描的 otpauth:// URI（前端用 `qrcode` 渲染二维码）。
 * 标签与发行方需与产品名一致，便于用户在 App 中辨认。
 */
export function buildOtpAuthUri(params: {
  secret: string;
  accountName: string;
  issuer?: string;
  digits?: number;
  stepSeconds?: number;
}): string {
  const issuer = params.issuer ?? '晟笙ERP';
  const label = encodeURIComponent(`${issuer}:${params.accountName}`);
  const query = new URLSearchParams({
    secret: params.secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(params.digits ?? 6),
    period: String(params.stepSeconds ?? 30),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

/** 生成 MFA 恢复码（大写字母 + 数字，去掉易混淆字符 I/O/0/1） */
export function generateRecoveryCodes(count = 8, length = 9): string[] {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const bytes = randomBytes(length);
    let code = '';
    for (let j = 0; j < length; j += 1) {
      code += alphabet[bytes[j] % alphabet.length];
      // 4 位 + 连字符 + 5 位（length=9），便于人工抄写与核对
      if (j === 3) code += '-';
    }
    codes.push(code);
  }
  return codes;
}
