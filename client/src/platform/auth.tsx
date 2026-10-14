import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  hasCapability as rbacHasCapability,
  hasWriteCapability as rbacHasWriteCapability,
  type Capability,
} from '@shared/rbac';
import { withBasePath } from '@client/src/utils/base-path';

export interface AuthUser {
  userId: string;
  userName: string;
  roles: string[];
  capabilities?: string[];
  email?: string | null;
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  /** B-01：能力码收窄为 Capability，拼错时在编译期失败（读语义： 或 w 均通过） */
  hasCapability: (capability: Capability) => boolean;
  /** B-01：写语义（矩阵中必须是 w）。写操作按钮必须用这个判定，否则只读角色会看到写按钮 */
  hasWriteCapability: (capability: Capability) => boolean;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  refresh: async () => undefined,
  logout: async () => undefined,
  hasCapability: () => false,
  hasWriteCapability: () => false,
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    const resp = await fetch('/api/auth/me', { credentials: 'include' });
    if (!resp.ok) {
      setUser(null);
      return;
    }
    const body = (await resp.json()) as { user?: AuthUser | null };
    setUser(body.user ?? null);
  };

  useEffect(() => {
    void refresh().finally(() => setLoading(false));
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      refresh,
      // B-01：能力码参数**收窄为 `Capability`**（原为 `Capability | string`）。
      //
      // 为什么必须收窄：`| string` 让联合类型退化为 `string`，于是
      // `<CanCapability capability="finance_wirte">`（拼错）能通过 typecheck。
      // 而拼错的能力码**不会报错、不会告警**，只会让该元素永远渲染 fallback
      // —— 按钮永久消失，界面看上去只是"我这次没权限"。这是最难发现的一类缺陷。
      //
      // 收窄后拼错的能力码在**编译期**即失败，
      // 且 `rbacHasCapability(user.roles, capability)` 不再需要 `as Capability` 断言
      // （那个断言原本正是在掩盖类型被放宽这件事）。
      //
      // 运行时仍有 `check:rbac:frontend` 兜底（它用 shared/rbac.ts 的清单核对），
      // 因为后端返回的 `user.capabilities` 是裸字符串数组，绕不过类型。
      hasCapability: (capability: Capability) => {
        if (!user) return false;
        // 注意：不再优先读 `user.capabilities`。
        // 该数组由后端 `listCapabilities(roles)` 生成，而 `listCapabilities` 正是
        // 遍历同一份 MATRIX 得出的 —— 即两者**必然一致**，多这一层只会引入
        // "角色已变更但前端还拿着旧数组"的过期风险。权限判定统一走 MATRIX。
        return rbacHasCapability(user.roles, capability);
      },
      hasWriteCapability: (capability: Capability) => {
        if (!user) return false;
        return rbacHasWriteCapability(user.roles, capability);
      },
      logout: async () => {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
        setUser(null);
        window.location.assign(withBasePath('/login'));
      },
    }),
    [user, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

/**
 * 按角色码显隐。`roles` 与后端 `@CanRole([...])` / `FinanceRead` 等一致，
 * 例如财务只读页可传 `['admin', 'finance_viewer']`；写操作仍用 `['admin']`。
 */
export function CanRole({
  children,
  roles,
  fallback = null,
}: {
  children: ReactNode;
  roles: string[];
  fallback?: ReactNode;
}) {
  const { user, loading } = useAuth();
  if (loading) return null;
  const owned = user?.roles ?? [];
  if (roles.some((role) => owned.includes(role))) return children;
  return fallback;
}

/**
 * 按能力码显隐，**读语义**（矩阵中为 `r` 或 `rw` 均通过）。
 *
 * ⚠️ **写操作按钮请用 `CanCapabilityWrite`。**
 *
 * 两者的区别不是风格问题：`hasCapability` 对写能力码也可能返回 true ——
 * 例如 `tax_entity` / `pur_asset` 这类"读写同码"的能力（route-capability 中
 * `write: null`，矩阵里 `finance_viewer` 有 `r`），只读角色拿 `hasCapability`
 * 判写按钮会**看到点不动的按钮**（后端会拒）。实测这三个码存在此差异。
 */
export function CanCapability({
  children,
  capability,
  fallback = null,
}: {
  children: ReactNode;
  /** B-01：Capability（**不是** Capability | string）—— 拼错的能力码不会报错，| string 会让它静默隐藏元素 */
  capability: Capability;
  fallback?: ReactNode;
}) {
  const { loading, hasCapability } = useAuth();
  if (loading) return null;
  if (hasCapability(capability)) return children;
  return fallback;
}

/**
 * 按能力码显隐，**写语义**（矩阵中必须是 `rw`）。
 *
 * 所有写操作入口（新增/编辑/审批/作废/过账…）都必须用这个，
 * 与后端 `@CanCapability` 的判定口径一致（后端写接口要求 `rw`）。
 * 用 `CanCapability` 判写按钮的后果：只读角色会看到按钮，点下去被后端拒绝。
 */
export function CanCapabilityWrite({
  children,
  capability,
  fallback = null,
}: {
  children: ReactNode;
  capability: Capability;
  fallback?: ReactNode;
}) {
  const { loading, hasWriteCapability } = useAuth();
  if (loading) return null;
  if (hasWriteCapability(capability)) return children;
  return fallback;
}

export function useCurrentUserProfile(): { user_id?: string; name?: string } | null {
  const { user } = useAuth();
  if (!user) return null;
  return { user_id: user.userId, name: user.userName };
}
