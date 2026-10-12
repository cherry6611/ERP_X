const ALLOWED_HOSTS = new Set(['feishu.cn', 'larksuite.com', 'larkoffice.com']);
const ALLOWED_SUFFIXES = ['.feishu.cn', '.larksuite.com', '.larkoffice.com'];

/** 仅允许 https 且主机名为飞书/ Lark 官方域 */
export function isAllowedFeishuUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  const host: string = url.hostname.toLowerCase();
  if (ALLOWED_HOSTS.has(host)) return true;
  return ALLOWED_SUFFIXES.some((suffix: string) => host.endsWith(suffix));
}

/** 去掉正文里非白名单 URL，避免审批通知携带外链 */
export function stripDisallowedUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s]+/g, (match: string) =>
    isAllowedFeishuUrl(match) ? match : '[链接已移除]'
  );
}
