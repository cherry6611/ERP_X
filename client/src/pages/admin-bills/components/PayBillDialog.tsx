import React, { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@client/src/components/ui/button';
import { Calendar } from '@client/src/components/ui/calendar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@client/src/components/ui/popover';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { adminApi } from '@client/src/api';
import { formatMoney, todayIso } from '@client/src/utils/format';
import type { AdminBillItem } from '@shared/api.interface';

const toLocalDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const PAY_METHOD_OPTIONS = [
  { value: 'bank_transfer', label: '银行转账' },
  { value: 'cash', label: '现金' },
  { value: 'other', label: '其他' },
];

interface PayBillDialogProps {
  bill: AdminBillItem | null;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void | Promise<void>;
}

const PayBillDialog: React.FC<PayBillDialogProps> = ({
  bill,
  onOpenChange,
  onSuccess,
}) => {
  const open = bill !== null;
  const [payDate, setPayDate] = useState<string>(todayIso());
  const [payMethod, setPayMethod] = useState<string>('bank_transfer');
  const [operating, setOperating] = useState<boolean>(false);

  useEffect(() => {
    if (open) {
      setPayDate(todayIso());
      setPayMethod('bank_transfer');
    }
  }, [open]);

  const onConfirm = async () => {
    if (!bill) return;
    setOperating(true);
    try {
      await adminApi.adminBillAction(bill.id, 'pay', {
        payDate,
        payMethod,
      });
      toast.success('付款已登记');
      onOpenChange(false);
      await onSuccess();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '登记付款失败');
    } finally {
      setOperating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>登记付款</DialogTitle>
          <DialogDescription>
            {bill ? `${bill.code} - ${bill.title}，金额 ${formatMoney(bill.amount)}` : ''}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bill-pay-date">付款日期</Label>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  id="bill-pay-date"
                  variant="outline"
                  type="button"
                  className="w-full justify-start font-normal"
                >
                  {payDate || '请选择日期'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={payDate ? new Date(`${payDate}T00:00:00`) : undefined}
                  onSelect={(date: Date | undefined) =>
                    setPayDate(date ? toLocalDate(date) : todayIso())
                  }
                />
              </PopoverContent>
            </Popover>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="bill-pay-method">付款方式</Label>
            <Select value={payMethod} onValueChange={setPayMethod}>
              <SelectTrigger id="bill-pay-method">
                <SelectValue placeholder="请选择付款方式" />
              </SelectTrigger>
              <SelectContent>
                {PAY_METHOD_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => void onConfirm()} disabled={operating}>
            {operating ? '提交中...' : '确认付款'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default PayBillDialog;
