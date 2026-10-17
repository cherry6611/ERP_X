'use client';

import { useQuery, queryOptions, type QueryClient } from '@tanstack/react-query';

import { listChatsByIds, searchChats } from './service';

export const chatQueries = {
  all: () => ['chats'] as const,
  search: (query: string, pageSize: number = 100) =>
    queryOptions({
      queryKey: [...chatQueries.all(), 'search', query, pageSize],
      queryFn: () => searchChats({ query, pageSize }),
      staleTime: 1 * 60 * 1000,
      gcTime: 5 * 60 * 1000,
      enabled: query.length > 0,
    }),
  byIds: (chatIds: string[]) =>
    queryOptions({
      queryKey: [...chatQueries.all(), 'byIds', chatIds.join(',')],
      queryFn: () => listChatsByIds(chatIds),
      staleTime: 1 * 60 * 1000,
      gcTime: 5 * 60 * 1000,
      enabled: chatIds.length > 0,
    }),
};

/**
 * 批量获取群组信息的 hook。
 *
 * @deprecated 全仓**零调用方**（F5 复核证据：`useChatsByIds` 定义 1 处、引用 0 处）。
 * 保留导出是为了不破坏 `business-ui` 这一层可能的外部消费；新代码不要用 ——
 * 群组名解析请直接用 `useAsyncData` 或经 `user-select` 一类的聚合组件。
 * 若确认无外部消费，可整体删除本文件与 `chatQueries`。
 */
export function useChatsByIds(chatIds: string[]) {
  return useQuery(chatQueries.byIds(chatIds));
}

/**
 * 清除群组缓存。
 *
 * @deprecated 零调用方（随 `useChatsByIds` 一并成为死代码）。
 */
export function clearChatCache(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: chatQueries.all() });
}
