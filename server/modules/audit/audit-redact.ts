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
]);

export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      out[key] = '[REDACTED]';
    } else {
      out[key] = redactValue(nested, depth + 1);
    }
  }
  return out;
}

/** 测试导出别名 */
export const redactValueForTest = redactValue;
