import { useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { ChevronDown, ChevronRight, LogOut, PanelLeft, Plus, Search } from 'lucide-react';
import { useAuth, useCurrentUserProfile } from '@client/src/platform/auth';
import { RequireCapability } from '@client/src/platform/RequireCapability';
import { UserDisplay } from '@client/src/components/business-ui/user-display';
import { InboxBell } from '@client/src/components/InboxBell';
import { ThemeToggle } from '@client/src/components/ThemeToggle';
import { Button } from '@client/src/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@client/src/components/ui/tooltip';
import { CommandMenu, useCommandMenu } from '@client/src/components/CommandMenu';
import { BRAND_ICON, NAV_FOOTER_GROUPS, NAV_GROUPS, matchNav } from '@client/src/components/nav';
import { PageMetaProvider, useEntityName } from '@client/src/components/page-meta';
import { cn } from '@client/src/lib/utils';
import { settingsApi } from '@client/src/api';
import type { Capability } from '@shared/rbac';

const NAV_GROUPS_COLLAPSED_KEY = 'erp-nav-groups-collapsed-v2';

function readCollapsedGroups(): string[] {
  try {
    const raw = window.localStorage.getItem(NAV_GROUPS_COLLAPSED_KEY);
    /*
     * 默认折叠低频分组：7 个分组全展开时财务组会落到首屏之外，
     * 用户会以为“财务没有菜单”。工作台/客户合同/项目交付/财务保持展开，
     * 采购资产/人力行政/企业文档默认折叠，点分组标题即可展开。
     */
    if (!raw) return ['采购与资产', '人力与行政', '企业文档'];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

function LayoutFrame() {
  const { pathname } = useLocation();
  const crumb = matchNav(pathname);
  const entityName = useEntityName();
  const userInfo = useCurrentUserProfile();
  const { logout, hasCapability } = useAuth();
  const { open, setOpen } = useCommandMenu();
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem('erp-sidebar-collapsed') === '1');
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(readCollapsedGroups);
  const [footerOpen, setFooterOpen] = useState(false);
  const [brandName, setBrandName] = useState('晟笙 ERP');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const BrandIcon = BRAND_ICON;

  useEffect(() => {
    void settingsApi
      .getBrand()
      .then((b) => {
        const name = b.brandName || '晟笙 ERP';
        setBrandName(name);
        setLogoUrl(b.logoUrl);
        document.title = name;
        if (b.faviconUrl) {
          let link = document.querySelector<HTMLLinkElement>("link[rel='icon']");
          if (!link) {
            link = document.createElement('link');
            link.rel = 'icon';
            document.head.appendChild(link);
          }
          link.href = b.faviconUrl;
        }
      })
      .catch(() => undefined);
  }, []);

  const visibleGroups = useMemo(
    () =>
      NAV_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter(
          (item) =>
            !item.capability || hasCapability(item.capability as Capability),
        ),
      })).filter((group) => group.items.length > 0),
    [hasCapability],
  );

  const visibleFooterGroups = useMemo(
    () =>
      NAV_FOOTER_GROUPS.map((group) => ({
        ...group,
        items: group.items.filter(
          (item) =>
            !item.capability || hasCapability(item.capability as Capability),
        ),
      })).filter((group) => group.items.length > 0),
    [hasCapability],
  );

  const toggleCollapsed = () => {
    setCollapsed((current) => {
      window.localStorage.setItem('erp-sidebar-collapsed', current ? '0' : '1');
      return !current;
    });
  };

  const toggleGroup = (title: string) => {
    setCollapsedGroups((current) => {
      const next = current.includes(title)
        ? current.filter((t) => t !== title)
        : [...current, title];
      window.localStorage.setItem(NAV_GROUPS_COLLAPSED_KEY, JSON.stringify(next));
      return next;
    });
  };

  // 窄屏自动收起为 rail
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const apply = () => {
      if (mq.matches) {
        setCollapsed(true);
        window.localStorage.setItem('erp-sidebar-collapsed', '1');
      }
    };
    apply();
    mq.addEventListener('change', apply);
    return () => mq.removeEventListener('change', apply);
  }, []);

  return (
    <TooltipProvider delayDuration={200}>
    <div className="flex h-screen w-screen bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:shadow-pop"
      >
        跳过导航
      </a>
      <aside
        className={cn(
          'flex shrink-0 flex-col border-r bg-sidebar',
          collapsed ? 'w-[68px]' : 'w-[232px]',
        )}
      >
        <div className="flex h-[60px] items-center gap-2.5 border-b border-sidebar-border px-4">
          <span className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-[9px] bg-primary text-primary-foreground">
            {logoUrl ? (
              <img src={logoUrl} alt="" className="size-8 object-contain" />
            ) : (
              <BrandIcon className="size-4" />
            )}
          </span>
          {collapsed ? null : (
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-sm font-semibold tracking-tight">{brandName}</span>
              <span className="truncate text-[11px] uppercase tracking-wide text-muted-foreground">
                数据服务一体化
              </span>
            </div>
          )}
        </div>
        <nav className="flex flex-1 flex-col gap-2.5 overflow-y-auto px-3 py-4" aria-label="主导航">
          {visibleGroups.map((group) => {
            const groupCollapsed = !collapsed && collapsedGroups.includes(group.title);
            return (
              <div
                key={group.title}
                className={
                  group.title === '财务'
                    ? 'grid grid-cols-2 gap-x-1 gap-y-0.5'
                    : 'flex flex-col gap-1'
                }
              >
                {collapsed ? null : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className={cn(
                      'mb-1 h-auto w-full justify-start gap-1 rounded-md px-2 py-1 text-left text-[10px] font-medium tracking-[0.08em] text-muted-foreground/80 hover:bg-muted hover:text-foreground',
                      group.title === '财务' && 'col-span-2',
                    )}
                    aria-expanded={!groupCollapsed}
                    onClick={() => toggleGroup(group.title)}
                  >
                    {groupCollapsed ? (
                      <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
                    ) : (
                      <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
                    )}
                    <span className="truncate">{group.title}</span>
                  </Button>
                )}
                {groupCollapsed
                  ? null
                  : group.items.map((item) => {
                      const linkClass = ({ isActive }: { isActive: boolean }) =>
                        cn(
                          'relative flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors duration-150',
                          isActive
                            ? 'bg-primary/[0.08] font-medium text-primary'
                            : 'text-foreground/75 hover:bg-muted/80 hover:text-foreground',
                          group.title === '财务' && 'h-8 gap-2 px-2 text-[12px]',
                          collapsed && 'justify-center',
                        );
                      const linkBody = ({ isActive }: { isActive: boolean }) => (
                        <>
                          {isActive ? (
                            <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
                          ) : null}
                          <item.icon className="h-4 w-4 shrink-0" />
                          {collapsed ? (
                            <span className="sr-only">{item.label}</span>
                          ) : (
                            item.label
                          )}
                        </>
                      );
                      if (!collapsed) {
                        return (
                          <NavLink
                            key={item.path}
                            to={item.path}
                            end={item.path === '/'}
                            className={linkClass}
                          >
                            {linkBody}
                          </NavLink>
                        );
                      }
                      return (
                        <Tooltip key={item.path}>
                          <TooltipTrigger asChild>
                            <NavLink
                              to={item.path}
                              end={item.path === '/'}
                              className={linkClass}
                            >
                              {linkBody}
                            </NavLink>
                          </TooltipTrigger>
                          <TooltipContent side="right">
                            {group.title} · {item.label}
                          </TooltipContent>
                        </Tooltip>
                      );
                    })}
              </div>
            );
          })}
        </nav>
        <div className="border-t border-sidebar-border px-3 py-3">
          {visibleFooterGroups.map((group) => (
            <div key={group.title} className="flex flex-col gap-0.5">
              {collapsed ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 w-full justify-start gap-1 px-2 text-[10px] font-medium tracking-[0.08em] text-muted-foreground/70 hover:text-foreground"
                  aria-expanded={footerOpen}
                  onClick={() => setFooterOpen((open) => !open)}
                >
                  {footerOpen ? (
                    <ChevronDown className="size-3" />
                  ) : (
                    <ChevronRight className="size-3" />
                  )}
                  {group.title}
                </Button>
              )}
              {(collapsed || footerOpen) && group.items.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  end={item.path === '/'}
                  title={collapsed ? item.label : undefined}
                  className={({ isActive }) =>
                    cn(
                      'relative flex h-8 items-center gap-2.5 rounded-lg px-2.5 text-[12px] transition-colors',
                      isActive
                        ? 'bg-primary/[0.08] font-medium text-primary'
                        : 'text-muted-foreground hover:bg-muted/80 hover:text-foreground',
                      collapsed && 'justify-center px-0',
                    )
                  }
                >
                  <item.icon className="h-3.5 w-3.5 shrink-0" />
                  {collapsed ? null : item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </div>
        {collapsed ? null : (
          <div className="border-t border-sidebar-border px-3 py-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="flex h-auto w-full items-center justify-between rounded-md border bg-card px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setOpen(true)}
            >
              <span>命令面板</span>
              <kbd className="rounded border px-1 text-[10px]">⌘K / Ctrl K</kbd>
            </Button>
          </div>
        )}
      </aside>
      <main id="main-content" className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <header className="sticky top-0 z-10 flex h-[60px] shrink-0 items-center justify-between border-b bg-background/95 px-6 backdrop-blur">
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="icon" aria-label={collapsed ? '展开侧栏' : '折叠侧栏'} onClick={toggleCollapsed}>
              <PanelLeft className="size-4" />
            </Button>
            <nav
              aria-label="面包屑"
              className="flex items-center gap-1.5 text-sm text-muted-foreground"
            >
              {crumb ? (
                <>
                  <span>{crumb.group}</span>
                  <span className="text-border" aria-hidden="true">
                    /
                  </span>
                  <span className="font-medium text-foreground">{crumb.label}</span>
                  {entityName ? (
                    <>
                      <span className="text-border" aria-hidden="true">
                        /
                      </span>
                      <span className="font-medium text-foreground">{entityName}</span>
                    </>
                  ) : null}
                </>
              ) : (
                <span>{brandName}</span>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-[260px] justify-start gap-2 text-muted-foreground"
              onClick={() => setOpen(true)}
            >
              <Search className="size-3.5" />
              搜索单据、客户、项目
              <kbd className="ml-auto rounded border px-1 text-[10px] text-muted-foreground">
                ⌘K
              </kbd>
            </Button>
            <Button type="button" size="sm" onClick={() => setOpen(true)}>
              <Plus className="size-3.5" />
              新建
            </Button>
            <ThemeToggle />
            <InboxBell />
            {userInfo?.user_id ? <UserDisplay value={[userInfo.user_id]} size="small" /> : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="退出登录"
              onClick={() => void logout()}
            >
              <LogOut className="size-4" />
            </Button>
          </div>
        </header>
        <RequireCapability>
          <Outlet />
        </RequireCapability>
      </main>
      <CommandMenu open={open} onOpenChange={setOpen} />
    </div>
    </TooltipProvider>
  );
}

const Layout = () => (
  <PageMetaProvider>
    <LayoutFrame />
  </PageMetaProvider>
);

export default Layout;




