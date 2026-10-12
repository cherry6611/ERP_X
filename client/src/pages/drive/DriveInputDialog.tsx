import React, { useState } from 'react';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';

interface DriveInputDialogProps {
  open: boolean;
  title: string;
  label: string;
  defaultValue?: string;
  submitText?: string;
  submitting?: boolean;
  onCancel: () => void;
  onSubmit: (value: string) => void;
}

const DriveInputDialog: React.FC<DriveInputDialogProps> = ({
  open,
  title,
  label,
  defaultValue = '',
  submitText = '确定',
  submitting = false,
  onCancel,
  onSubmit,
}) => {
  const [value, setValue] = useState('');

  React.useEffect(() => {
    if (open) {
      setValue(defaultValue);
    }
  }, [open, defaultValue]);

  return (
    <Dialog open={open} onOpenChange={(next: boolean) => (next ? undefined : onCancel())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-2 py-2">
          <Label htmlFor="drive-dialog-input">{label}</Label>
          <Input
            id="drive-dialog-input"
            value={value}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setValue(e.target.value)}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={submitting}>
            取消
          </Button>
          <Button onClick={() => onSubmit(value.trim())} disabled={submitting || !value.trim()}>
            {submitting ? '提交中...' : submitText}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default DriveInputDialog;
