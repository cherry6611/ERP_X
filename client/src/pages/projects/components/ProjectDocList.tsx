/**
 * 项目文档**列表区**（§5.9 / F8）。
 *
 * 从 `ProjectDocSection.tsx` 的 `<CardContent>` 原样搬来的两段 JSX：文档列表
 * （加载态 / 空态 / `data-ai-section-type="card-list"` 的每条文档行）与云空间
 * 同步状态页脚。删除链路（`handleDelete`：确认弹窗 → 兼容清理云空间文件 →
 * 删除 → 重取 → `onChanged`）**留在父组件**，因为 `items` 与 `deletingId`
 * 的写入点都在那里；本组件只通过 `onDelete` prop 调用它。
 *
 * ⚠️ **行为零变更**：JSX 是原块逐字搬运，只做了两件事：
 *   ① 整体去掉一层缩进（2 个空格）；
 *   ② 原先直接闭包引用的父组件绑定改为 props：`items` / `loading` /
 *      `syncStatusMap` / `syncStatus` / `deletingId` / `onDelete` 全是**同名**
 *      传入（`deletingId` 与 `items` 的归属仍在父组件 —— 见下）。
 *
 * ## 哪些 state **刻意留在父组件**
 *
 * `items` 与 `deletingId` 都是父组件先有、本组件只是消费的值，所以按
 * 「同名 props 下沉」处理，**没有**为了"让子组件自包含"而把 setter 一起搬过来：
 *   · `items` 的写入点是父组件的 `fetchList()`，而 `<CardTitle>` 上的
 *     「项目文档与资料（{items.length}/{MAX_ATTACHMENT_COUNT}）」也要读它；
 *   · `deletingId` 在删除成功后由父组件的 `fetchList()` 同一批 flush 收尾。
 * 搬走它们会同时改动三处触发点，属于拆分之外的行为改动面。
 *
 * ## 重置语义
 *
 * 本组件没有任何表单，因此**不存在** reset-on-open / reset-after-write 的问题。
 * 唯一的"状态清零"是删除按钮上的 `disabled={deletingId === item.id}`
 * （逐字保留）与 `deletingId` 在 `finally` 里复位（在父组件 `handleDelete`）。
 *
 * ## 一处**刻意保留**的重复调用（不要在"顺手清理"时合并）
 *
 * 渲染标题时同一行文件名的前缀被解析了**两次**：选择分支里一次
 * （`const typeLabel = parseDocTypeLabel(item.fileName)`），`<UniversalLink>`
 * 的子表达式里又一次。原实现如此，两次调用的结果必然相同，合并不会改变渲染
 * 结果 —— 但那是行为改动面之外的重构，故逐字保留。
 */
import React from 'react';
import dayjs from 'dayjs';
import { FileText, Link2, Loader2, Trash2 } from 'lucide-react';
import { UniversalLink } from '@client/src/platform/UniversalLink';
import { UserDisplay } from '@client/src/components/business-ui/user-display';
import { formatFileSize } from '@client/src/components/attachments/AttachmentField';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import type {
  Attachment,
  DriveSyncStatusItem,
  ProjectDriveSyncStatus,
} from '@shared/api.interface';
import {
  DOC_TYPES,
  SYNC_STATUS_BADGES,
  parseDocTypeLabel,
} from './project-doc-model';

interface ProjectDocListProps {
  /** 文档列表（`listAttachments('erp_project', projectId)` 的结果，父组件持有） */
  items: Attachment[];
  loading: boolean;
  /** 附件 id → 云空间同步状态（父组件 `useMemo` 出的 Map，见该文件注释） */
  syncStatusMap: Map<string, DriveSyncStatusItem>;
  syncStatus: ProjectDriveSyncStatus | null;
  /** 正在删除的附件 id（父组件持有，删除完成后在 `finally` 复位） */
  deletingId: string | null;
  /** 删除单条文档（含确认弹窗、云空间文件清理、重取列表 —— 父组件传入） */
  onDelete: (item: Attachment) => void;
}

const ProjectDocList: React.FC<ProjectDocListProps> = ({
  items,
  loading,
  syncStatusMap,
  syncStatus,
  deletingId,
  onDelete,
}) => {
  return (
    <>
      {loading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          暂无文档，上传文件或登记飞书云文档链接
        </p>
      ) : (
        <ul className="space-y-2" data-ai-section-type="card-list">
          {items.map((item: Attachment) => {
            const typeLabel = parseDocTypeLabel(item.fileName);
            const docType = DOC_TYPES.find((t) => t.label === typeLabel);
            const syncItem = syncStatusMap.get(item.id);
            return (
              <li
                key={item.id}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  {item.sourceType === 'feishu_doc' ? (
                    <Link2 className="h-4 w-4 shrink-0 text-primary" />
                  ) : (
                    <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                  )}
                  {docType ? (
                    <Badge variant={docType.variant}>{docType.label}</Badge>
                  ) : (
                    <Badge variant="outline">未标记</Badge>
                  )}
                  <UniversalLink
                    to={item.fileUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="min-w-0 truncate text-sm hover:underline"
                  >
                    {parseDocTypeLabel(item.fileName)
                      ? item.fileName.slice(
                          item.fileName.indexOf(']') + 1,
                        ).trim()
                      : item.fileName}
                  </UniversalLink>
                </div>
                {syncItem ? (
                  <Badge
                    variant={
                      SYNC_STATUS_BADGES[syncItem.syncStatus]?.variant ??
                      'secondary'
                    }
                    className="shrink-0"
                    title={syncItem.remark ?? undefined}
                  >
                    {SYNC_STATUS_BADGES[syncItem.syncStatus]?.label ??
                      syncItem.syncStatus}
                  </Badge>
                ) : null}
                <span className="shrink-0 text-xs text-muted-foreground">
                  {item.sourceType === 'feishu_doc'
                    ? '云文档'
                    : formatFileSize(item.fileSize)}
                </span>
                {item.uploadedBy ? (
                  <UserDisplay userId={item.uploadedBy} size="small" />
                ) : null}
                <span className="shrink-0 text-xs text-muted-foreground">
                  {dayjs(item.createdAt).format('YYYY-MM-DD HH:mm')}
                </span>
                {item.canDelete ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`删除文档 ${item.fileName}`}
                    disabled={deletingId === item.id}
                    onClick={() => void onDelete(item)}
                  >
                    {deletingId === item.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4 text-destructive" />
                    )}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {syncStatus &&
      (syncStatus.lastSyncedAt || syncStatus.folderUrl ||
        syncStatus.items.length > 0) ? (
        <div className="mt-3 flex flex-wrap items-center gap-4 border-t pt-3 text-xs text-muted-foreground">
          {syncStatus.lastSyncedAt ? (
            <span>
              上次同步：
              {dayjs(syncStatus.lastSyncedAt).format('YYYY-MM-DD HH:mm')}
            </span>
          ) : null}
          {syncStatus.folderUrl ? (
            <UniversalLink
              to={syncStatus.folderUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2"
            >
              云空间项目目录
            </UniversalLink>
          ) : null}
        </div>
      ) : null}
    </>
  );
};

export default ProjectDocList;
