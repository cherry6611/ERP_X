import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import dayjs from 'dayjs';
import { toast } from 'sonner';
import { getDataloom } from '@client/src/platform/storage';
import { getDefaultBucketId } from '@client/src/platform/storage';
import { logger } from '@client/src/platform/logger';
import { CanRole } from '@client/src/platform/auth';
import { UniversalLink } from '@client/src/platform/UniversalLink';
import {
  CloudUpload,
  FileText,
  Link2,
  Loader2,
  Paperclip,
  Plus,
  Trash2,
  Upload,
} from 'lucide-react';
import { UserDisplay } from '@client/src/components/business-ui/user-display';
import {
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_SIZE,
  formatFileSize,
} from '@client/src/components/attachments/AttachmentField';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@client/src/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@client/src/components/ui/form';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@client/src/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import {
  createAttachment,
  deleteAttachment,
  listAttachments,
} from '@client/src/api/attachments';
import {
  getProjectDriveSyncStatus,
  syncProjectDrive,
} from '@client/src/api/projects';
import type {
  Attachment,
  DriveSyncStatusItem,
  ProjectDriveSyncStatus,
} from '@shared/api.interface';

/** 文档类型枚举：附件模型无类型字段，以标题前缀「[类型] 名称」承载 */
const DOC_TYPES = [
  { value: 'requirement', label: '需求书', variant: 'info' },
  { value: 'plan', label: '执行计划', variant: 'warning' },
  { value: 'solution', label: '方案文档', variant: 'secondary' },
  { value: 'acceptance', label: '验收报告', variant: 'success' },
  { value: 'other', label: '其他', variant: 'outline' },
] as const;

type DocTypeValue = (typeof DOC_TYPES)[number]['value'];

const DOC_TYPE_VALUES = DOC_TYPES.map((t) => t.value) as [
  DocTypeValue,
  ...DocTypeValue[],
];

const getDocType = (value: string): (typeof DOC_TYPES)[number] | undefined =>
  DOC_TYPES.find((t) => t.value === value);

const SYNC_STATUS_BADGES: Record<
  string,
  { label: string; variant: 'secondary' | 'success' | 'info' | 'destructive' }
> = {
  pending: { label: '待同步', variant: 'secondary' },
  synced: { label: '已同步', variant: 'success' },
  skipped: { label: '已跳过', variant: 'info' },
  failed: { label: '失败', variant: 'destructive' },
};

/** 从标题前缀解析文档类型，如「[需求书] 需求说明书」 */
const parseDocTypeLabel = (fileName: string): string | null => {
  const match = /^\[([^\]]+)\]/.exec(fileName);
  return match ? match[1] : null;
};

const docFormSchema = z
  .object({
    docType: z.enum(DOC_TYPE_VALUES, { message: '请选择文档类型' }),
    mode: z.enum(['upload', 'link']),
    docTitle: z.string(),
    docUrl: z.string(),
  })
  .superRefine((data, ctx) => {
    if (data.mode !== 'link') return;
    if (!data.docTitle.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['docTitle'],
        message: '请输入文档标题',
      });
    }
    if (!data.docUrl.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['docUrl'],
        message: '请输入飞书云文档链接',
      });
    } else if (!/^https?:\/\//.test(data.docUrl.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['docUrl'],
        message: '请输入有效的文档链接（http/https）',
      });
    }
  });

type DocFormData = z.infer<typeof docFormSchema>;

interface ProjectDocSectionProps {
  projectId: string;
  onChanged?: () => void;
}

const ProjectDocSection: React.FC<ProjectDocSectionProps> = ({
  projectId,
  onChanged,
}) => {
  const [items, setItems] = useState<Attachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<ProjectDriveSyncStatus | null>(
    null,
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  const form = useForm<DocFormData>({
    resolver: zodResolver(docFormSchema),
    defaultValues: {
      docType: 'requirement',
      mode: 'upload',
      docTitle: '',
      docUrl: '',
    },
  });

  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await listAttachments('erp_project', projectId));
    } catch (err) {
      logger.error('获取项目文档列表失败', err);
      toast.error('获取项目文档列表失败');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void fetchList();
  }, [fetchList]);

  const fetchSyncStatus = useCallback(async () => {
    try {
      setSyncStatus(await getProjectDriveSyncStatus(projectId));
    } catch (err) {
      logger.error('获取云空间同步状态失败', err);
      toast.error('获取云空间同步状态失败');
    }
  }, [projectId]);

  useEffect(() => {
    void fetchSyncStatus();
  }, [fetchSyncStatus]);

  const syncStatusMap = useMemo(() => {
    const map = new Map<string, DriveSyncStatusItem>();
    for (const item of syncStatus?.items ?? []) {
      map.set(item.attachmentId, item);
    }
    return map;
  }, [syncStatus]);

  const handleSyncDrive = async () => {
    setSyncing(true);
    try {
      const result = await syncProjectDrive(projectId);
      toast.success(
        `已同步 ${result.syncedFiles} 个文件，跳过 ${result.skippedFiles} 个，失败 ${result.failedFiles} 个`,
      );
      if (result.wikiPermissionDenied) {
        toast.warning('知识库未授权，归档文档暂在云空间项目目录中');
      }
      await fetchSyncStatus();
    } catch (err) {
      logger.error('同步到云空间失败', err);
      toast.error(err instanceof Error ? err.message : '同步到云空间失败');
    } finally {
      setSyncing(false);
    }
  };

  const openDialog = () => {
    form.reset();
    setSelectedFile(null);
    setFileError(null);
    setDialogOpen(true);
  };

  const handleFilePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files: File[] = Array.from(e.target.files ?? []);
    if (fileInputRef.current) fileInputRef.current.value = '';
    setSelectedFile(files[0] ?? null);
    setFileError(null);
  };

  const onSubmit = form.handleSubmit(async (data: DocFormData) => {
    if (items.length >= MAX_ATTACHMENT_COUNT) {
      toast.error(`每个项目最多 ${MAX_ATTACHMENT_COUNT} 个附件`);
      return;
    }
    const typeLabel = getDocType(data.docType)?.label ?? '其他';

    if (data.mode === 'upload') {
      if (!selectedFile) {
        setFileError('请选择要上传的文件');
        return;
      }
      if (selectedFile.size > MAX_ATTACHMENT_SIZE) {
        setFileError(`「${selectedFile.name}」超过 20MB 上限`);
        return;
      }
      setSubmitting(true);
      try {
        const dataloom = await getDataloom();
        const bucketId = getDefaultBucketId();
        const { data: uploaded, error } = await dataloom.storage
          .from(bucketId)
          .uploadFile(selectedFile);
        if (error || !uploaded) {
          throw new Error(
            `「${selectedFile.name}」上传失败: ${error?.message ?? '未知错误'}`,
          );
        }
        await createAttachment({
          resourceType: 'erp_project',
          resourceId: projectId,
          fileName: `[${typeLabel}] ${selectedFile.name}`,
          fileUrl: uploaded.download_url,
          fileSize: selectedFile.size,
        });
        toast.success('文档上传成功');
      } catch (err) {
        logger.error('项目文档上传失败', err);
        toast.error(err instanceof Error ? err.message : '文档上传失败');
        return;
      } finally {
        setSubmitting(false);
      }
    } else {
      const title = data.docTitle.trim();
      const url = data.docUrl.trim();
      if (items.some((item: Attachment) => item.fileUrl === url)) {
        toast.error('该云文档链接已登记');
        return;
      }
      setSubmitting(true);
      try {
        await createAttachment({
          resourceType: 'erp_project',
          resourceId: projectId,
          fileName: `[${typeLabel}] ${title}`,
          fileUrl: url,
          sourceType: 'feishu_doc',
        });
        toast.success('云文档链接已登记');
      } catch (err) {
        logger.error('云文档链接登记失败', err);
        toast.error(err instanceof Error ? err.message : '云文档链接登记失败');
        return;
      } finally {
        setSubmitting(false);
      }
    }

    setDialogOpen(false);
    await fetchList();
    onChanged?.();
  });

  const handleDelete = async (item: Attachment) => {
    setDeletingId(item.id);
    try {
      if (item.sourceType !== 'feishu_doc') {
        const dataloom = await getDataloom();
        await dataloom.storage.from(getDefaultBucketId()).remove([item.fileUrl]);
      }
      await deleteAttachment(item.id);
      toast.success('文档已删除');
      await fetchList();
      onChanged?.();
    } catch (err) {
      logger.error('项目文档删除失败', err);
      toast.error(err instanceof Error ? err.message : '文档删除失败');
    } finally {
      setDeletingId(null);
    }
  };

  const mode = form.watch('mode');

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Paperclip className="h-4 w-4 text-muted-foreground" />
          项目文档与资料（{items.length}/{MAX_ATTACHMENT_COUNT}）
        </CardTitle>
        <div className="flex items-center gap-2">
          <CanRole roles={['admin']}>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={syncing}
              onClick={() => void handleSyncDrive()}
            >
              {syncing ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <CloudUpload className="mr-1 h-4 w-4" />
              )}
              {syncing ? '同步中...' : '同步到云空间'}
            </Button>
          </CanRole>
          <Button type="button" size="sm" onClick={openDialog}>
            <Plus className="mr-1 h-4 w-4" />
            新增文档
          </Button>
        </div>
      </CardHeader>
      <CardContent>
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
                      onClick={() => void handleDelete(item)}
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
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>新增项目文档</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <FormField
                control={form.control}
                name="docType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      文档类型{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择文档类型" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {DOC_TYPES.map((t) => (
                          <SelectItem key={t.value} value={t.value}>
                            {t.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="mode"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      录入方式{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <FormControl>
                      <RadioGroup
                        onValueChange={field.onChange}
                        value={field.value}
                        className="flex gap-6"
                      >
                        <div className="flex items-center gap-2">
                          <RadioGroupItem value="upload" id="doc-mode-upload" />
                          <Label htmlFor="doc-mode-upload">上传文件</Label>
                        </div>
                        <div className="flex items-center gap-2">
                          <RadioGroupItem value="link" id="doc-mode-link" />
                          <Label htmlFor="doc-mode-link">飞书云文档链接</Label>
                        </div>
                      </RadioGroup>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {mode === 'upload' ? (
                <div className="space-y-2">
                  <Label htmlFor="doc-file-picker">选择文件</Label>
                  <input
                    ref={fileInputRef}
                    id="doc-file-picker"
                    type="file"
                    onChange={handleFilePicked}
                    className="hidden"
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => fileInputRef.current?.click()}
                    >
                      <Upload className="mr-1 h-4 w-4" />
                      选择文件
                    </Button>
                    {selectedFile ? (
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {selectedFile.name}（{formatFileSize(selectedFile.size)}）
                      </span>
                    ) : (
                      <span className="flex-1 text-sm text-muted-foreground">
                        未选择文件，单文件不超过 20MB
                      </span>
                    )}
                  </div>
                  {fileError ? (
                    <p className="text-sm text-destructive">{fileError}</p>
                  ) : null}
                </div>
              ) : (
                <>
                  <FormField
                    control={form.control}
                    name="docTitle"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          文档标题{' '}
                          <span aria-hidden="true" className="text-destructive">
                            *
                          </span>
                        </FormLabel>
                        <FormControl>
                          <Input placeholder="如：需求说明书" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="docUrl"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>
                          飞书云文档链接{' '}
                          <span aria-hidden="true" className="text-destructive">
                            *
                          </span>
                        </FormLabel>
                        <FormControl>
                          <Input placeholder="https://xxx.feishu.cn/docx/..." {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </>
              )}

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDialogOpen(false)}
                  disabled={submitting}
                >
                  取消
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : null}
                  {submitting ? '提交中...' : '确认新增'}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </Card>
  );
};

export default ProjectDocSection;
