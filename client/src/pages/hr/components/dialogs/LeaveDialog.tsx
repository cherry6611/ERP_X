/**
 * 「新建请假」弹窗
 *
 * §5.9（F8）：从 `AttendancePanel.tsx` 抽出的独立弹窗组件（原 `<Dialog open={leaveOpen}>` 块）。
 *
 * ⚠️ **行为零变更**：逐字搬运，只做了三件事 ——
 *   ① `leaveOpen` / `setLeaveOpen` 改为 props；
 *   ② `operating` 由父组件共享状态改为本组件自持（同 `AttendanceDialog` 的说明）；
 *   ③ 提交成功后的 `navigate(...)` + `await reloadLeave()` 中，前者留在本组件
 *      （它读的 `req.id` 只有本组件拿得到），后者改为 `await onSaved()`。
 *   字段、文案、校验、`AttachmentHint` 全部未动。
 *
 * ## 为什么 `navigate` 留在本组件
 *
 * 提交成功后要跳到 `/hr/leaves/${req.id}` 且把新建的单据塞进路由 state —— 这依赖
 * `hrApi.createLeaveRequest` 的**返回值**，而返回值只有提交方拿得到。若改成让父组件
 * 导航，父组件就必须再持有一次"刚创建的单据"，等于把状态又搬回去。
 */
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import DateField from '@client/src/components/erp/DateField';
import AttachmentHint from '@client/src/components/attachments/AttachmentHint';
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
import { sendApprovalNotification } from '@client/src/api/notifications';
import { LEAVE_TYPE_LABELS } from '../HrStatusBadge';
import {
  LEAVE_FORM_DEFAULTS,
  leaveSchema,
  type LeaveFormData,
  type LeaveFormInput,
} from '../attendance-panel-model';
import type {
  CreateLeaveRequestDto,
  Employee,
  LeaveType,
} from '@shared/api.interface';

interface LeaveDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employees: Employee[] | undefined;
  onSaved: () => void | Promise<void>;
}

const LeaveDialog: React.FC<LeaveDialogProps> = ({
  open,
  onOpenChange,
  employees,
  onSaved,
}) => {
  const navigate = useNavigate();
  const [operating, setOperating] = useState(false);

  const leaveForm = useForm<LeaveFormInput, unknown, LeaveFormData>({
    resolver: zodResolver(leaveSchema),
    defaultValues: LEAVE_FORM_DEFAULTS,
  });

  const onLeaveSubmit = leaveForm.handleSubmit(async (values) => {
    const dto: CreateLeaveRequestDto = {
      employeeId: values.employeeId,
      leaveType: values.leaveType as LeaveType,
      startDate: values.startDate,
      endDate: values.endDate,
      days: values.days,
      reason: values.reason || undefined,
    };
    setOperating(true);
    try {
      const req = await hrApi.createLeaveRequest(dto);
      void sendApprovalNotification({
        bizType: 'leave',
        bizCode: req.code,
        title: '请假审批待办',
        content: `${req.employeeName} 提交请假申请 ${req.code}（${LEAVE_TYPE_LABELS[req.leaveType] ?? req.leaveType}，${req.days} 天），请审批`,
      });
      toast.success('请假申请已提交');
      onOpenChange(false);
      navigate(`/hr/leaves/${req.id}`, { state: { item: req } });
      leaveForm.reset(LEAVE_FORM_DEFAULTS);
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '提交失败');
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
          <DialogTitle>新建请假</DialogTitle>
        </DialogHeader>
        <Form {...leaveForm}>
          <form onSubmit={onLeaveSubmit} className="space-y-4">
            <FormField
              control={leaveForm.control}
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
            <FormField
              control={leaveForm.control}
              name="leaveType"
              render={({ field }) => (
                <FormItem>
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
            <div className="flex gap-4">
              <FormField
                control={leaveForm.control}
                name="startDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      开始日期 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <DateField value={field.value || null} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={leaveForm.control}
                name="endDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      结束日期 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <DateField value={field.value || null} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={leaveForm.control}
              name="days"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    天数 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input
                      type="number"
                      min={0.5}
                      step={0.5}
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
            <FormField
              control={leaveForm.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>事由</FormLabel>
                  <FormControl>
                    <Input placeholder="请假事由" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <AttachmentHint text="保存后将自动打开详情，可在其中上传病假条、请假证明材料等附件" />
            <DialogFooter>
              <Button type="submit" disabled={operating}>
                提交
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default LeaveDialog;
