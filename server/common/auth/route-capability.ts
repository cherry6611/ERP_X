import type { Capability } from '@shared/rbac';

/**
 * B-01：后端路由 → 能力码（Capability）映射表。
 *
 * 为什么需要这张表：
 *   1. 全仓有 170+ 处 `@CanRole(['admin'])`，逐个人工判断容易漏改且无法在 CI 拦截；
 *   2. 能力码必须与 `shared/rbac.ts` 的 MATRIX **同一份数据**，所以这里只做
 *      "路由前缀 + HTTP 方法 → 能力码"的机械映射，权限结论仍由 MATRIX 决定；
 *   3. `scripts/check-rbac-consistency.mjs` 会用同一张表扫描代码，
 *      发现"仍有 @CanRole(['admin']) 未被替代"或"用了未登记的能力码"就失败。
 *
 * 约定：
 *   - `read` 为该前缀下 GET 类接口所需能力；
 *   - `write` 为该前缀下写接口所需能力（缺省 = read + '_write'，若 MATRIX 中存在）；
 *   - `write: null` 表示该前缀下所有写接口都应使用与 read 相同的能力
 *     （如 admin_ops / audit 只有 admin 可写，没有单独的 *_write 能力）。
 */
export interface RouteCapabilityRule {
  /** `@Controller()` 路径前缀，最长匹配优先 */
  prefix: string;
  read: Capability;
  write?: Capability | null;
  /** 说明：为什么这样映射（评审与回归时的依据） */
  note: string;
}

export const ROUTE_CAPABILITY_RULES: RouteCapabilityRule[] = [
  {
    prefix: 'api/finance',
    read: 'finance',
    write: 'finance_write',
    note: '财务台账/报表/账簿读=finance（admin+finance_viewer），写=finance_write（仅 admin）',
  },
  {
    prefix: 'api/voucher',
    read: 'finance',
    write: 'finance_write',
    note: '凭证与期间结账属财务写权限',
  },
  {
    prefix: 'api/revenues',
    read: 'finance',
    write: 'finance_write',
    note: '收入确认影响账务口径',
  },
  {
    prefix: 'api/fin-expense',
    read: 'finance',
    write: 'finance_write',
    note: '经费申请/报销属财务写权限',
  },
  {
    prefix: 'api/fin-budget',
    read: 'finance',
    write: 'finance_write',
    note: '预算费控属财务写权限',
  },
  {
    prefix: 'api/hr',
    read: 'hr',
    write: 'hr_write',
    note: 'HR 读=hr（admin+hr_manager），写=hr_write（admin+hr_manager）',
  },
  {
    prefix: 'api/projects',
    read: 'projects',
    write: 'projects_write',
    note: '项目读=projects，写=projects_write（admin+project_manager）',
  },
  {
    prefix: 'api/contracts',
    read: 'crm',
    write: 'crm_write',
    note: '合同属前端业务域',
  },
  {
    prefix: 'api/crm',
    read: 'crm',
    write: 'crm_write',
    note: '线索/商机/报价属前端业务域',
  },
  {
    prefix: 'api/master-data',
    read: 'crm',
    write: 'crm_write',
    note: '客户/供应商等主数据属前端业务域',
  },
  {
    prefix: 'api/master-data/tax-entities',
    read: 'tax_entity',
    write: null,
    note: '纳税主体单独能力码（finance_viewer 可读，仅 admin 可写）',
  },
  {
    prefix: 'api/tax',
    read: 'tax_entity',
    write: null,
    note: '税率解析与主体配置同 tax_entity',
  },
  {
    prefix: 'api/costs',
    read: 'projects',
    write: 'projects_write',
    note: '成本核算按项目域授权',
  },
  {
    prefix: 'api/pur',
    read: 'pur_asset',
    write: null,
    note: '采购与资产同域，仅 admin 可写（MATRIX 无 pur_write）',
  },
  {
    prefix: 'api/asset',
    read: 'pur_asset',
    write: null,
    note: '固定资产同采购域',
  },
  {
    prefix: 'api/admin',
    read: 'admin_ops',
    write: null,
    note: '行政（租约/账单/资产/事务/自动化）仅 admin',
  },
  {
    prefix: 'api/audit',
    read: 'audit',
    write: null,
    note: '审计日志仅 admin（含数据资产页所在的 audit 能力）',
  },
  {
    prefix: 'api/identity',
    read: 'identity',
    write: null,
    note: '用户与角色管理=identity（admin+user_admin）',
  },
  {
    prefix: 'api/drive',
    read: 'drive',
    write: 'drive_write',
    note: '云空间读=drive（全员可读），写=drive_write（admin+drive_editor）',
  },
  {
    prefix: 'api/wiki',
    read: 'drive',
    write: 'drive_write',
    note: '知识库同云空间',
  },
  {
    prefix: 'api/settings',
    read: 'settings_appearance',
    write: null,
    note: '站点设置：外观全员可读，品牌/飞书配置仅 admin（控制器内细分）',
  },
  {
    prefix: 'api/system',
    read: 'admin_ops',
    write: null,
    note: '字典/参数/编号规则：读对登录用户开放（options），写仅 admin',
  },
  {
    prefix: 'api/data-asset',
    read: 'audit',
    write: null,
    note: '数据资产沿用 audit 能力码（既有 NAV_CAPABILITY 约定）',
  },
  {
    prefix: 'api/notifications',
    read: 'dashboard',
    write: null,
    note: '站内信：登录即可（dashboard 默认可读）',
  },
  {
    prefix: 'api/semantic',
    read: 'dashboard',
    write: null,
    note: '语义检索：登录即可',
  },
  {
    prefix: 'api/files',
    read: 'dashboard',
    write: null,
    note: '文件上传/下载：依赖附件归属校验，不再叠加角色',
  },
  {
    prefix: 'api/attachments',
    read: 'dashboard',
    write: null,
    note: '附件：登录即可（写操作由服务层做归属与资源类型校验）',
  },
  {
    prefix: 'api/exports',
    read: 'dashboard',
    write: null,
    note: '异步导出：登录即可，导出内容受各域查询过滤',
  },
  {
    prefix: 'api/tasks',
    read: 'dashboard',
    write: null,
    note: '待办中心：登录即可，结果按权限过滤',
  },
  {
    prefix: 'api/feishu',
    read: 'drive',
    write: 'drive_write',
    note: '飞书协作配置读写：读放行、写仅 admin',
  },
  {
    prefix: 'api/feishu-sync',
    read: 'drive',
    write: 'drive_write',
    note: '飞书同步配置同云文档域',
  },
  {
    prefix: 'api/auth',
    read: 'dashboard',
    write: null,
    note: '认证：公共接口 + 登录态自服务（MFA/密码/会话）',
  },
  {
    prefix: 'api/health',
    read: 'dashboard',
    write: null,
    note: '健康检查：公开',
  },
  {
    prefix: 'api/directory',
    read: 'dashboard',
    write: null,
    note: '通讯录：登录即可',
  },
  {
    prefix: 'api/openapi',
    read: 'admin_ops',
    write: null,
    note: 'OpenAPI 文档与 Swagger UI 仅内网 + admin',
  },
  {
    prefix: 'api',
    read: 'dashboard',
    write: null,
    note: '兜底：未知前缀按登录即可读，写操作必须显式登记（CI 会检查）',
  },
];

/** 最长前缀优先匹配 */
export function resolveCapability(
  controllerPath: string,
  method: 'read' | 'write'
): Capability {
  const normalized = controllerPath.replace(/^\/+|\/+$/g, '');
  const matches = ROUTE_CAPABILITY_RULES.filter((rule) =>
    normalized === rule.prefix || normalized.startsWith(`${rule.prefix}/`)
  ).sort((a, b) => b.prefix.length - a.prefix.length);
  const rule = matches[0] ?? ROUTE_CAPABILITY_RULES[ROUTE_CAPABILITY_RULES.length - 1];
  if (method === 'read') return rule.read;
  return rule.write ?? rule.read;
}
