import { useCallback, useState } from 'react';
import { Bell } from 'lucide-react';
import { toast } from 'sonner';
import { notificationsApi } from '@client/src/api';
import { DataState } from '@client/src/components/DataState';
import { Button } from '@client/src/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@client/src/components/ui/sheet';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type { InboxMessage } from '@shared/api.interface';

/** B8：顶栏站内信收件箱，使用右侧 Drawer 保留列表上下文。 */
export function InboxBell() {
  const [open, setOpen] = useState(false);
  const { data, loading, reload } = useAsyncData(
    () => notificationsApi.listInbox(),
    [],
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
    [reload],
  );

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
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
      </SheetTrigger>
      <SheetContent
        side="right"
        className="w-[420px] gap-0 bg-card p-0 sm:max-w-[420px]"
      >
        <SheetHeader className="h-14 flex-row items-center justify-between border-b border-border/80 px-5 py-0">
          <SheetTitle className="text-[14px]">站内信</SheetTitle>
          {unread > 0 ? (
            <span className="text-[11px] text-muted-foreground">
              {unread} 条未读
            </span>
          ) : null}
        </SheetHeader>
        <div className="flex-1 overflow-y-auto">
          {loading ? (
            <div className="px-4 py-4">
              <DataState loading skeleton="default" />
            </div>
          ) : messages.length === 0 ? (
            <p className="px-4 py-10 text-center text-[12px] text-muted-foreground">
              暂无消息
            </p>
          ) : (
            messages.map((msg) => (
              <button
                key={msg.id}
                type="button"
                className="flex w-full flex-col items-start gap-1 border-b border-border/60 px-5 py-3.5 text-left transition-colors hover:bg-muted/50"
                onClick={() => {
                  if (!msg.readAt) void markRead(msg.id);
                }}
              >
                <span className="flex items-center gap-2 text-[13px] font-medium">
                  {!msg.readAt ? (
                    <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                  ) : null}
                  {msg.title}
                </span>
                <span className="line-clamp-2 text-[11px] leading-5 text-muted-foreground">
                  {msg.content}
                </span>
              </button>
            ))
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
