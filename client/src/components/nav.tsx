import type { ComponentType } from 'react';
import {
  BookOpen,
  Boxes,
  Building2,
  Calculator,
  CalendarClock,
  Car,
  Cloud,
  Contact,
  Database,
  FileSignature,
  FolderKanban,
  Laptop,
  Layers,
  LayoutDashboard,
  Library,
  Package,
  PiggyBank,
  Receipt,
  ScrollText,
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
}

export const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
  {
    title: '经营总览',
    items: [{ label: '经营看板', path: '/', icon: LayoutDashboard }],
  },
  {
    title: '前端业务',
    items: [
      { label: '客户管理', path: '/customers', icon: Users },
      { label: '线索与商机', path: '/crm', icon: Target },
      { label: '合同管理', path: '/contracts', icon: FileSignature },
      { label: '供应商管理', path: '/suppliers', icon: Truck },
      { label: '纳税主体', path: '/masterdata/tax-entities', icon: Library },
    ],
  },
  {
    title: '项目交付',
    items: [
      { label: '项目管理', path: '/projects', icon: FolderKanban },
      { label: '成本核算', path: '/costs', icon: Calculator },
    ],
  },
  {
    title: '采购与资产',
    items: [
      { label: '采购管理', path: '/pur', icon: Package },
      { label: '固定资产', path: '/asset', icon: Laptop },
    ],
  },
  {
    title: '财务核算',
    items: [
      { label: '收入确认', path: '/revenue', icon: TrendingUp },
      { label: '应收应付', path: '/finance', icon: Wallet },
      { label: '预算费控', path: '/fin-expense', icon: PiggyBank },
      { label: '总账凭证', path: '/voucher', icon: BookOpen },
    ],
  },
  {
    title: '人力资源',
    items: [{ label: '人力资源', path: '/hr', icon: Contact }],
  },
  {
    title: '行政管理',
    items: [
      { label: '租房合同', path: '/admin-rent', icon: Building2 },
      { label: '行政缴费', path: '/admin-bills', icon: Receipt },
      { label: '行政资产', path: '/admin-assets', icon: Boxes },
      { label: '车辆与差旅', path: '/admin-affairs', icon: Car },
      { label: '自动化任务', path: '/admin-automation', icon: CalendarClock },
    ],
  },
  {
    title: '合规',
    items: [
      { label: '审计日志', path: '/audit', icon: ScrollText },
      { label: '数据资产', path: '/data-asset', icon: Database },
    ],
  },
  {
    title: '企业文档',
    items: [
      { label: '云空间', path: '/drive', icon: Cloud },
      { label: '知识库', path: '/wiki', icon: Library },
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
