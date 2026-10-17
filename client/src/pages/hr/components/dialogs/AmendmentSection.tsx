/**
 * 「补卡申请」表单区（页内表单，不是弹窗）
 *
 * §5.9（F8）：从 `AttendancePanel.tsx` 抽出的独立区块。
 *
 * ## 为什么它在 `dialogs/` 里却不是 `<Dialog>`
 *
 * 原始界面里补卡是**页内表单**（`<section>` 里直接渲染 `<Form>`），没有弹窗。
 * 但它的形态与另外三个弹窗完全同类：自持 `useForm`、自持提交处理、写成功后
 * 让父组件重取列表。本目录承载的正是这一批"表单 + 提交"组件，因此放在这里，
 * 而不是为了字面整齐把它硬塞进一个 `<Dialog>`（那会改变界面）。
 *
 * ⚠️ **行为零变更**：逐字搬运，只做了三件事 ——
 *   ① `operating` 由父组件共享状态改为本组件自持（同 `AttendanceDialog` 的说明）；
 *   ② 提交成功后的 `await reloadAmd()` 改为 `await onSaved()`；
 *   ③ 本组件**没有** `open` prop —— 原表单常驻页面，没有开合状态，不得凭空加一个。
 *   字段、文案、校验全部未动。
 *
 * ## 为什么表单里没有「员工」
 *
 * 补卡按当前登录账号绑定的员工落库（服务端 `createAmendment(dto, actor.userId)`），
 * `CreateAttendanceAmendmentDto` 里**没有** employeeId —— 表单上多一个员工下拉框
 * 会让人以为能给他人补卡。区块标题旁那句说明就是这件事的提示文案。
 */
import React, { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import DateField from '@client/src/components/erp/DateField';
import { Button } from '@client/src/components/ui/button';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@client/src/components/ui/form';
import { Input } from '@client/src/components/ui/input';
import { hrApi } from '@client/src/api';
import {
  AMENDMENT_FORM_DEFAULTS,
  amendmentSchema,
  type AmendmentFormData,
  type AmendmentFormInput,
} from '../attendance-panel-model';
import type { CreateAttendanceAmendmentDto } from '@shared/api.interface';

interface AmendmentSectionProps {
  onSaved: () => void | Promise<void>;
}

const AmendmentSection: React.FC<AmendmentSectionProps> = ({ onSaved }) => {
  const [operating, setOperating] = useState(false);

  const amendmentForm = useForm<
    AmendmentFormInput,
    unknown,
    AmendmentFormData
  >({
    resolver: zodResolver(amendmentSchema),
    defaultValues: AMENDMENT_FORM_DEFAULTS,
  });

  const onAmendmentSubmit = amendmentForm.handleSubmit(async (values) => {
    const dto: CreateAttendanceAmendmentDto = {
      workDate: values.workDate,
      reason: values.reason,
    };
    setOperating(true);
    try {
      await hrApi.createAttendanceAmendment(dto);
      toast.success('补卡申请已提交');
      amendmentForm.reset(AMENDMENT_FORM_DEFAULTS);
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '提交失败');
    } finally {
      setOperating(false);
    }
  });

  return (
    <Form {...amendmentForm}>
      <form
        onSubmit={onAmendmentSubmit}
        className="grid grid-cols-3 items-start gap-4"
      >
        <FormField
          control={amendmentForm.control}
          name="workDate"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                日期 <span aria-hidden="true" className="text-destructive">*</span>
              </FormLabel>
              <DateField value={field.value || null} onChange={field.onChange} />
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={amendmentForm.control}
          name="reason"
          render={({ field }) => (
            <FormItem>
              <FormLabel>
                补卡原因 <span aria-hidden="true" className="text-destructive">*</span>
              </FormLabel>
              <FormControl>
                <Input placeholder="如：忘打卡，实际出勤" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <div className="flex h-full items-end">
          <Button type="submit" disabled={operating}>
            提交补卡
          </Button>
        </div>
      </form>
    </Form>
  );
};

export default AmendmentSection;
