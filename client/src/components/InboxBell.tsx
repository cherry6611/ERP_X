import { useCallback, useState } from 'react';
import { Bell } from 'lucide-react';
import { toast } from 'sonner';
import { notificationsApi } from '@client/src/api';
import { Button } from '@client/src/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@client/src/components/ui/popover';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type { InboxMessage } from '@shared/api.interface';

/** B8：顶栏站内信收件箱 */
export function InboxBell() {
  const [open, setOpen] = useState(false);
  const { data, loading, reload } = useAsyncData(
    () => notificationsApi.listInbox(),
    []
  );
  const messages: InboxMessage[] = data?.items ?? [];
  const unread = messages.filter((m) => !m.readAt).length;

  const markRead = useCallback(
    async (id: string) => {
      try {
        await notificationsApi.markInboxRead(id);
        await reload();
      } catch (err) {
        toast.error(getApiErrorMessage(err, '标记已读失败'));
      }
    },
    [reload]
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="icon" aria-label="站内信">
          <span className="relative">
            <Bell className="size-4" />
            {unread > 0 ? (
              <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-0.5 text-[10px] text-destructive-foreground">
                {unread > 9 ? '9+' : unread}
              </span>
            ) : null}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="border-b px-3 py-2 text-sm font-medium">站内信</div>
        <div className="max-h-80 overflow-y-auto">
          {loading ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">加载中…</p>
          ) : messages.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-muted-foreground">暂无消息</p>
          ) : (
            messages.map((msg) => (
              <button
                key={msg.id}
                type="button"
                className="flex w-full flex-col gap-0.5 border-b px-3 py-2 text-left hover:bg-muted/60"
                onClick={() => {
                  if (!msg.readAt) void markRead(msg.id);
                }}
              >
                <span className="flex items-center gap-2 text-sm font-medium">
                  {!msg.readAt ? (
                    <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                  ) : null}
                  {msg.title}
                </span>
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {msg.content}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
