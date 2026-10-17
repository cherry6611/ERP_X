/**
 * 「请假额度设置」弹窗
 *
 * §5.9（F8）：从 `AttendancePanel.tsx` 抽出的独立弹窗组件（原 `<Dialog open={balanceOpen}>` 块）。
 *
 * ⚠️ **行为零变更**：逐字搬运，只做了三件事 ——
 *   ① `balanceOpen` / `setBalanceOpen` 改为 props；
 *   ② `operating` 由父组件共享状态改为本组件自持（同 `AttendanceDialog` 的说明）；
 *   ③ 提交成功后的 `await reloadBal()` 改为 `await onSaved()`。
 *   字段、文案、校验全部未动。
 *
 * ## `balanceYear` 为什么必须是 prop
 *
 * 本弹窗的默认值**不是常量**：`balanceFormDefaults(balanceYear)` 把年度预填成
 * 父组件顶部「年度」筛选框的当前值，`useForm({ defaultValues })` 与提交成功后的
 * `reset(...)` 两处都读它。抽出来后若在组件内自取，就会变成"读一个父组件看不见的
 * 值"，两边再也对不上 —— 因此按原样从父组件传入（父组件自己**不**读它做表单用途）。
 */
import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { hrApi } from '@client/src/api';
import { LEAVE_TYPE_LABELS } from '../HrStatusBadge';
import {
  balanceFormDefaults,
  balanceSchema,
  type BalanceFormData,
  type BalanceFormInput,
} from '../attendance-panel-model';
import type {
  Employee,
  LeaveType,
  SetLeaveBalanceDto,
} from '@shared/api.interface';

interface BalanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employees: Employee[] | undefined;
  /** 额度按 (员工, 假别, 年) 唯一：默认年度跟随面板上的年度筛选 */
  balanceYear: string;
  onSaved: () => void | Promise<void>;
}

const BalanceDialog: React.FC<BalanceDialogProps> = ({
  open,
  onOpenChange,
  employees,
  balanceYear,
  onSaved,
}) => {
  const [operating, setOperating] = useState(false);

  const balanceForm = useForm<BalanceFormInput, unknown, BalanceFormData>({
    resolver: zodResolver(balanceSchema),
    defaultValues: balanceFormDefaults(balanceYear),
  });

  const onBalanceSubmit = balanceForm.handleSubmit(async (values) => {
    const dto: SetLeaveBalanceDto = {
      employeeId: values.employeeId,
      leaveType: values.leaveType as LeaveType,
      year: values.year,
      totalDays: values.totalDays,
    };
    setOperating(true);
    try {
      await hrApi.setLeaveBalance(dto);
      toast.success('额度已设置');
      onOpenChange(false);
      balanceForm.reset(balanceFormDefaults(balanceYear));
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '设置失败');
    } finally {
      setOperating(false);
    }
  });

  const employeeOptions = (employees ?? []).map((e: Employee) => (
    <SelectItem key={e.id} value={e.id}>
      {e.name}
    </SelectItem>
  ));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>请假额度设置</DialogTitle>
        </DialogHeader>
        <Form {...balanceForm}>
          <form onSubmit={onBalanceSubmit} className="space-y-4">
            <FormField
              control={balanceForm.control}
              name="employeeId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    员工 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="请选择员工" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>{employeeOptions}</SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex gap-4">
              <FormField
                control={balanceForm.control}
                name="leaveType"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      假别 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.entries(LEAVE_TYPE_LABELS).map(([value, label]) => (
                          <SelectItem key={value} value={value}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={balanceForm.control}
                name="year"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      年度 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="如 2026" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={balanceForm.control}
              name="totalDays"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    总额度（天） <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={1}
                      value={String(field.value ?? '')}
                      onChange={field.onChange}
                      onBlur={field.onBlur}
                      name={field.name}
                      ref={field.ref}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button type="submit" disabled={operating}>
                保存
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default BalanceDialog;
