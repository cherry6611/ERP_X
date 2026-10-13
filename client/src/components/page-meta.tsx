import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

interface PageMetaValue {
  entityName: string | null;
  setEntityName: (name: string | null) => void;
}

const PageMetaContext = createContext<PageMetaValue>({
  entityName: null,
  setEntityName: () => undefined,
});

export function PageMetaProvider({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const [entityName, setEntityName] = useState<string | null>(null);
  useEffect(() => {
    setEntityName(null);
  }, [pathname]);
  const value = useMemo(() => ({ entityName, setEntityName }), [entityName]);
  return <PageMetaContext.Provider value={value}>{children}</PageMetaContext.Provider>;
}

export function usePageEntityName(name: string | null | undefined): void {
  const { setEntityName } = useContext(PageMetaContext);
  useEffect(() => {
    setEntityName(name ?? null);
    return () => setEntityName(null);
  }, [name, setEntityName]);
}

export function useEntityName(): string | null {
  return useContext(PageMetaContext).entityName;
}
