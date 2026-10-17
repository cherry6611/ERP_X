'use client';

import { useQuery, queryOptions, type QueryClient } from '@tanstack/react-query';

import { searchDepartments } from './service';

export const departmentQueries = {
  all: () => ['departments'] as const,
  search: (query: string, pageSize: number = 100) =>
    queryOptions({
      queryKey: [...departmentQueries.all(), 'search', query, pageSize],
      queryFn: () => searchDepartments({ query, pageSize }),
      staleTime: 1 * 60 * 1000,
      gcTime: 5 * 60 * 1000,
      enabled: query.length > 0,
    }),
};

export type UseSearchDepartmentsOptions = {
  query: string;
  pageSize?: number;
  enabled?: boolean;
};

/**
 * 搜索部门的 hook。
 *
 * @deprecated 全仓**零调用方**（F5 复核：定义 1 处、引用 0 处）。
 * 新代码不要用；若确认无外部消费可连同 `departmentQueries` 整体删除。
 */
export function useSearchDepartments(options: UseSearchDepartmentsOptions) {
  const { query, pageSize = 100, enabled = true } = options;

  return useQuery({
    ...departmentQueries.search(query, pageSize),
    enabled: enabled && query.length > 0,
  });
}

/**
 * 清除部门缓存。
 *
 * @deprecated 零调用方（随 `useSearchDepartments` 一并成为死代码）。
 */
export function clearDepartmentCache(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: departmentQueries.all() });
}
