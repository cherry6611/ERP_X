import { useMemo } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import {
  Boxes,
  Building2,
  Calculator,
  CalendarClock,
  Car,
  Contact,
  Database,
  FolderKanban,
  LayoutDashboard,
  Laptop,
  Layers,
  Package,
  Receipt,
  ScrollText,
  Target,
  TrendingUp,
  Truck,
  Users,
  Wallet,
  FileSignature,
  BookOpen,
  PiggyBank,
  Cloud,
  Library,
} from 'lucide-react';
import { useCurrentUserProfile } from '@client/src/platform/auth';
import { UserDisplay } from '@client/src/components/business-ui/user-display';
import { cn } from '@client/src/lib/utils';

interface NavItem {
  label: string;
  path: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
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

function matchNav(pathname: string): { group: string; label: string } | null {
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

const Layout = () => {
  const { pathname } = useLocation();
  const crumb = useMemo(() => matchNav(pathname), [pathname]);
  const userInfo = useCurrentUserProfile();

  return (
    <div className="w-screen h-screen flex bg-background">
      <aside className="w-56 shrink-0 border-r bg-card flex flex-col">
        <div className="h-14 flex items-center gap-2.5 px-4 border-b">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <Layers className="size-4" />
          </span>
          <div className="flex flex-col leading-tight">
            <span className="text-sm font-semibold tracking-tight">晟笙 ERP</span>
            <span className="text-[11px] text-muted-foreground">数据服务一体化</span>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto py-4 px-3 flex flex-col gap-5">
          {NAV_GROUPS.map((group) => (
            <div key={group.title} className="flex flex-col gap-1">
              <p className="text-xs text-muted-foreground px-2 mb-1">{group.title}</p>
              {group.items.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === '/'}
                  className={({ isActive }) =>
                    cn(
                      'relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                      isActive
                        ? 'bg-primary/10 text-primary font-medium'
                        : 'text-foreground/80 hover:bg-muted',
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      {isActive ? (
                        <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
                      ) : null}
                      <item.icon className="h-4 w-4 shrink-0" />
                      {item.label}
                    </>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>
      <main className="flex-1 overflow-y-auto min-w-0 flex flex-col">
        <header className="sticky top-0 z-10 h-12 shrink-0 border-b bg-background/95 backdrop-blur flex items-center justify-between px-6">
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            {crumb ? (
              <>
                <span>{crumb.group}</span>
                <span className="text-border">/</span>
                <span className="text-foreground font-medium">{crumb.label}</span>
              </>
            ) : (
              <span>晟笙 ERP</span>
            )}
          </p>
          {userInfo?.user_id ? (
            <UserDisplay value={[userInfo.user_id]} size="small" />
          ) : null}
        </header>
        <Outlet />
      </main>
    </div>
  );
};

export default Layout;
