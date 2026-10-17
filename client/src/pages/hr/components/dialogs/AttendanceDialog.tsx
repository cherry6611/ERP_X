/**
 * 「登记考勤」弹窗
 *
 * §5.9（F8）：从 `AttendancePanel.tsx` 抽出的独立弹窗组件（原 `<Dialog open={attOpen}>` 块）。
 *
 * 抽出的理由：主文件原先同时承载「5 张表 + 4 个表单」，一个 `<Dialog>` 块里混着
 * `useForm` / 提交处理函数 / 14 行 JSX；抽出后每个弹窗自成一个文件，
 * "表单字段 → schema → DTO → 提交后动作"四件事就近可读。
 *
 * ⚠️ **行为零变更**：本组件是原块的逐字搬运，只做了三件事 ——
 *   ① `attOpen` / `setAttOpen` 改为 props（`open` / `onOpenChange`）；
 *   ② `operating` 由父组件共享状态改为本组件自持（见下）；
 *   ③ 提交成功后的 `await reloadAtt()` 改为 `await onSaved()`（父组件传 `reloadAtt`）。
 *   字段、文案、校验、`Select` 的取值与顺序全部未动。
 *
 * ## 为什么 `operating` 变成组件内状态（这是"零行为变更"的一部分，不是美化）
 *
 * 原实现的 `operating` 是**四个表单共用**的一个布尔值：任何一个在提交就把四处的
 * 提交按钮一起置灰。抽出后每个弹窗各持一个，同一时刻仍只有一个弹窗是打开的，
 * 因此可见行为完全一致；而共用状态正是"子组件必须回传 setter"的根源 ——
 * 按 `LedgersPage` 的拆分约定，子组件自持状态、父组件只给数据与回调。
 *
 * ## 没有搬运的 `employeeOptions`
 *
 * 父组件里那份 `employeeOptions`（`<SelectItem>` 列表）同时被**筛选区**使用，
 * 因此保留在父组件；本组件按 `employees` prop 自行生成同一份列表（内容逐字相同）。
 */
import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import DateField from '@client/src/components/erp/DateField';
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
import { ATTENDANCE_STATUS_LABELS } from '../HrStatusBadge';
import {
  ATTENDANCE_FORM_DEFAULTS,
  attendanceSchema,
  type AttendanceFormData,
  type AttendanceFormInput,
} from '../attendance-panel-model';
import type {
  AttendanceStatus,
  Employee,
  UpsertAttendanceDto,
} from '@shared/api.interface';

interface AttendanceDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employees: Employee[] | undefined;
  onSaved: () => void | Promise<void>;
}

const AttendanceDialog: React.FC<AttendanceDialogProps> = ({
  open,
  onOpenChange,
  employees,
  onSaved,
}) => {
  const [operating, setOperating] = useState(false);

  const attForm = useForm<AttendanceFormInput, unknown, AttendanceFormData>({
    resolver: zodResolver(attendanceSchema),
    defaultValues: ATTENDANCE_FORM_DEFAULTS,
  });

  const onAttSubmit = attForm.handleSubmit(async (values) => {
    const dto: UpsertAttendanceDto = {
      employeeId: values.employeeId,
      workDate: values.workDate,
      status: values.status as AttendanceStatus,
      remark: values.remark || undefined,
    };
    setOperating(true);
    try {
      await hrApi.createAttendance(dto);
      toast.success('考勤已登记');
      onOpenChange(false);
      attForm.reset(ATTENDANCE_FORM_DEFAULTS);
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '登记失败');
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
          <DialogTitle>登记考勤</DialogTitle>
        </DialogHeader>
        <Form {...attForm}>
          <form onSubmit={onAttSubmit} className="space-y-4">
            <FormField
              control={attForm.control}
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
                control={attForm.control}
                name="workDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      日期 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <DateField value={field.value || null} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={attForm.control}
                name="status"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      状态 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.entries(ATTENDANCE_STATUS_LABELS).map(([value, label]) => (
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
            </div>
            <FormField
              control={attForm.control}
              name="remark"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>备注</FormLabel>
                  <FormControl>
                    <Input placeholder="备注" {...field} />
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

export default AttendanceDialog;
