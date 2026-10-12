import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export interface AuthUser {
  userId: string;
  userName: string;
  roles: string[];
  email?: string | null;
}

interface AuthState {
  user: AuthUser | null;
  loading: boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  loading: true,
  refresh: async () => undefined,
  logout: async () => undefined,
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
      logout: async () => {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
        setUser(null);
        window.location.assign('/login');
      },
    }),
    [user, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  return useContext(AuthContext);
}

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

export function useCurrentUserProfile(): { user_id?: string; name?: string } | null {
  const { user } = useAuth();
  if (!user) return null;
  return { user_id: user.userId, name: user.userName };
}
