import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getDataloom, getDefaultBucketId } from '@client/src/platform/storage';
import { logger } from '@client/src/platform/logger';
import { toast } from 'sonner';
import { CanRole } from '@client/src/platform/auth';
import {
  FileText,
  Link2,
  Loader2,
  Paperclip,
  Trash2,
  Upload,
} from 'lucide-react';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import { Badge } from '@client/src/components/ui/badge';
import { UserDisplay } from '@client/src/components/business-ui/user-display';
import {
  createAttachment,
  deleteAttachment,
  listAttachments,
  parseFeishuDocUrl,
} from '@client/src/api/attachments';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type {
  Attachment,
  AttachmentResourceType,
  ParsedFeishuDocLink,
} from '@shared/api.interface';
import { UniversalLink } from '@client/src/platform/UniversalLink';

export const MAX_ATTACHMENT_COUNT = 10;
export const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;

const DOC_TYPE_LABELS: Record<string, string> = {
  docx: '新版文档',
  doc: '旧版文档',
  sheet: '电子表格',
  bitable: '多维表格',
  wiki: '知识库',
  file: '云文件',
  mindnote: '思维笔记',
  slides: '幻灯片',
};

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
  const parseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [items, setItems] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [linkPanelOpen, setLinkPanelOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState('');
  const [parsed, setParsed] = useState<ParsedFeishuDocLink | null>(null);
  const [parsing, setParsing] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const [savingLink, setSavingLink] = useState(false);

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

  useEffect(() => {
    return () => {
      if (parseTimer.current) clearTimeout(parseTimer.current);
    };
  }, []);

  const runParse = async (url: string) => {
    const trimmed = url.trim();
    if (!trimmed) {
      setParsed(null);
      setParseError(null);
      return;
    }
    setParsing(true);
    setParseError(null);
    try {
      const result = await parseFeishuDocUrl(trimmed);
      setParsed(result);
      if (result.warning) toast.message(result.warning);
    } catch (err) {
      setParsed(null);
      setParseError(getApiErrorMessage(err, '飞书链接解析失败'));
    } finally {
      setParsing(false);
    }
  };

  const onLinkUrlChange = (value: string) => {
    setLinkUrl(value);
    setParsed(null);
    setParseError(null);
    if (parseTimer.current) clearTimeout(parseTimer.current);
    parseTimer.current = setTimeout(() => {
      void runParse(value);
    }, 450);
  };

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files: File[] = Array.from(e.target.files ?? []);
    if (inputRef.current) inputRef.current.value = '';
    if (files.length === 0) return;
    if (items.length + files.length > MAX_ATTACHMENT_COUNT) {
      toast.error(`每个单据最多 ${MAX_ATTACHMENT_COUNT} 个附件`);
      return;
    }
    const oversized = files.find((f) => f.size > MAX_ATTACHMENT_SIZE);
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
          sourceType: 'upload',
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

  const handleSaveFeishuLink = async () => {
    if (!parsed || savingLink) return;
    if (items.length >= MAX_ATTACHMENT_COUNT) {
      toast.error(`每个单据最多 ${MAX_ATTACHMENT_COUNT} 个附件`);
      return;
    }
    setSavingLink(true);
    try {
      await createAttachment({
        resourceType,
        resourceId,
        fileName: parsed.title,
        fileUrl: parsed.url,
        sourceType: 'feishu_doc',
        feishuToken: parsed.token,
        feishuDocType: parsed.docType,
        feishuUrl: parsed.url,
      });
      toast.success('云文档链接已登记');
      setLinkUrl('');
      setParsed(null);
      setParseError(null);
      setLinkPanelOpen(false);
      await fetchList();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '云文档链接登记失败'));
    } finally {
      setSavingLink(false);
    }
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
          onChange={(e) => void handleFiles(e)}
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
            {uploading ? '上传中...' : '本地上传'}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={items.length >= MAX_ATTACHMENT_COUNT}
            aria-label="粘贴飞书云文档链接"
            onClick={() => setLinkPanelOpen((v) => !v)}
          >
            <Link2 className="mr-1 h-4 w-4" />
            飞书链接
          </Button>
        </div>
      </div>

      {linkPanelOpen ? (
        <div className="space-y-3 rounded-md border bg-muted/30 p-3">
          <div className="space-y-1.5">
            <Label htmlFor="feishu-doc-url">飞书云文档链接</Label>
            <Input
              id="feishu-doc-url"
              placeholder="粘贴 https://xxx.feishu.cn/docx/... 或 /sheets/、/wiki/、/base/ 等"
              value={linkUrl}
              onChange={(e) => onLinkUrlChange(e.target.value)}
              onBlur={() => {
                if (linkUrl.trim() && !parsed && !parsing) {
                  void runParse(linkUrl);
                }
              }}
            />
            <p className="text-xs text-muted-foreground">
              支持文档、表格、多维表格、知识库、思维笔记、幻灯片、云文件等类型；粘贴后自动解析
            </p>
          </div>
          {parsing ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              正在解析链接…
            </div>
          ) : null}
          {parseError ? (
            <p className="text-sm text-destructive">{parseError}</p>
          ) : null}
          {parsed ? (
            <div className="space-y-2 rounded-md border bg-background p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">
                  {DOC_TYPE_LABELS[parsed.docType] ?? parsed.docType}
                </Badge>
                <span className="font-medium">{parsed.title}</span>
              </div>
              <p className="break-all text-xs text-muted-foreground">
                Token：{parsed.token}
              </p>
              <p className="break-all text-xs text-muted-foreground">
                {parsed.url}
              </p>
              {parsed.warning ? (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  {parsed.warning}
                </p>
              ) : null}
              <div className="flex justify-end gap-2 pt-1">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setLinkPanelOpen(false);
                    setLinkUrl('');
                    setParsed(null);
                    setParseError(null);
                  }}
                >
                  取消
                </Button>
                <Button
                  type="button"
                  size="sm"
                  disabled={savingLink}
                  onClick={() => void handleSaveFeishuLink()}
                >
                  {savingLink ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : null}
                  确认登记
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {loading ? (
        <div className="flex justify-center py-4">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : items.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          暂无附件，可本地上传
          {usageHint ?? '发票、合同扫描件等凭据文件'}
          或粘贴飞书云文档链接
        </p>
      ) : (
        <ul className="space-y-2" data-ai-section-type="card-list">
          {items.map((item) => {
            const openUrl = item.feishuUrl || item.fileUrl;
            return (
              <li
                key={item.id}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
              >
                <UniversalLink
                  to={openUrl}
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
                  {item.sourceType === 'feishu_doc' ? (
                    <Badge variant="outline" className="font-normal">
                      {DOC_TYPE_LABELS[item.feishuDocType ?? ''] ??
                        item.feishuDocType ??
                        '云文档'}
                    </Badge>
                  ) : (
                    formatFileSize(item.fileSize)
                  )}
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
            );
          })}
        </ul>
      )}
    </div>
  );
};
