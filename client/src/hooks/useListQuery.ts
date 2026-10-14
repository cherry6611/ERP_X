import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useDebouncedValue } from './useDebouncedValue';

export interface UseListQueryOptions {
  qKey?: string;
  pageKey?: string;
  debounceMs?: number;
  defaultPage?: number;
}

export interface UseListQueryResult {
  q: string;
  setQ: (value: string) => void;
  debouncedQ: string;
  page: number;
  setPage: (page: number) => void;
  debouncing: boolean;
  reset: () => void;
}

/**
 * P0：列表搜索防抖 300ms + URL 同步（?q=&page=）。
 */
export function useListQuery(
  options: UseListQueryOptions = {}
): UseListQueryResult {
  const {
    qKey = 'q',
    pageKey = 'page',
    debounceMs = 300,
    defaultPage = 1,
  } = options;
  const [params, setParams] = useSearchParams();
  const urlQ = params.get(qKey) ?? '';
  const urlPage = Number(params.get(pageKey) ?? defaultPage) || defaultPage;

  const [q, setQState] = useState(urlQ);
  const debouncedQ = useDebouncedValue(q, debounceMs);
  const debouncing = q !== debouncedQ;
  const lastSyncedQ = useRef(urlQ);

  // 浏览器后退时同步输入框
  useEffect(() => {
    if (urlQ !== lastSyncedQ.current) {
      lastSyncedQ.current = urlQ;
      setQState(urlQ);
    }
  }, [urlQ]);

  // 防抖后写回 URL；关键词变化时重置 page
  useEffect(() => {
    if (debouncedQ === lastSyncedQ.current && (params.get(qKey) ?? '') === debouncedQ) {
      return;
    }
    lastSyncedQ.current = debouncedQ;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        const prevQ = prev.get(qKey) ?? '';
        if (debouncedQ) next.set(qKey, debouncedQ);
        else next.delete(qKey);
        if (debouncedQ !== prevQ) next.delete(pageKey);
        return next;
      },
      { replace: true }
    );
  }, [debouncedQ, qKey, pageKey, setParams, params]);

  const setQ = useCallback((value: string) => {
    setQState(value);
  }, []);

  const setPage = useCallback(
    (page: number) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (page <= defaultPage) next.delete(pageKey);
          else next.set(pageKey, String(page));
          return next;
        },
        { replace: true }
      );
    },
    [defaultPage, pageKey, setParams]
  );

  const reset = useCallback(() => {
    setQState('');
    lastSyncedQ.current = '';
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(qKey);
        next.delete(pageKey);
        return next;
      },
      { replace: true }
    );
  }, [pageKey, qKey, setParams]);

  return useMemo(
    () => ({
      q,
      setQ,
      debouncedQ,
      page: urlPage,
      setPage,
      debouncing,
      reset,
    }),
    [q, setQ, debouncedQ, urlPage, setPage, debouncing, reset]
  );
}
