/** 审计落库前必须脱敏的字段（大小写不敏感） */
const SENSITIVE_KEYS = new Set([
  'password',
  'passwd',
  'pwd',
  'app_secret',
  'appsecret',
  'client_secret',
  'clientsecret',
  'api_key',
  'apikey',
  'secret',
  'token',
  'access_token',
  'refresh_token',
  'authorization',
  'secret_enc_key',
  'jwt_secret',
  'newpassword',
  'oldpassword',
  'confirmpassword',
  'currentpassword',
  'mfatoken',
  'mfacode',
  'smscode',
  'captcha',
  'verifycode',
]);

/**
 * 规范化后缀兜底：key 转小写并去除非字母数字字符后，
 * 以这些后缀之一结尾即视为敏感（覆盖 xPassword / x_token 等未来变体）。
 * 仅用后缀匹配（endsWith），不用宽泛 substring——
 * tokenCount / secretName / passwordHint 等无害字段不得被误脱敏。
 */
const SENSITIVE_SUFFIXES = [
  'password',
  'pwd',
  'secret',
  'token',
  'captcha',
  'verifycode',
] as const;

function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEYS.has(key.toLowerCase())) return true;
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix));
}

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = redactValue(nested, depth + 1);
    }
  }
  return out;
}

/** 测试导出别名 */
export const redactValueForTest = redactValue;
