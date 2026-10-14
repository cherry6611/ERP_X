/** 与 Vite define 的 CLIENT_BASE_PATH 对齐，子路径部署时保证回跳正确 */
export function clientBasePath(): string {
  const raw = (process.env.CLIENT_BASE_PATH || '/').trim() || '/';
  if (raw === '/') return '/';
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

export function withBasePath(path: string): string {
  const base = clientBasePath();
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (base === '/') return normalized;
  return `${base}${normalized}`;
}
