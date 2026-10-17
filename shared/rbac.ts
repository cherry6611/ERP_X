/**
 * 角色 → 模块能力矩阵（前后端共享）。
 * 与需求设计书 v2.0 第二章对齐。
 *
 * B-01 落地约定（务必与 `server/common/auth/route-capability.ts` 保持一致）：
 *   - 只读能力（不带 `_write` 后缀）在 `RolesGuard` 中按 `hasCapability` 判定，
 *     写能力按 `hasWriteCapability` 判定（要求矩阵里是 `rw`）；
 *   - 因此"某角色能写某域"必须体现为 `xxx_write: { 角色: 'rw' }`，
 *     不能只在该域上给 `rw` —— 后者只授予读权限。
 */

export const ROLE_CODES = [
  'admin',
  'user_admin',
  'hr_manager',
  'finance_viewer',
  'project_manager',
  'drive_editor',
] as const;

export type RoleCode = (typeof ROLE_CODES)[number];

export const ROLE_LABELS: Record<RoleCode, string> = {
  admin: '超级管理员',
  user_admin: '账号管理员',
  hr_manager: '人事经理',
  finance_viewer: '财务只读',
  project_manager: '项目经理',
  drive_editor: '云文档编辑',
};

/** 侧栏/页面级能力码 */
export type Capability =
  | 'dashboard'
  | 'crm'
  | 'crm_write'
  | 'tax_entity'
  | 'projects'
  | 'projects_write'
  | 'pur_asset'
  | 'finance'
  | 'finance_write'
  | 'hr'
  | 'hr_write'
  | 'identity'
  | 'admin_ops'
  | 'audit'
  /**
   * 数据资产（数据集 / 授权 / 脱敏 / 到期预警）。
   *
   * ## 为什么从 `audit` 里拆出来
   *
   * 原先 `/data-asset` 直接沿用 `audit`（审计日志）的能力码，于是
   * **两个互不相干的业务域由同一个开关控制**：想让人看审计日志就必然
   * 也能进数据资产，反之亦然。审计 §5.10 / P2-2 把这条列为"需业务确认"，
   * 业务侧确认为**权限分离**。
   *
   * ## 为什么仍然只有 admin
   *
   * 拆分**不等于放开**：`da_dataset` 虽有 `contract_id`，但该模块
   * **完全没有行级范围过滤**（`data-scope.service.ts` 未接入）。若此刻
   * 放给非 admin，任何人都会看到**所有合同**的数据集与脱敏级别。
   * 因此本次只做"分离"，可见范围维持仅 admin；将来若要按项目收窄，
   * 必须先实现 SQL 层行级过滤再把角色加进下面的矩阵。
   */
  | 'data_asset'
  | 'drive'
  | 'drive_write'
  | 'settings_brand'
  | 'settings_feishu'
  | 'settings_appearance';

type Access = 'rw' | 'r' | '-';

const MATRIX: Record<Capability, Partial<Record<RoleCode, Access>> & { _default?: Access }> = {
  dashboard: { admin: 'rw', _default: 'r' },
  crm: {
    admin: 'rw',
    finance_viewer: 'r',
    project_manager: 'r',
  },
  crm_write: { admin: 'rw' },
  tax_entity: { admin: 'rw', finance_viewer: 'r' },
  projects: {
    admin: 'rw',
    finance_viewer: 'r',
    project_manager: 'rw',
  },
  projects_write: { admin: 'rw', project_manager: 'rw' },
  pur_asset: {
    admin: 'rw',
    finance_viewer: 'r',
    project_manager: 'r',
  },
  finance: { admin: 'rw', finance_viewer: 'r' },
  finance_write: { admin: 'rw' },
  hr: {
    admin: 'rw',
    user_admin: 'r',
    hr_manager: 'rw',
  },
  hr_write: { admin: 'rw', hr_manager: 'rw' },
  identity: { admin: 'rw', user_admin: 'rw' },
  admin_ops: { admin: 'rw' },
  audit: { admin: 'rw' },
  /*
   * 数据资产：与 audit 分离后**仍仅 admin**（见 Capability 联合类型里的说明：
   * 该模块尚无行级范围，放开即等于跨合同可见）。
   */
  data_asset: { admin: 'rw' },
  drive: {
    admin: 'rw',
    user_admin: 'r',
    hr_manager: 'r',
    finance_viewer: 'r',
    project_manager: 'r',
    drive_editor: 'rw',
    _default: 'r',
  },
  drive_write: { admin: 'rw', drive_editor: 'rw' },
  settings_brand: { admin: 'rw' },
  settings_feishu: { admin: 'rw' },
  settings_appearance: { admin: 'rw', _default: 'r' },
};

/**
 * 路由 path → 所需能力。
 *
 * ## 匹配语义（B-13 修复，改动前务必读完）
 *
 * 取值一律通过 `resolveRouteCapability()` 做**最长前缀**匹配，**不要**直接
 * `NAV_CAPABILITY[pathname]` 下标的精确匹配。
 *
 * 原实现是精确匹配 + 查不到就放行（`if (!required) return children`），
 * 而这张表只登记了 25 个**一级入口**，于是 `client/src/app.tsx` 里所有
 * 形如 `/projects/new`、`/contracts/:id`、`/finance/reports` 的路由
 * 全都命中不到 → `required` 为 undefined → **任何登录用户都能直接打开**。
 * 侧栏隐藏了入口，但手输 URL 或从列表点进详情页即可绕过，且页面会正常渲染
 * （不报错、不提示），属于"看起来正常"的越权。
 *
 * 现在：`/projects/new` 由前缀 `/projects` 解析为 `projects`；
 * 解析不出来的路径 **fail-closed**（返回 `undefined` 由调用方拒绝），
 * 而不是放行。
 */
export const NAV_CAPABILITY: Record<string, Capability> = {
  '/': 'dashboard',
  '/bi/metrics': 'dashboard',
  '/notes': 'finance',
  '/returns': 'finance',
  '/customers': 'crm',
  '/crm': 'crm',
  '/contracts': 'crm',
  '/suppliers': 'crm',
  '/masterdata/tax-entities': 'tax_entity',
  '/projects': 'projects',
  '/costs': 'projects',
  '/pur': 'pur_asset',
  '/asset': 'pur_asset',
  '/revenue': 'finance',
  '/finance': 'finance',
  '/fin-expense': 'finance',
  '/voucher': 'finance',
  '/finance/reports': 'finance',
  '/finance/ledgers': 'finance',
  '/finance/year-end': 'finance',
  '/finance/tax-declaration': 'finance',
  '/hr': 'hr',
  '/admin-rent': 'admin_ops',
  '/admin-bills': 'admin_ops',
  '/admin-assets': 'admin_ops',
  '/admin-affairs': 'admin_ops',
  '/admin-automation': 'admin_ops',
  '/audit': 'audit',
  '/data-asset': 'data_asset',
  '/settings': 'settings_appearance',
  '/drive': 'drive',
  '/wiki': 'drive',
};

/**
 * 按**最长前缀**解析路径所需能力。
 *
 * @param pathname 当前路由路径（可带或不带前导 `/`，可带 query/hash 由调用方先剥离）
 * @returns 命中的能力码；`undefined` 表示**无法判定** —— 调用方必须按
 *          fail-closed 处理（拒绝访问并给出可读提示），不得放行。
 *
 * 为什么要"最长前缀"而不是"逐级回退"：`/finance/reports` 与 `/finance` 同时命中时
 * 必须取更具体的那个；同名能力时结果相同，但为将来给子路由单独收紧留出能力。
 */
export function resolveRouteCapability(pathname: string): Capability | undefined {
  // 去掉 query / hash，统一无前导斜杠形式，避免因尾部斜杠或参数导致漏匹配
  const clean = (pathname ?? '').split('?')[0]!.split('#')[0]!;
  const trimmed = clean.replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return NAV_CAPABILITY['/'];

  const candidates = Object.keys(NAV_CAPABILITY)
    .map((key) => key.replace(/^\/+|\/+$/g, ''))
    .filter((key) => key !== '')
    .filter((key) => trimmed === key || trimmed.startsWith(`${key}/`))
    // 长前缀优先（`finance/reports` 优先于 `finance`）；同长度按字典序稳定排序
    .sort((a, b) => b.length - a.length || a.localeCompare(b));

  const winner = candidates[0];
  if (!winner) return undefined;
  return NAV_CAPABILITY[`/${winner}`];
}

function roleAccess(cap: Capability, role: string): Access | undefined {
  const row = MATRIX[cap];
  if (!row) return undefined;
  if (role in row) return row[role as RoleCode];
  return row._default;
}

/** 是否至少具备读权限 */
export function hasCapability(roles: string[], capability: Capability): boolean {
  if (roles.includes('admin')) return true;
  for (const role of roles) {
    const access = roleAccess(capability, role);
    if (access === 'r' || access === 'rw') return true;
  }
  // 无角色但仍登录：仅 _default
  if (roles.length === 0) {
    const access = MATRIX[capability]?._default;
    return access === 'r' || access === 'rw';
  }
  return false;
}

export function hasWriteCapability(roles: string[], capability: Capability): boolean {
  if (roles.includes('admin')) return true;
  for (const role of roles) {
    if (roleAccess(capability, role) === 'rw') return true;
  }
  return false;
}

export function listCapabilities(roles: string[]): Capability[] {
  const caps = Object.keys(MATRIX) as Capability[];
  return caps.filter((cap) => hasCapability(roles, cap));
}

/**
 * 侧栏是否显示该入口。
 *
 * 与路由守卫的区别：**侧栏是"少显示不报错"的体验层**，未知路径保持可见
 * （避免新页面因漏登记而整体从侧栏消失）；而路由守卫必须 fail-closed。
 * 两者共用同一张表，但缺省行为相反，因此不要合并成一个函数。
 */
export function canSeeNavPath(roles: string[], path: string): boolean {
  const cap = NAV_CAPABILITY[path] ?? resolveRouteCapability(path);
  if (!cap) return true;
  return hasCapability(roles, cap);
}

