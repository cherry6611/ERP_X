import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';

const PREFIX = 'enc1:';

/**
 * AES-256-GCM。密钥来自环境变量 SECRET_ENC_KEY（32 字节原文，或任意高熵字符串再 SHA-256）。
 * 禁止把密钥写入 .env 并提交。
 */
export function encryptSecret(plain: string, keyRaw: string): string {
  const key: Buffer = deriveKey(keyRaw);
  const iv: Buffer = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext: Buffer = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  const tag: Buffer = cipher.getAuthTag();
  return `${PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString('base64url')}`;
}

/** 只接受 enc1 密文。历史明文必须先清空再重新写入，避免密钥轮换后误用明文。 */
export function decryptSecret(stored: string, keyRaw: string | undefined): string {
  if (!stored.startsWith(PREFIX)) {
    throw new Error('应用密钥不是 enc1 密文，拒绝按明文使用');
  }
  if (!keyRaw) {
    throw new Error('SECRET_ENC_KEY 未配置，无法解密应用密钥');
  }
  const packed: Buffer = Buffer.from(stored.slice(PREFIX.length), 'base64url');
  const iv: Buffer = packed.subarray(0, 12);
  const tag: Buffer = packed.subarray(12, 28);
  const ciphertext: Buffer = packed.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(keyRaw), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    'utf8'
  );
}

export function isEncryptedSecret(stored: string): boolean {
  return stored.startsWith(PREFIX);
}

export function secretKeyFromEnv(): string | undefined {
  const value: string | undefined = process.env.SECRET_ENC_KEY;
  if (!value || value.trim().length < 16) return undefined;
  return value.trim();
}

function deriveKey(keyRaw: string): Buffer {
  return createHash('sha256').update(keyRaw, 'utf8').digest();
}
