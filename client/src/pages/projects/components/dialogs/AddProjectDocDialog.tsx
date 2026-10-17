/**
 * 「新增项目文档」弹窗（§5.9 / F8）。
 *
 * 从 `ProjectDocSection.tsx` 抽出的弹窗：五段 `FormField` / 文件选择块、
 * `handleSubmit` 与渲染都在本文件里，父组件保留 `docForm`、`selectedFile`、
 * `fileError` 三个 state（因为它们的清零触发点 `openDialog` 在父组件，见下）、
 * `dialogOpen` 这一个布尔 state，以及触发处理器 `openDialog`。
 *
 * ⚠️ **行为零变更**：JSX 是原块逐字搬运 —— 只做了三件事：
 *   ① 整体去掉一层缩进（2 个空格）；
 *   ② `dialogOpen` / `setDialogOpen` 改为 props `open` / `onOpenChange`
 *      （**只有** `onSubmit` 末尾与「取消」按钮两处写入点，逐字对应）；
 *   ③ 提交成功后的 `setDialogOpen(false)` → `await fetchList()` →
 *      `onChanged?.()` 三行改为 `onOpenChange(false)` → `await onCreated()`
 *      （父组件传进来的 `handleCreated` 就是那两行：先重取列表、再回调
 *      `onChanged` 联动顶部财务卡与 EVM）。
 *
 * ## 表单重置时机（刻意保持原样）
 *
 * 重置在**打开弹窗时**（`openDialog`：`docForm.reset()` →
 * `setSelectedFile(null)` → `setFileError(null)` → `setDialogOpen(true)`），
 * 触发点是父组件的「新增文档」按钮 —— 所以：
 *   · `docForm`、`selectedFile`、`fileError` **三个 state 都留在父组件**，
 *     本组件按"同名 props 下沉"接收（`form` / `selectedFile` /
 *     `setSelectedFile` / `fileError` / `setFileError`）；
 *   · 本组件**没有**用 `useEffect` 监听 `open` 去复现那次重置 —— 那会多出一次
 *     "关闭时也重置"的语义，属于行为变更；也因此**没有**新增任何重置。
 * 关闭弹窗**不**重置（原实现也不重置）：关掉再打开会保留上次输入 —— 但
 * 「新增文档」按钮走的是 `openDialog`，所以正常使用路径上看到的仍是清空后的表单。
 *
 * 提交路径上也不重置：校验失败、附件数超限、未选文件、上传失败都**提前 return**
 * 且不关弹窗、不清空已填内容（原实现如此）。
 *
 * ## 哪些 state 随弹窗走
 *
 * `submitting` 与 `fileInputRef` 是纯弹窗内部状态：`submitting` 在每个分支的
 * `finally` 里复位，`fileInputRef` 从不需要清零（`handleFilePicked` 里那句
 * `if (fileInputRef.current) fileInputRef.current.value = ''` 是清 DOM input 的
 * 值，不是清 ref）。它们的读写点原先全在弹窗 JSX 与提交处理器内，父组件从不读。
 *
 * ## 为什么本组件必须**无条件挂载**
 *
 * `fileInputRef` 与 `submitting` 的状态随本组件的生命周期存在，且父组件写成
 * `{dialogOpen && <AddProjectDocDialog … />}` 会在关闭时立刻卸载 Radix 内容
 * （跳过退场动画）。原实现的这些状态常驻在 Section 上，故保持常挂载 + `open` prop。
 *
 * ## 「每个项目最多 N 个附件」这句文案是**刻意**与 `AttachmentField` 不同的
 *
 * 服务端上限 `MAX_ATTACHMENTS_PER_RESOURCE = 10`
 * （`server/modules/attachment/attachment.service.ts`）与客户端
 * `MAX_ATTACHMENT_COUNT = 10` 一致，超限时服务端报的是「每个**单据**最多 10 个
 * 附件」，而本弹窗先说「每个**项目**最多 10 个附件」。两者措辞不同但数值一致、
 * 且都正确（项目文档确实是一类单据），故**逐字保留**，不做措辞统一 ——
 * 改文案属于用户可见字符串变更。
 */
import React, { useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Loader2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { getDataloom, getDefaultBucketId } from '@client/src/platform/storage';
import { logger } from '@client/src/platform/logger';
import {
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_SIZE,
  formatFileSize,
} from '@client/src/components/attachments/AttachmentField';
import { Button } from '@client/src/components/ui/button';
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
import { createAttachment } from '@client/src/api/attachments';
import type { Attachment } from '@shared/api.interface';
import {
  DOC_TYPES,
  getDocType,
  type DocFormData,
} from '../project-doc-model';

interface AddProjectDocDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  /** 当前文档列表：提交前用它做「附件数上限」与「链接已登记」两道校验 */
  items: Attachment[];
  /**
   * 「新增文档」表单实例。由父组件持有（原实现如此），因为**打开弹窗时**的重置
   * `docForm.reset()` 写在父组件的 `openDialog` 里 —— 下沉的是同一个实例，
   * 不是复制一份。
   */
  form: ReturnType<typeof useForm<DocFormData>>;
  /** 已选文件；`null` 表示未选择（父组件持有，打开弹窗时清空） */
  selectedFile: File | null;
  /** `setSelectedFile` 原样下沉（`handleFilePicked` 写入点） */
  setSelectedFile: React.Dispatch<React.SetStateAction<File | null>>;
  /** 文件级错误提示（父组件持有，打开弹窗时清空） */
  fileError: string | null;
  /** `setFileError` 原样下沉（`handleFilePicked` / `onSubmit` 写入点） */
  setFileError: React.Dispatch<React.SetStateAction<string | null>>;
  /** 写成功后调用：父组件的 `handleCreated`（重取列表 + `onChanged`） */
  onCreated: () => void | Promise<void>;
}

const AddProjectDocDialog: React.FC<AddProjectDocDialogProps> = ({
  open,
  onOpenChange,
  projectId,
  items,
  form,
  selectedFile,
  setSelectedFile,
  fileError,
  setFileError,
  onCreated,
}) => {
  const [submitting, setSubmitting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

    onOpenChange(false);
    await onCreated();
  });

  const mode = form.watch('mode');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
                onClick={() => onOpenChange(false)}
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
  );
};

export default AddProjectDocDialog;
