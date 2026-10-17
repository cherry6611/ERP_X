import type { ComponentType } from 'react';
import type { Capability } from '@shared/rbac';
import {
  BookOpen,
  BookOpenCheck,
  Boxes,
  Building2,
  Calculator,
  CalendarCheck,
  CalendarClock,
  Car,
  Cloud,
  Contact,
  Database,
  FileSignature,
  FileSpreadsheet,
  FolderKanban,
  Gauge,
  Laptop,
  Layers,
  LayoutDashboard,
  Library,
  Package,
  PackageX,
  PiggyBank,
  Receipt,
  ScrollText,
  Settings,
  Target,
  TrendingUp,
  Truck,
  Users,
  Wallet,
} from 'lucide-react';

export interface NavItem {
  label: string;
  path: string;
  icon: ComponentType<{ className?: string }>;
  /**
   * B-01：对应 `shared/rbac` 的 `Capability`；缺省则始终可见。
   *
   * 类型**收窄为 `Capability`**（原为 `string`）：导航项写错能力码时，
   * `hasCapability` 返回 false，该菜单项**静默消失** —— 不报错、无告警，
   * 只是"这个功能不见了"。收窄后拼错会在编译期失败。
   * （实测当前 11 个取值全部在册。）
   */
  capability?: Capability;
}

export const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: '经营总览',
    items: [
      { label: '经营看板', path: '/', icon: LayoutDashboard, capability: 'dashboard' },
      // D-12：指标中心（口径说明 + 下钻 + 阈值预警订阅），只对财务口径可见
      { label: '指标中心', path: '/bi/metrics', icon: Gauge, capability: 'finance' },
    ],
  },
  {
    title: '前端业务',
    items: [
      { label: '客户管理', path: '/customers', icon: Users, capability: 'crm' },
      { label: '线索与商机', path: '/crm', icon: Target, capability: 'crm' },
      { label: '合同管理', path: '/contracts', icon: FileSignature, capability: 'crm' },
      { label: '供应商管理', path: '/suppliers', icon: Truck, capability: 'crm' },
      { label: '纳税主体', path: '/masterdata/tax-entities', icon: Library, capability: 'tax_entity' },
    ],
  },
  {
    title: '项目交付',
    items: [
      { label: '项目管理', path: '/projects', icon: FolderKanban, capability: 'projects' },
      { label: '成本核算', path: '/costs', icon: Calculator, capability: 'projects' },
    ],
  },
  {
    title: '采购与资产',
    items: [
      { label: '采购管理', path: '/pur', icon: Package, capability: 'pur_asset' },
      // C-05：采购/销售退货闭环
      // 与 shared/rbac.ts 的 NAV_CAPABILITY['/returns'] 保持一致：
      // 退货页按财务域做路由守卫（采购退货写仍要求 pur_asset），
      // 原 nav 用 pur_asset 会让 PM 看到菜单但点进去被 finance 守卫拒绝。
      { label: '退货管理', path: '/returns', icon: PackageX, capability: 'finance' },
      { label: '固定资产', path: '/asset', icon: Laptop, capability: 'pur_asset' },
    ],
  },
  {
    title: '财务核算',
    items: [
      { label: '收入确认', path: '/revenue', icon: TrendingUp, capability: 'finance' },
      { label: '应收应付', path: '/finance', icon: Wallet, capability: 'finance' },
      // C-04 / D-02：票据（银行/商业承兑汇票）全生命周期与备查簿
      { label: '票据管理', path: '/notes', icon: Receipt, capability: 'finance' },
      { label: '预算费控', path: '/fin-expense', icon: PiggyBank, capability: 'finance' },
      { label: '总账凭证', path: '/voucher', icon: BookOpen, capability: 'finance' },
      { label: '财务报表', path: '/finance/reports', icon: FileSpreadsheet, capability: 'finance' },
      { label: '会计账簿', path: '/finance/ledgers', icon: BookOpenCheck, capability: 'finance' },
      { label: '期末年结', path: '/finance/year-end', icon: CalendarCheck, capability: 'finance' },
      { label: '增值税申报', path: '/finance/tax-declaration', icon: Receipt, capability: 'finance' },
    ],
  },
  {
    title: '人力资源',
    items: [{ label: '人力资源', path: '/hr', icon: Contact, capability: 'hr' }],
  },
  {
    title: '行政管理',
    items: [
      { label: '租房合同', path: '/admin-rent', icon: Building2, capability: 'admin_ops' },
      { label: '行政缴费', path: '/admin-bills', icon: Receipt, capability: 'admin_ops' },
      { label: '行政资产', path: '/admin-assets', icon: Boxes, capability: 'admin_ops' },
      { label: '车辆与差旅', path: '/admin-affairs', icon: Car, capability: 'admin_ops' },
      { label: '自动化任务', path: '/admin-automation', icon: CalendarClock, capability: 'admin_ops' },
    ],
  },
  {
    title: '合规',
    items: [
      { label: '审计日志', path: '/audit', icon: ScrollText, capability: 'audit' },
      { label: '数据资产', path: '/data-asset', icon: Database, capability: 'audit' },
      { label: '设置', path: '/settings', icon: Settings, capability: 'settings_appearance' },
    ],
  },
  {
    title: '企业文档',
    items: [
      { label: '云空间', path: '/drive', icon: Cloud, capability: 'drive' },
      { label: '知识库', path: '/wiki', icon: Library, capability: 'drive' },
    ],
  },
];

export function matchNav(pathname: string): { group: string; label: string } | null {
  for (const group of NAV_GROUPS) {
    const exact = group.items.find((item) => item.path === pathname);
    if (exact) return { group: group.title, label: exact.label };
  }
  for (const group of NAV_GROUPS) {
    const prefix = group.items.find(
      (item) => item.path !== '/' && pathname.startsWith(`${item.path}/`),
    );
    if (prefix) return { group: group.title, label: prefix.label };
  }
  return null;
}

export const BRAND_ICON = Layers;
