import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { Label } from '@client/src/components/ui/label';
import { Textarea } from '@client/src/components/ui/textarea';
import { adminApi } from '@client/src/api';
import type { AdminBillItem } from '@shared/api.interface';

interface RejectBillDialogProps {
  bill: AdminBillItem | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void | Promise<void>;
}

const RejectBillDialog: React.FC<RejectBillDialogProps> = ({
  bill,
  onOpenChange,
  onSuccess,
}) => {
  const open = bill !== null;
  const [remark, setRemark] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [operating, setOperating] = useState<boolean>(false);

  useEffect(() => {
    if (open) {
      setRemark('');
      setError(null);
    }
  }, [open]);

  const onConfirm = async () => {
    if (!bill) return;
    if (remark.trim().length === 0) {
      setError('请填写驳回原因');
      return;
    }
    setOperating(true);
    try {
      await adminApi.adminBillAction(bill.id, 'reject', {
        approveRemark: remark.trim(),
      });
      toast.success('已驳回');
      onOpenChange(false);
      await onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '驳回失败');
    } finally {
      setOperating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>驳回缴费单</DialogTitle>
          <DialogDescription>
            {bill ? `${bill.code} - ${bill.title}` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="bill-reject-remark">
            驳回原因{' '}
            <span aria-hidden="true" className="text-destructive">
              *
            </span>
          </Label>
          <Textarea
            id="bill-reject-remark"
            placeholder="请填写驳回原因"
            value={remark}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
              setRemark(e.target.value);
              setError(null);
            }}
          />
          {error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="destructive"
            onClick={() => void onConfirm()}
            disabled={operating}
          >
            {operating ? '提交中...' : '确认驳回'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default RejectBillDialog;
