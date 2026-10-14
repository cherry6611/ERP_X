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

/** 导航 path → 所需能力（有其一可读即可显示） */
export const NAV_CAPABILITY: Record<string, Capability> = {
  '/': 'dashboard',
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
  '/data-asset': 'audit',
  '/settings': 'settings_appearance',
  '/drive': 'drive',
  '/wiki': 'drive',
};

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

export function canSeeNavPath(roles: string[], path: string): boolean {
  const cap = NAV_CAPABILITY[path];
  if (!cap) return true;
  return hasCapability(roles, cap);
}
