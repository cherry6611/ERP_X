import React, { useCallback, useEffect, useState } from 'react';
import { logger } from '@client/src/platform/logger';
import { toast } from 'sonner';
import { FileText, Loader2, Paperclip } from 'lucide-react';
import { UserDisplay } from '@client/src/components/business-ui/user-display';
import { listAttachments } from '@client/src/api/attachments';
import type { Attachment, AttachmentResourceType } from '@shared/api.interface';
import { formatFileSize } from '@client/src/components/attachments/AttachmentField';
import { UniversalLink } from '@client/src/platform/UniversalLink';

interface AttachmentListProps {
  resourceType: AttachmentResourceType;
  resourceId: string;
}

export const AttachmentList: React.FC<AttachmentListProps> = ({
  resourceType,
  resourceId,
}) => {
  const [items, setItems] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listAttachments(resourceType, resourceId));
    } catch (err) {
      logger.error('获取附件列表失败', err);
      toast.error('获取附件列表失败');
    } finally {
      setLoading(false);
    }
  }, [resourceType, resourceId]);

  useEffect(() => {
    void fetchList();
  }, [fetchList]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Paperclip className="h-4 w-4 text-muted-foreground" />
        附件（{items.length}）
      </div>
      {loading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">暂无附件</p>
      ) : (
        <ul className="space-y-2" data-ai-section-type="card-list">
          {items.map((item: Attachment) => (
            <li
              key={item.id}
              className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
            >
              <UniversalLink
                to={item.fileUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex min-w-0 flex-1 items-center gap-2 text-sm hover:underline"
              >
                <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{item.fileName}</span>
              </UniversalLink>
              <span className="shrink-0 text-xs text-muted-foreground">
                {formatFileSize(item.fileSize)}
              </span>
              {item.uploadedBy ? (
                <UserDisplay userId={item.uploadedBy} size="small" />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
