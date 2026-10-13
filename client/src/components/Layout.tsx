import { useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { ChevronDown, ChevronRight, PanelLeft } from 'lucide-react';
import { useAuth, useCurrentUserProfile } from '@client/src/platform/auth';
import { UserDisplay } from '@client/src/components/business-ui/user-display';
import { InboxBell } from '@client/src/components/InboxBell';
import { Button } from '@client/src/components/ui/button';
import { CommandMenu, useCommandMenu } from '@client/src/components/CommandMenu';
import { BRAND_ICON, NAV_GROUPS, matchNav } from '@client/src/components/nav';
import { PageMetaProvider, useEntityName } from '@client/src/components/page-meta';
import { cn } from '@client/src/lib/utils';

const NAV_GROUPS_COLLAPSED_KEY = 'erp-nav-groups-collapsed';

function readCollapsedGroups(): string[] {
  try {
    const raw = window.localStorage.getItem(NAV_GROUPS_COLLAPSED_KEY);
    if (!raw) return [];
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
  const { logout } = useAuth();
  const { open, setOpen } = useCommandMenu();
  const [collapsed, setCollapsed] = useState(() => window.localStorage.getItem('erp-sidebar-collapsed') === '1');
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(readCollapsedGroups);
  const BrandIcon = BRAND_ICON;

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

  return (
    <div className="flex h-screen w-screen bg-background">
      <aside className={cn('flex shrink-0 flex-col border-r bg-card', collapsed ? 'w-16' : 'w-56')}>
        <div className="flex h-14 items-center gap-2.5 border-b px-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <BrandIcon className="size-4" />
          </span>
          {collapsed ? null : (
            <div className="flex min-w-0 flex-col leading-tight">
              <span className="truncate text-sm font-semibold tracking-tight">晟笙 ERP</span>
              <span className="truncate text-[11px] text-muted-foreground">数据服务一体化</span>
            </div>
          )}
        </div>
        <nav className="flex flex-1 flex-col gap-5 overflow-y-auto px-2 py-4" aria-label="主导航">
          {NAV_GROUPS.map((group) => {
            // Icon-mode: ignore group collapse and show all item icons
            const groupCollapsed = !collapsed && collapsedGroups.includes(group.title);
            return (
              <div key={group.title} className="flex flex-col gap-1">
                {collapsed ? null : (
                  <button
                    type="button"
                    className="mb-1 flex w-full items-center gap-1 rounded-md px-2 py-0.5 text-left text-xs text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    aria-expanded={!groupCollapsed}
                    onClick={() => toggleGroup(group.title)}
                  >
                    {groupCollapsed ? (
                      <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
                    ) : (
                      <ChevronDown className="size-3 shrink-0" aria-hidden="true" />
                    )}
                    <span className="truncate">{group.title}</span>
                  </button>
                )}
                {groupCollapsed
                  ? null
                  : group.items.map((item) => (
                      <NavLink
                        key={item.path}
                        to={item.path}
                        end={item.path === '/'}
                        title={item.label}
                        className={({ isActive }) =>
                          cn(
                            'relative flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
                            isActive ? 'bg-primary/10 font-medium text-primary' : 'text-foreground/80 hover:bg-muted',
                            collapsed && 'justify-center',
                          )
                        }
                      >
                        {({ isActive }) => (
                          <>
                            {isActive ? (
                              <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
                            ) : null}
                            <item.icon className="h-4 w-4 shrink-0" />
                            {collapsed ? <span className="sr-only">{item.label}</span> : item.label}
                          </>
                        )}
                      </NavLink>
                    ))}
              </div>
            );
          })}
        </nav>
      </aside>
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center justify-between border-b bg-background/95 px-6 backdrop-blur">
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
                <span>晟笙 ERP</span>
              )}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
              搜索
              <kbd className="rounded border px-1 text-[10px] text-muted-foreground">Ctrl K</kbd>
            </Button>
            <InboxBell />
            {userInfo?.user_id ? <UserDisplay value={[userInfo.user_id]} size="small" /> : null}
            <Button type="button" variant="ghost" size="sm" onClick={() => void logout()}>
              退出
            </Button>
          </div>
        </header>
        <Outlet />
      </main>
      <CommandMenu open={open} onOpenChange={setOpen} />
    </div>
  );
}

const Layout = () => (
  <PageMetaProvider>
    <LayoutFrame />
  </PageMetaProvider>
);

export default Layout;
