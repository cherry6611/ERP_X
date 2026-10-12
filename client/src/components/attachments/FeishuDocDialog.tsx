import React, { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Link2 } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';

interface FeishuDocDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (fileName: string, fileUrl: string) => Promise<void>;
}

export const FeishuDocDialog: React.FC<FeishuDocDialogProps> = ({
  open,
  onOpenChange,
  onSubmit,
}) => {
  const [fileName, setFileName] = useState('');
  const [fileUrl, setFileUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setFileName('');
    setFileUrl('');
  };

  const handleSubmit = async () => {
    const trimmedName = fileName.trim();
    const trimmedUrl = fileUrl.trim();
    if (trimmedName.length === 0) {
      toast.error('请填写文档名称');
      return;
    }
    if (!/^https:\/\//.test(trimmedUrl)) {
      toast.error('请填写以 https:// 开头的飞书云文档链接');
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(trimmedName, trimmedUrl);
      reset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '云文档链接登记失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>登记飞书云文档链接</DialogTitle>
          <DialogDescription>
            把飞书云文档/多维表格的分享链接挂到当前单据，审批通知会自动携带该链接。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <label className="block space-y-1">
            <span className="text-sm font-medium">文档名称</span>
            <Input
              value={fileName}
              onChange={(e) => setFileName(e.target.value)}
              placeholder="如：2026年10月项目周报"
            />
          </label>
          <label className="block space-y-1">
            <span className="text-sm font-medium">云文档链接</span>
            <Input
              value={fileUrl}
              onChange={(e) => setFileUrl(e.target.value)}
              placeholder="https://xxx.feishu.cn/docx/..."
            />
          </label>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            取消
          </Button>
          <Button onClick={() => void handleSubmit()} disabled={submitting}>
            {submitting ? (
              <Loader2 className="mr-1 h-4 w-4 animate-spin" />
            ) : (
              <Link2 className="mr-1 h-4 w-4" />
            )}
            {submitting ? '保存中...' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
