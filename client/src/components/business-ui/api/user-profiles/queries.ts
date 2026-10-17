'use client';

import { useQuery, queryOptions, type QueryClient } from '@tanstack/react-query';

import { fetchUserProfile, type AccountType } from './service';

export const userProfileQueries = {
  all: () => ['userProfiles'] as const,
  byId: (userId: string, accountType: AccountType = 'apaas') =>
    queryOptions({
      queryKey: [...userProfileQueries.all(), 'byId', accountType, userId],
      queryFn: ({ signal }) => fetchUserProfile(userId, accountType, signal),
      staleTime: 1 * 60 * 1000,
      gcTime: 5 * 60 * 1000,
      enabled: !!userId,
    }),
};

export type UseUserProfileOptions = {
  userId: string;
  accountType?: AccountType;
  enabled?: boolean;
};

/**
 * 获取用户 Profile 卡片数据的 hook。
 *
 * @deprecated 全仓**零调用方**（F5 复核：定义 1 处、引用 0 处）。
 *
 * ⚠️ 不要与**在用的** `useUsersByIds`（`api/users/queries.ts`）混淆 ——
 * 后者服务于应用顶栏的 `<UserDisplay>`，是活代码，
 * 详见 `platform/AppContainer.tsx` 关于"审计建议删除 QueryClientProvider
 * 为何被否决"的完整论证。
 */
export function useUserProfile(options: UseUserProfileOptions) {
  const { userId, accountType = 'apaas', enabled = true } = options;

  return useQuery({
    ...userProfileQueries.byId(userId, accountType),
    enabled: enabled && !!userId,
  });
}

/**
 * 清除用户 Profile 缓存。
 *
 * @deprecated 零调用方（随 `useUserProfile` 一并成为死代码）。
 */
export function clearUserProfileCache(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: userProfileQueries.all() });
}
