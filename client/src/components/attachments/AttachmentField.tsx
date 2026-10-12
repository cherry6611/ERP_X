import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getDataloom } from '@client/src/platform/storage';
import { getDefaultBucketId } from '@client/src/platform/storage';
import { logger } from '@client/src/platform/logger';
import { toast } from 'sonner';
import { CanRole } from '@client/src/platform/auth';
import { FileText, Link2, Loader2, Paperclip, Trash2, Upload } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';
import { UserDisplay } from '@client/src/components/business-ui/user-display';
import { FeishuDocDialog } from '@client/src/components/attachments/FeishuDocDialog';
import {
  createAttachment,
  deleteAttachment,
  listAttachments,
} from '@client/src/api/attachments';
import type { Attachment, AttachmentResourceType } from '@shared/api.interface';
import { UniversalLink } from '@client/src/platform/UniversalLink';

export const MAX_ATTACHMENT_COUNT = 10;
export const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;

export const formatFileSize = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
};

interface AttachmentFieldProps {
  resourceType: AttachmentResourceType;
  resourceId: string;
  usageHint?: string;
}

export const AttachmentField: React.FC<AttachmentFieldProps> = ({
  resourceType,
  resourceId,
  usageHint,
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [docDialogOpen, setDocDialogOpen] = useState(false);

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

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files: File[] = Array.from(e.target.files ?? []);
    if (inputRef.current) inputRef.current.value = '';
    if (files.length === 0) return;
    if (items.length + files.length > MAX_ATTACHMENT_COUNT) {
      toast.error(`每个单据最多 ${MAX_ATTACHMENT_COUNT} 个附件`);
      return;
    }
    const oversized: File | undefined = files.find(
      (f: File) => f.size > MAX_ATTACHMENT_SIZE,
    );
    if (oversized) {
      toast.error(`「${oversized.name}」超过 20MB 上限`);
      return;
    }
    setUploading(true);
    try {
      const dataloom = await getDataloom();
      const bucketId = getDefaultBucketId();
      for (const file of files) {
        const { data, error } = await dataloom.storage
          .from(bucketId)
          .uploadFile(file);
        if (error || !data) {
          throw new Error(
            `「${file.name}」上传失败: ${error?.message ?? '未知错误'}`,
          );
        }
        await createAttachment({
          resourceType,
          resourceId,
          fileName: file.name,
          fileUrl: data.download_url,
          fileSize: file.size,
        });
      }
      toast.success('附件上传成功');
      await fetchList();
    } catch (err) {
      logger.error('附件上传失败', err);
      toast.error(err instanceof Error ? err.message : '附件上传失败');
    } finally {
      setUploading(false);
    }
  };

  const handleAddDocLink = async (fileName: string, fileUrl: string) => {
    if (items.length >= MAX_ATTACHMENT_COUNT) {
      toast.error(`每个单据最多 ${MAX_ATTACHMENT_COUNT} 个附件`);
      return;
    }
    await createAttachment({
      resourceType,
      resourceId,
      fileName,
      fileUrl,
      sourceType: 'feishu_doc',
    });
    toast.success('云文档链接已登记');
    await fetchList();
  };

  const handleDelete = async (item: Attachment) => {
    setDeletingId(item.id);
    try {
      if (item.sourceType !== 'feishu_doc') {
        const dataloom = await getDataloom();
        await dataloom.storage.from(getDefaultBucketId()).remove([item.fileUrl]);
      }
      await deleteAttachment(item.id);
      toast.success('附件已删除');
      await fetchList();
    } catch (err) {
      logger.error('附件删除失败', err);
      toast.error('附件删除失败');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Paperclip className="h-4 w-4 text-muted-foreground" />
          附件（{items.length}/{MAX_ATTACHMENT_COUNT}）
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          onChange={handleFiles}
          className="hidden"
        />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={uploading || items.length >= MAX_ATTACHMENT_COUNT}
            onClick={() => inputRef.current?.click()}
          >
            {uploading ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-1 h-4 w-4" />
            )}
            {uploading ? '上传中...' : '上传附件'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={items.length >= MAX_ATTACHMENT_COUNT}
            aria-label="登记飞书云文档链接"
            onClick={() => setDocDialogOpen(true)}
          >
            <Link2 className="mr-1 h-4 w-4" />
            云文档链接
          </Button>
        </div>
      </div>
      <FeishuDocDialog
        open={docDialogOpen}
        onOpenChange={setDocDialogOpen}
        onSubmit={handleAddDocLink}
      />
      {loading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          暂无附件，可上传{usageHint ?? '发票、合同扫描件等凭据文件'}或登记飞书云文档链接
        </p>
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
                {item.sourceType === 'feishu_doc' ? (
                  <Link2 className="h-4 w-4 shrink-0 text-primary" />
                ) : (
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{item.fileName}</span>
              </UniversalLink>
              <span className="shrink-0 text-xs text-muted-foreground">
                {item.sourceType === 'feishu_doc'
                  ? '云文档'
                  : formatFileSize(item.fileSize)}
              </span>
              {item.uploadedBy ? (
                <UserDisplay userId={item.uploadedBy} size="small" />
              ) : null}
              {item.canDelete ? (
                <CanRole roles={['admin']}>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`删除附件 ${item.fileName}`}
                    disabled={deletingId === item.id}
                    onClick={() => void handleDelete(item)}
                  >
                    {deletingId === item.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4 text-destructive" />
                    )}
                  </Button>
                </CanRole>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
