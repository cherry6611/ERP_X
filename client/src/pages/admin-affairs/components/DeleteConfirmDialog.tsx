import React from 'react';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';

interface DeleteConfirmDialogProps {
  open: boolean;
  code: string | null;
  operating: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}

const DeleteConfirmDialog: React.FC<DeleteConfirmDialogProps> = ({
  open,
  code,
  operating,
  onConfirm,
  onOpenChange,
}) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>确认删除</DialogTitle>
        <DialogDescription>
          删除后不可恢复，确认删除{code ? `「${code}」` : '该记录'}吗？
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button
          variant="destructive"
          onClick={onConfirm}
          disabled={operating}
          aria-label="确认删除"
        >
          {operating ? '删除中…' : '删除'}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
);

export default DeleteConfirmDialog;
