import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Building2,
  FileSignature,
  FolderKanban,
  LogOut,
  Plus,
  RefreshCw,
} from 'lucide-react';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@client/src/components/ui/command';
import { NAV_GROUPS } from '@client/src/components/nav';
import { contractsApi, masterDataApi, projectsApi } from '@client/src/api';
import { useAuth } from '@client/src/platform/auth';
import type { Contract, Customer, Project } from '@shared/api.interface';

const RECENT_KEY = 'erp-cmdk-recent';
const RECENT_MAX = 8;

type RecentVisit = { path: string; label: string };

function readRecent(): RecentVisit[] {
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as RecentVisit[];
    return Array.isArray(parsed) ? parsed.slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

function pushRecent(item: RecentVisit) {
  try {
    const prev = readRecent().filter((r) => r.path !== item.path);
    const next = [item, ...prev].slice(0, RECENT_MAX);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota / private mode */
  }
}

export function CommandMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const { logout, hasCapability } = useAuth();
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<RecentVisit[]>([]);
  const [contracts, setContracts] = useState<Contract[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);

  useEffect(() => {
    if (open) setRecent(readRecent());
    else {
      setQuery('');
      setContracts([]);
      setProjects([]);
      setCustomers([]);
    }
  }, [open]);

  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setContracts([]);
      setProjects([]);
      setCustomers([]);
      return;
    }
    const keyword = query.trim();
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void Promise.all([
        contractsApi.listContracts({ keyword }).catch(() => [] as Contract[]),
        projectsApi.listProjects({ keyword }).catch(() => [] as Project[]),
        masterDataApi.listCustomers(keyword).catch(() => [] as Customer[]),
      ]).then(([c, p, cust]) => {
        if (cancelled) return;
        setContracts(c.slice(0, 5));
        setProjects(p.slice(0, 5));
        setCustomers(cust.slice(0, 5));
      });
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, query]);

  const go = useCallback(
    (path: string, label: string) => {
      pushRecent({ path, label });
      navigate(path);
      onOpenChange(false);
    },
    [navigate, onOpenChange],
  );

  const hasEntities =
    contracts.length > 0 || projects.length > 0 || customers.length > 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="命令面板"
      description="跳转页面、快捷操作"
    >
      <CommandInput
        placeholder="搜索页面、实体或操作…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>没有匹配结果</CommandEmpty>
        {recent.length > 0 ? (
          <>
            <CommandGroup heading="近期访问">
              {recent.map((item) => (
                <CommandItem
                  key={`recent-${item.path}`}
                  value={`近期 ${item.label} ${item.path}`}
                  onSelect={() => go(item.path, item.label)}
                >
                  {item.label}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        ) : null}
        {hasEntities ? (
          <>
            <CommandGroup heading="实体跳转">
              {contracts.map((c) => (
                <CommandItem
                  key={`contract-${c.id}`}
                  value={`合同 ${c.code} ${c.name}`}
                  onSelect={() => go('/contracts', `合同 ${c.code}`)}
                >
                  <FileSignature className="size-4" />
                  {c.code} · {c.name}
                </CommandItem>
              ))}
              {projects.map((p) => (
                <CommandItem
                  key={`project-${p.id}`}
                  value={`项目 ${p.code} ${p.name}`}
                  onSelect={() => go(`/projects/${p.id}`, `项目 ${p.name}`)}
                >
                  <FolderKanban className="size-4" />
                  {p.code} · {p.name}
                </CommandItem>
              ))}
              {customers.map((c) => (
                <CommandItem
                  key={`customer-${c.id}`}
                  value={`客户 ${c.code} ${c.name}`}
                  onSelect={() => go('/customers', `客户 ${c.name}`)}
                >
                  <Building2 className="size-4" />
                  {c.code} · {c.name}
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandSeparator />
          </>
        ) : null}
        <CommandGroup heading="快捷操作">
          <CommandItem
            value="新建合同"
            onSelect={() => go('/contracts', '合同管理')}
          >
            <Plus className="size-4" />
            新建合同
          </CommandItem>
          <CommandItem
            value="刷新页面"
            onSelect={() => {
              window.location.reload();
            }}
          >
            <RefreshCw className="size-4" />
            刷新页面
          </CommandItem>
          <CommandItem
            value="退出登录"
            onSelect={() => {
              void logout();
              onOpenChange(false);
            }}
          >
            <LogOut className="size-4" />
            退出登录
          </CommandItem>
        </CommandGroup>
        <CommandSeparator />
        {NAV_GROUPS.map((group) => {
          const items = group.items.filter(
            (item) => !item.capability || hasCapability(item.capability),
          );
          if (items.length === 0) return null;
          return (
            <CommandGroup key={group.title} heading={group.title}>
              {items.map((item) => (
                <CommandItem
                  key={item.path}
                  value={`${group.title} ${item.label}`}
                  onSelect={() => go(item.path, item.label)}
                >
                  <item.icon className="size-4" />
                  {item.label}
                </CommandItem>
              ))}
            </CommandGroup>
          );
        })}
      </CommandList>
    </CommandDialog>
  );
}

export function useCommandMenu(): {
  open: boolean;
  setOpen: (open: boolean) => void;
} {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return { open, setOpen };
}
