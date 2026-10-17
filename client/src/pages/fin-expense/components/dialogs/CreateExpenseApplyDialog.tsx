/**
 * 新增费用申请弹窗（§5.9 / F8）。
 *
 * 从 `ExpenseApplyPanel.tsx`（572 行）抽出的自包含弹窗，抽出后主文件降到
 * 500 行以内。表单 schema、默认值、`useForm`、提交处理与全部表单 JSX 原先
 * 都散在主文件里，抽出后与使用它们的 JSX 同处一文件。
 *
 * ## 行为零变更
 *
 * 被搬走的代码是**逐字搬运**（`git show HEAD:` 后按行号切块），只做了两件事：
 *   ① 整块 JSX 去掉一层缩进（统一 −2 空格）；
 *   ② 主文件里的 `form` / `onSubmit` / `operating` / 表单常量随 JSX 一起搬进来，
 *      跨文件用到的 6 个外部值改为 props。
 *
 * ## 为什么 props 用「同名」而不是回调
 *
 * `setCreateOpen` / `reload` / `navigate` 都按**原名**透传，而不是包装成
 * `onCreated={() => { await reload(); navigate(…); }}`：后者要**改写
 * `onSubmit` 的处理体**，而本次拆分的硬约束是处理体逐字不动。
 * 同名 props 只改「外层组件签名」，调用点一个字都不用动：
 *
 * ```tsx
 * setCreateOpen(false);                                  // 原样
 * await reload();                                        // 原样
 * navigate(`/fin-expense/applies/${created.id}`, …);      // 原样
 * ```
 *
 * ## ⚠️ 必须无条件挂载
 *
 * 父组件**不能**写成 `{createOpen && <CreateExpenseApplyDialog/>}`：`operating`
 * 与 `form` 原先在主文件里是常驻 state，条件挂载会在每次关闭时把它们丢掉，
 * 并改变 `Dialog` 的挂载时机。
 *
 * ## 表单重置时机（刻意保持原样）
 *
 * 重置点是**创建成功之后**（`toast.success` → `setCreateOpen(false)` →
 * `form.reset(EMPTY_FORM)` → `await reload()` → `navigate(…)`），
 * **不是**"打开弹窗时" —— 原实现没有 reset-on-open，这里也没有新增。
 * 顺序与触发点逐字保持；若把 reset 挪到 open 时机，重新打开会丢掉上次输入。
 *
 * ## 金额校验口径（已核对，未改动）
 *
 * `amount` 客户端是 `z.coerce.number().min(0)`，服务端 DTO 是
 * `@IsNumber() @Min(0)`（fin-expense.controller.ts），两侧都允许 0；
 * 而 service `createApply` 另有前置校验 —— `dto.amount > 0` 不成立即
 * 以「费用申请金额必须大于 0」拒绝。即 **0 能过前端与 DTO、被 service 拒绝**
 * （用户会看到 toast 报错，不是静默写坏）。
 * 属前后端校验口径不一致，非本次拆分范围，保持原样未动。
 *
 * 同一族的另一处缺口（**未修，登记待办**）：\`标题\` / \`费用科目\` 在本弹窗里
 * 没有 \`maxLength\`，schema 也只有 \`min(1)\`；服务端 DTO 同样只校验
 * \`@IsString() @IsNotEmpty()\` —— 而库列是 \`varchar(200)\` / \`varchar(50)\`
 * （server/database/schema.ts 的 \`fin_expense_apply\`）。超长值会一路走到
 * Postgres 报 \`22001\`（value too long），而全局异常过滤器只映射了
 * \`23503\`/\`23505\`（server/common/filters/exception.filter.ts），因此拿到的是
 * 未映射错误、而不是可读的字段级校验提示。
 * 本仓 15 个 server DTO 文件共 172 处 \`@MaxLength\` 的既有惯例正是逐列对齐
 * \`varchar(n)\`，fin-expense 的 DTO 漏了这一层。修点在
 * \`server/modules/fin-expense/fin-expense.controller.ts\`（不在本次拆分范围内），
 * 故此处仅登记、不改动。
 */
import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import type { NavigateFunction } from 'react-router-dom';
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
import { Textarea } from '@client/src/components/ui/textarea';
import { finExpenseApi } from '@client/src/api';
import AttachmentHint from '@client/src/components/attachments/AttachmentHint';
import type {
  CreateExpenseApplyDto,
  Department,
  Project,
} from '@shared/api.interface';

const NONE = 'none';

const applySchema = z.object({
  applyType: z.string().min(1, '请选择申请类型'),
  title: z.string().min(1, '请填写申请标题'),
  departmentId: z.string(),
  projectId: z.string(),
  expenseCategory: z.string().min(1, '请填写费用科目'),
  amount: z.coerce.number().min(0, '申请金额不能为负'),
  expectDate: z.string().optional(),
  reason: z.string(),
  remark: z.string(),
});

type ApplyFormData = z.infer<typeof applySchema>;

const EMPTY_FORM: ApplyFormData = {
  applyType: 'travel',
  title: '',
  departmentId: NONE,
  projectId: NONE,
  expenseCategory: '',
  amount: 0,
  expectDate: undefined,
  reason: '',
  remark: '',
};

interface CreateExpenseApplyDialogProps {
  /** 父组件的弹窗开关 state，**原名透传**（见文件头「为什么 props 用同名」） */
  createOpen: boolean;
  setCreateOpen: (open: boolean) => void;
  /** 部门选项。查询仍在父组件持有，故允许 `undefined`（加载中） */
  departments: Department[] | undefined;
  /** 项目选项。父组件的筛选下拉与本报弹窗共用同一份查询 */
  projects: Project[] | undefined;
  /** 创建成功后父组件据此重取列表；`useAsyncData` 的 `reload` 返回 Promise */
  reload: () => Promise<void>;
  /** 创建成功后跳转详情。原名透传，保持 `onSubmit` 处理体逐字不动 */
  navigate: NavigateFunction;
}

const CreateExpenseApplyDialog: React.FC<CreateExpenseApplyDialogProps> = ({
  createOpen,
  setCreateOpen,
  departments,
  projects,
  reload,
  navigate,
}) => {
  const [operating, setOperating] = useState(false);

  const form = useForm<z.input<typeof applySchema>, unknown, ApplyFormData>({
    resolver: zodResolver(applySchema),
    defaultValues: EMPTY_FORM,
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateExpenseApplyDto = {
      applyType: values.applyType as 'travel' | 'purchase',
      title: values.title,
      departmentId:
        values.departmentId !== NONE ? values.departmentId : undefined,
      projectId: values.projectId !== NONE ? values.projectId : undefined,
      expenseCategory: values.expenseCategory,
      amount: values.amount,
      expectDate: values.expectDate || undefined,
      reason: values.reason || undefined,
      remark: values.remark || undefined,
    };
    setOperating(true);
    try {
      const created = await finExpenseApi.createApply(dto);
      toast.success('费用申请已提交');
      setCreateOpen(false);
      form.reset(EMPTY_FORM);
      await reload();
      navigate(`/fin-expense/applies/${created.id}`, { state: { item: created } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '提交失败');
    } finally {
      setOperating(false);
    }
  });

  return (
    <Dialog open={createOpen} onOpenChange={setCreateOpen}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>新增费用申请</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="flex flex-wrap gap-4">
              <FormField
                control={form.control}
                name="applyType"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      申请类型{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="travel">差旅</SelectItem>
                        <SelectItem value="purchase">采购</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      标题{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="如：北京客户现场交付差旅" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex flex-wrap gap-4">
              <FormField
                control={form.control}
                name="departmentId"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>部门</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="不限部门" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={NONE}>不限部门</SelectItem>
                        {(departments ?? []).map((dept: Department) => (
                          <SelectItem key={dept.id} value={dept.id}>
                            {dept.name}
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
                name="projectId"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>项目</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="不限项目" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={NONE}>不限项目</SelectItem>
                        {(projects ?? []).map((proj: Project) => (
                          <SelectItem key={proj.id} value={proj.id}>
                            {proj.code} - {proj.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex flex-wrap gap-4">
              <FormField
                control={form.control}
                name="expenseCategory"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      费用科目{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="如：差旅费" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      申请金额（元）{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
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
                control={form.control}
                name="expectDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>期望日期</FormLabel>
                    <DateField value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>申请事由</FormLabel>
                  <FormControl>
                    <Textarea rows={2} placeholder="选填" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="remark"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>备注</FormLabel>
                  <FormControl>
                    <Input placeholder="选填" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <AttachmentHint text="保存后将自动打开详情，可在其中上传费用发票、票据凭证等附件" />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={operating}>
                {operating ? '提交中...' : '提交申请'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default CreateExpenseApplyDialog;
