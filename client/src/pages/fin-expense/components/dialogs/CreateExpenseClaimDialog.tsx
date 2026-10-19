/**
 * 新增报销单弹窗（§5.9 / F8）。
 *
 * 从 `ExpenseClaimPanel.tsx`（550 行）抽出的自包含弹窗：表单 schema、默认值、
 * `useForm`、提交处理与全部表单 JSX 原先都散在主文件里，抽出后与使用它们的
 * JSX 同处一文件，主文件降到 500 行以内。
 *
 * ## 行为零变更
 *
 * 被搬走的代码是**逐字搬运**（按文本锚点整体剪切，只去掉一层缩进），只做了
 * 两件事：
 *   ① 整块 JSX 去掉一层缩进（统一 −2 空格）；
 *   ② `form` / `onSubmit` / `operating` / 表单常量与 schema 随 JSX 一起搬进来，
 *      跨文件用到的 7 个外部值改为 **同名 props**（`createOpen` /
 *      `setCreateOpen` / `departments` / `projects` / `approvedApplies` /
 *      `reload` / `navigate`）。
 *
 * 为什么 props 用「同名」而不是回调包装：后者要**改写 `onSubmit` 的处理体**，
 * 而本次拆分的硬约束是处理体与文案一个字都不动。同名透传只改「外层组件签名」，
 * 调用点逐字不变：
 *
 * ```tsx
 * setCreateOpen(false);                                  // 原样
 * await reload();                                        // 原样
 * navigate(`/fin-expense/claims/${item.id}`, …);          // 原样
 * ```
 *
 * ## ⚠️ 必须无条件挂载
 *
 * 父组件**不能**写成 `{createOpen && <CreateExpenseClaimDialog/>}`：`operating`
 * 与 `form` 原先在主文件里是常驻 state，条件挂载会在每次关闭时把它们丢掉，
 * 并改变 `Dialog` 的挂载时机。
 *
 * ## 表单重置时机（刻意保持原样）
 *
 * 原实现**没有** reset-on-open —— 这里也没有新增。`form.reset(EMPTY_FORM)`
 * 全仓只有一处触发点：**创建成功之后**（`toast.success(…)` →
 * `setCreateOpen(false)` → `form.reset(EMPTY_FORM)` → `await reload()` →
 * `navigate(…)`）。「取消」按钮与 ESC / 点遮罩关闭**都不重置**，
 * 触发点与顺序与改动前逐字一致；若把 reset 挪到 open 时机，
 * 重新打开会丢掉上次输入 —— 那是行为变更，不是等价重构。
 *
 * ## 金额口径（已核对，未改动）
 *
 * `amount` 客户端是 `z.coerce.number().min(0)`，服务端 DTO 是
 * `@IsNumber() @Min(0)`，两侧都允许 0；而 service 另有前置校验
 * 「报销金额必须大于 0」，即 **0 能过前端与 DTO、被 service 拒绝**
 * （用户看到 toast 报错，不是静默写坏）。与 `CreateExpenseApplyDialog`
 * 同一族口径，非本次拆分范围，保持原样未动。
 *
 * ## 已实测证实、但**本轮不修**的金额缺陷（报销金额录不进角分）
 *
 * `报销金额（元）` 的 `<Input type="number" min={0} …/>` **没有 `step`**，
 * 浏览器按 HTML 规范取默认 `step=1`、step base = `min` = 0；本弹窗的
 * `<form>` 又**没有 `noValidate`**、提交按钮是 `type="submit"`，于是
 * **原生交互校验会拦下提交，`onSubmit` 不会被调用**。真实 Chrome 实测
 * （探针页逐字复刻同一组属性后真实点击提交按钮）：
 *
 * ```
 * value="348.5"  → stepMismatch: true,  form.checkValidity(): false, submit 事件 0 次
 * value="348.50" → stepMismatch: true,  form.checkValidity(): false, submit 事件 0 次
 * value="348"    → stepMismatch: false, form.checkValidity(): true,  submit 事件 1 次
 * value="0.01"   → stepMismatch: true,  form.checkValidity(): false, submit 事件 0 次
 * ```
 *
 * 即 348.50 元这类**最常见的金额录不进去**（浏览器气泡：
 * 「请输入有效值。两个最接近的有效值分别为348和349。」）。
 *
 * 同一族还有一处**服务端口径**缺口（同样只登记）：客户端与 DTO 都允许任意
 * 小数，而 `fin_expense_claim.amount` 是 `numeric(18,2)`
 * （`server/database/schema.ts`；`erp_ap_bill.amount` / `erp_project_cost.amount`
 * 同为 `(18,2)`）。`service.createClaim` 的预算判定用的是**未落库的原始小数**
 * （`check.exceeded = executed + occupied + doc.amount > budgetAmount`），
 * 落库的却是四舍五入到两位的值。具体算术：可用预算恰为 11.00 时录入 11.001
 * → 判定 11.001 > 11.00 成立 → 单据被判为 `escalated`（超预算升级审批），
 * 但落库金额是 **11.00**，实际并未超预算 —— 决策依据（11.001）与服务端真正
 * 保存的金额（11.00）相差 0.001 元。
 *
 * **本轮不修的理由**：最小正确修复要同时改本弹窗的 `step`、`./CreateExpenseApplyDialog.tsx`
 * 里同款「申请金额」输入框（同一缺陷），以及服务端 DTO 的
 * `@IsNumber({ maxDecimalPlaces: 2 })` —— 而第二个文件是本轮明令不得改动的
 * 文件。故此处**只登记、不改动**，交由一次覆盖全部金额输入框的独立整改
 * （全仓 `type="number"` 共 89 处）。
 *
 * 关联未决口径（**不得改动**）：审计 T7「报销按含税全额借 6602，与进项发票
 * 口径冲突」是待业务确认的口径问题（`docs/待确认口径清单-2026-10-16.md`），
 * 对应代码在 `fin-expense.service.ts` 的 `claimAction`（approve 分支的
 * 6602/2202 分录）；本弹窗只负责建单，未触及该口径。
 */
import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { masterDataApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
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
import { Explained } from '@client/src/components/erp/ItemHelp';
import { Input } from '@client/src/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { finExpenseApi } from '@client/src/api';
import { sendApprovalNotification } from '@client/src/api/notifications';
import { formatMoney } from '@client/src/utils/format';
import AttachmentHint from '@client/src/components/attachments/AttachmentHint';
import type {
  CreateExpenseClaimDto,
  Department,
  ExpenseApplyItem,
  Project,
} from '@shared/api.interface';

const NONE = 'none';

const claimSchema = z.object({
  applyId: z.string(),
  departmentId: z.string(),
  projectId: z.string(),
  taxEntityId: z.string(),
  expenseCategory: z.string().min(1, '请填写费用科目'),
  amount: z.coerce.number().min(0, '报销金额不能为负'),
  expenseDate: z.string().optional(),
  remark: z.string(),
});

type ClaimFormData = z.infer<typeof claimSchema>;

const EMPTY_FORM: ClaimFormData = {
  applyId: NONE,
  departmentId: NONE,
  projectId: NONE,
  taxEntityId: '',
  expenseCategory: '',
  amount: 0,
  expenseDate: undefined,
  remark: '',
};

interface CreateExpenseClaimDialogProps {
  /** 父组件的弹窗开关 state，**原名透传**（见文件头「行为零变更」②） */
  createOpen: boolean;
  setCreateOpen: (open: boolean) => void;
  /** 部门选项。查询仍在父组件持有，故允许 `undefined`（加载中） */
  departments: Department[] | undefined;
  /** 项目选项。父组件的筛选下拉与本报弹窗共用同一份查询 */
  projects: Project[] | undefined;
  /** 可关联的**已批准**费用申请。查询与过滤仍在父组件持有 */
  approvedApplies: ExpenseApplyItem[];
  /** 创建成功后父组件据此重取列表；`useAsyncData` 的 `reload` 返回 Promise */
  reload: () => Promise<void>;
  /** 创建成功后跳转详情。原名透传，保持 `onSubmit` 处理体逐字不动 */
  navigate: NavigateFunction;
}

const CreateExpenseClaimDialog: React.FC<CreateExpenseClaimDialogProps> = ({
  createOpen,
  setCreateOpen,
  departments,
  projects,
  approvedApplies,
  reload,
  navigate,
}) => {
  const [operating, setOperating] = useState(false);

  const form = useForm<z.input<typeof claimSchema>, unknown, ClaimFormData>({
    resolver: zodResolver(claimSchema),
    defaultValues: EMPTY_FORM,
  });
  const { data: taxEntities } = useAsyncData(
    () => masterDataApi.listTaxEntities(),
    [],
  );

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateExpenseClaimDto = {
      applyId: values.applyId !== NONE ? values.applyId : undefined,
      departmentId:
        values.departmentId !== NONE ? values.departmentId : undefined,
      projectId: values.projectId !== NONE ? values.projectId : undefined,
      taxEntityId: values.taxEntityId || undefined,
      expenseCategory: values.expenseCategory,
      amount: values.amount,
      expenseDate: values.expenseDate || undefined,
      remark: values.remark || undefined,
    };
    setOperating(true);
    try {
      const item = await finExpenseApi.createClaim(dto);
      void sendApprovalNotification({
        bizType: 'expense',
        bizCode: item.code,
        title: '报销审批待办',
        content: `报销单 ${item.code} 已提交审批，金额 ${formatMoney(item.amount)}`,
      });
      toast.success(
        item.status === 'escalated'
          ? '报销单已提交（超预算，进入升级审批）'
          : '报销单已提交',
      );
      setCreateOpen(false);
      form.reset(EMPTY_FORM);
      await reload();
      navigate(`/fin-expense/claims/${item.id}`, { state: { item } });
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
          <DialogTitle>新增报销单</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          报销金额超预算时单据将进入升级审批；关联申请时金额不得超过申请额。
        </p>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="flex flex-wrap gap-4">
              <FormField
                control={form.control}
                name="applyId"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>关联费用申请</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="不关联申请" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value={NONE}>不关联申请</SelectItem>
                        {approvedApplies.map((apply: ExpenseApplyItem) => (
                          <SelectItem key={apply.id} value={apply.id}>
                            {apply.code}（{apply.expenseCategory} /{' '}
                            {formatMoney(apply.amount)}）
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
                name="expenseDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>费用日期</FormLabel>
                    <DateField value={field.value} onChange={field.onChange} />
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
            <FormField
              control={form.control}
              name="taxEntityId"
              render={({ field }) => (
                <FormItem>
                  <Explained
                    title="我方纳税主体"
                    content="默认带出项目合同的签约主体，可以改成其他启用中的主体。多家又没有合同时必须选。"
                  >
                    <FormLabel>我方纳税主体</FormLabel>
                  </Explained>
                  <Select
                    value={field.value || undefined}
                    onValueChange={field.onChange}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="无项目且多主体时必填" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(taxEntities ?? []).map((entity) => (
                        <SelectItem key={entity.id} value={entity.id}>
                          {entity.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
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
                      报销金额（元）{' '}
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
            </div>
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
            <AttachmentHint text="保存后将自动打开详情，可在其中上传发票、行程单、票据等附件" />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setCreateOpen(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={operating}>
                {operating ? '提交中...' : '提交报销单'}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default CreateExpenseClaimDialog;
