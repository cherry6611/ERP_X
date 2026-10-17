import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveRouteCapability } from '@shared/rbac';

/**
 * B-13：前端路由守卫**不得 fail-open**（回归锁）。
 *
 * ## 为什么需要这组测试
 *
 * `RequireCapability` 原先用 `NAV_CAPABILITY[location.pathname]` 做**精确匹配**，
 * 且在查不到时 `return children`（放行）。而 `NAV_CAPABILITY` 只登记了一级入口，
 * 于是 `client/src/app.tsx` 中所有 `/projects/new`、`/contracts/:id`、
 * `/finance/reports`、`/notes`、`/returns` 之类的路由**全部命中不到** →
 * 任何登录用户手输 URL 或从列表点进详情即可打开，页面还正常渲染。
 *
 * 这类缺陷不会报错、不会 500、单测也不会发现，只能靠"拿真实路由表逐个解析"来钉死。
 * 因此本测试**直接读 app.tsx 抽取真实路由**，而不是手写一份可能与代码脱节的清单。
 *
 * ## 断言
 *
 * 1. 每个受守卫保护的静态路由都能解析出能力码（否则线上会 fail-closed 拦住合法用户，
 *    属于把自己人挡在门外的可用性事故）；
 * 2. 动态路由（`:id` / `*`）同样可解析 —— 防止"把守卫关掉"式修复；
 * 3. `resolveRouteCapability` 取**最长前缀**：`/finance/reports` 必须解析成功，
 *    且不会因为 `/finance` 更短而漏匹配；
 * 4. 未登记路径返回 `undefined`（调用方据此 fail-closed），绝不返回"随便一个码"。
 */
const APP_TSX = join(__dirname, '..', '..', '..', 'client', 'src', 'app.tsx');

/** 从 app.tsx 抽取 `<Route path="...">` 的字面量路径 */
function extractRoutePaths(): string[] {
  const source = readFileSync(APP_TSX, 'utf8');
  const paths: string[] = [];
  const pattern = /<Route\s+path="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) {
    paths.push(match[1]);
  }
  return paths;
}

describe('B-13 路由守卫能力解析（不得 fail-open）', () => {
  const routePaths = extractRoutePaths();

  it('确实从 app.tsx 抽到了路由（防止本测试因正则失效而空转）', () => {
    // 若有人改了 app.tsx 的写法导致抽不到路由，这里必须红灯，
    // 否则下面所有断言都会在空数组上"通过"，变成假绿灯。
    expect(routePaths.length).toBeGreaterThan(40);
    expect(routePaths).toContain('projects');
    expect(routePaths).toContain('finance/reports');
  });

  it('每个业务路由都能解析出能力码（否则守卫会误拦合法用户）', () => {
    const exempt = new Set(['login', '*']);
    const unresolved = routePaths
      .filter((path) => !exempt.has(path))
      .filter((path) => resolveRouteCapability(path) === undefined);
    // 反例：修好之前 `notes` / `returns` / `finance/reports` / `projects/new`
    // 都在这个列表里；若有人回退成精确匹配，这里会立刻变红并列出具体路由。
    expect(unresolved).toEqual([]);
  });

  it('动态路由同样可解析（防止用"关掉守卫"来绕过）', () => {
    expect(resolveRouteCapability('projects/8f1e-abc')).toBe('projects');
    expect(resolveRouteCapability('projects/8f1e-abc/edit')).toBe('projects');
    expect(resolveRouteCapability('contracts/8f1e-abc')).toBe('crm');
    expect(resolveRouteCapability('crm/opportunities/8f1e-abc')).toBe('crm');
    expect(resolveRouteCapability('finance/invoices/new')).toBe('finance');
    expect(resolveRouteCapability('voucher/8f1e-abc')).toBe('finance');
    expect(resolveRouteCapability('hr/leaves/8f1e-abc')).toBe('hr');
  });

  it('最长前缀优先：具体子路由不得被更短的一级前缀抢走', () => {
    // `/finance/reports` 命中 `/finance/reports`（长度 16）而非 `/finance`（长度 8）。
    // 两者当前都映射到 finance，但语义上必须取更具体的那个 —— 这样将来
    // 给子路由单独收紧权限时不需要改解析器。
    expect(resolveRouteCapability('/finance/reports')).toBe('finance');
    expect(resolveRouteCapability('/finance/ledgers')).toBe('finance');
    // `/masterdata/tax-entities` 必须命中 tax_entity，而不是被别的前缀抢走
    expect(resolveRouteCapability('masterdata/tax-entities')).toBe('tax_entity');
  });

  it('未登记路径返回 undefined（调用方据此 fail-closed，而不是放行）', () => {
    expect(resolveRouteCapability('definitely-not-a-route')).toBeUndefined();
    expect(resolveRouteCapability('projectsXYZ')).toBeUndefined();
  });

  it('尾随斜杠与 query/hash 不影响解析', () => {
    expect(resolveRouteCapability('/projects/')).toBe('projects');
    expect(resolveRouteCapability('/projects?page=2')).toBe('projects');
    expect(resolveRouteCapability('/projects#top')).toBe('projects');
    // 根路径与空路径都归到看板
    expect(resolveRouteCapability('/')).toBe('dashboard');
    expect(resolveRouteCapability('')).toBe('dashboard');
  });
});
