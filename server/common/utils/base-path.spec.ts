/** 与客户端 withBasePath 逻辑对齐的纯函数单测（无 DOM） */
function clientBasePath(rawEnv: string | undefined): string {
  const raw = (rawEnv || '/').trim() || '/';
  if (raw === '/') return '/';
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

function withBasePath(path: string, rawEnv?: string): string {
  const base = clientBasePath(rawEnv);
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (base === '/') return normalized;
  return `${base}${normalized}`;
}

describe('CLIENT_BASE_PATH helpers', () => {
  it('keeps root deployment at /login', () => {
    expect(withBasePath('/login', '/')).toBe('/login');
    expect(withBasePath('/login', undefined)).toBe('/login');
  });

  it('prefixes subpath deployments', () => {
    expect(withBasePath('/login', '/erp')).toBe('/erp/login');
    expect(withBasePath('/login', '/erp/')).toBe('/erp/login');
  });
});
