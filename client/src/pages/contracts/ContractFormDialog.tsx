/**
 * 合同表单（**新建** 与 **编辑** 两种模式共用一个组件）。
 *
 * ## 编辑模式怎么进来的（行为边界）
 *
 * `editTarget` 非空即编辑模式：标题、提交按钮文案、提交接口
 * （`contractsApi.updateContract` 而非 `createContract`）随之切换，提交内容是
 * `contract-edit-model.ts` 算出的**只含改动字段**的 PATCH 体。
 * `editTarget` 为空时走**新建**：`onSubmit` 的新建分支、文案、提交顺序逐字未动。
 *
 * ## ⚠️ 表单"播种"时机：由父组件的 `key` 重挂载完成，**本组件不新增任何 reset / useEffect**
 *
 * 本组件在编辑模式下必须显示**该行**的值，而 `useForm` 的 `defaultValues` 只在
 * 首次渲染生效。仓库里同类弹窗（`ProjectEditDialog.tsx`、`QuotationFormDialog.tsx`）
 * 的做法是 `useEffect(() => { if (open) form.reset(...) }, [open, target])`，
 * 本组件**刻意不那样做**：
 *
 * · `useEffect` 在 **commit 之后**执行，于是"打开编辑"的那一帧画面用的是**上一次的值**
 *   （点 A 行编辑、闪一下 B 行的数据再跳回来），随后才被 reset 覆盖 —— 使用者看得见；
 * · 更稳的触发点是**父组件的点击处理器**（`ContractsPage` 的 `openContractEdit`）：
 *   它在同一个事件里 `setEditTarget(row)` + `setEditSeq(n => n + 1)`，而弹窗上的
 *   `key={`contract-edit-${editSeq}`}` 随之变化 → React **重新挂载**本组件 →
 *   `defaultValues` 在**首次渲染**就是这一行的值，不存在"旧值闪帧"这一帧。
 *
 * 之所以用"重挂载"而不是"父组件持有 form 实例、点击时 reset"（那是
 * `components/dialogs/AcceptDeliverableDialog.tsx` 文件头记录的做法）：本弹窗的表单
 * 与 400 行 JSX 强耦合（`form.watch('customerId')` 参与税率下拉推导），把实例提到页面
 * 会把 schema 与提交处理器一起撕开；而"重挂载"得到同样的时机保证（首帧即正确值），
 * 代价只是每次打开多取一次客户/纳税主体下拉数据。
 *
 * ⚠️ 因此**不要在父组件去掉那个 `key`**：去掉后编辑同一行两次会显示上次未保存的改动。
 *
 * ## 编辑模式下字段的可改性（与《守卫表》一致）
 *
 * 客户 / 计费模式 / 签订日期在编辑模式一律**可改**（本轮解锁的就是这三个）；
 * "金额与客户仅草稿可改"由服务端把关（`server/modules/contracts/contract-update-guard.ts`），
 * 非草稿时表单顶部给一句说明，失败时展示服务端返回的中文原因。
 */
import React from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import DateField from '@client/src/components/erp/DateField';
import FieldHelp from '@client/src/components/erp/FieldHelp';
import ContractFormFooter from './components/ContractFormFooter';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
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
import { contractsApi, masterDataApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { BILLING_MODEL_LABELS } from '@client/src/utils/biz-labels';
import {
  resolveFormTaxRate,
  resolveRateOptions,
  resolveTaxEntity,
} from '@client/src/utils/tax-rate-options';
import { formatTaxSplitLine } from '@client/src/utils/tax-display';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type { Contract, CreateContractDto, Customer } from '@shared/api.interface';
import { submitContractEdit } from './contract-edit-model';

import {
  contractSchema,
  editContractSchema,
  editFormDefaults,
  CREATE_FORM_DEFAULTS,
  type ContractFormData,
  type ContractFormInput,
  type ContractFormDialogProps,
} from './contract-form-model';

const ContractFormDialog: React.FC<ContractFormDialogProps> = ({
  open = false,
  onOpenChange,
  onCreated,
  onUpdated,
  asPage = false,
  onCancel,
  editTarget = null,
}) => {
  const { data: customers } = useAsyncData<Customer[]>(() => masterDataApi.listCustomers(), []);
  const { data: taxEntities } = useAsyncData(
    () => masterDataApi.listTaxEntities(),
    []
  );

  const form = useForm<ContractFormInput, unknown, ContractFormData>({
    resolver: zodResolver(editTarget ? editContractSchema : contractSchema),
    defaultValues: editTarget
      ? editFormDefaults(editTarget)
      : /* 新建：逐字沿用原初值 */ CREATE_FORM_DEFAULTS,
  });

  const onSubmit = form.handleSubmit(async (values) => {
    if (editTarget) {
      /*
       * 编辑：只下发**改动过**的字段（PATCH 语义）。
       * 为什么不能把整份表单发上去：服务端对 amount / customerId 是"字段出现即拒"
       * （非 draft 一律 400），整份下发会让"改个名称"也被拒 —— 详见
       * `contract-edit-model.ts` 的「为什么编辑不能复用新建那份 DTO 构造」。
       */
      try {
        const result = await submitContractEdit(
          { createContract: contractsApi.createContract, updateContract: contractsApi.updateContract },
          editTarget,
          values,
        );
        toast.success(
          result.status === 'unchanged' ? '合同无改动' : '合同已更新',
        );
        onOpenChange?.(false);
        onUpdated?.(result.contract);
      } catch (err) {
        toast.error(getApiErrorMessage(err, '更新失败'));
      }
      return;
    }
    const dto: CreateContractDto = {
      name: values.name,
      customerId: values.customerId,
      billingModel: values.billingModel as CreateContractDto['billingModel'],
      amount: values.amount,
      taxRate: values.taxRate,
      taxEntityId: values.taxEntityId || undefined,
      signDate: values.signDate,
      startDate: values.startDate,
      endDate: values.endDate,
      owner: values.owner || undefined,
      paymentTerms: values.paymentTerms || undefined,
      remark: values.remark || undefined,
    };
    try {
      const created = await contractsApi.createContract(dto);
      toast.success('合同已登记');
      onOpenChange?.(false);
      form.reset();
      onCreated?.(created.id);
    } catch (err) {
      toast.error(getApiErrorMessage(err, '登记失败'));
    }
  });

  const formInner = (
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            {editTarget && editTarget.status !== 'draft' ? (
              /*
               * 非草稿合同的额外限制**不在前端禁用控件**：服务端才是判据
               * （`contract-update-guard.ts`），这里只提前说明，避免使用者
               * 反复调整客户后拿到一句看不懂的报错。
               */
              <p className="text-xs text-muted-foreground">
                该合同已非草稿：金额与客户仅在草稿状态可改（已开具的发票与已登记的应收挂在原客户上）；
                名称、计费模式、负责人、日期与备注可直接修改。
              </p>
            ) : null}
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    合同名称 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <FormControl>
                    <Input placeholder="请输入合同名称" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="customerId"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      客户 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select
                      value={field.value}
                      onValueChange={(value) => {
                        field.onChange(value);
                        // 修复 P0-1：切换客户时同步校正税率。
                        // 客户可能绑定了小规模主体，此时 6% 是非法值，不校正会被后端拒 400。
                        const entity = resolveTaxEntity({
                          taxEntityId: form.getValues('taxEntityId'),
                          taxEntities: taxEntities ?? [],
                          customerTaxEntityId:
                            (customers ?? []).find((row) => row.id === value)
                              ?.taxEntityId ?? null,
                        });
                        form.setValue(
                          'taxRate',
                          resolveFormTaxRate(
                            Number(form.getValues('taxRate') ?? 6),
                            entity
                          )
                        );
                      }}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择客户" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(customers ?? []).map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
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
                name="billingModel"
                render={({ field }) => (
                  <FormItem className="w-44">
                    <FormLabel>
                      计费模式 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {Object.entries(BILLING_MODEL_LABELS).map(([value, label]) => (
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
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      金额（含税）{' '}
                      <span aria-hidden="true" className="text-destructive">*</span>
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
                name="taxEntityId"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>纳税主体</FormLabel>
                    <Select
                      value={field.value || '__default__'}
                      onValueChange={(value) => {
                        const nextId = value === '__default__' ? '' : value;
                        field.onChange(nextId);
                        const entity = (taxEntities ?? []).find(
                          (row) => row.id === nextId
                        );
                        const current = Number(form.getValues('taxRate') ?? 6);
                        form.setValue('taxRate', resolveFormTaxRate(current, entity));
                      }}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="默认主体" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="__default__">系统默认</SelectItem>
                        {(taxEntities ?? [])
                          .filter((entity) => entity.status === 'active')
                          .map((entity) => (
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
              <FormField
                control={form.control}
                name="taxRate"
                render={({ field }) => {
                  // 修复 P0-1：解析顺序必须与后端一致（显式主体 → 客户绑定主体 → 默认主体），
                  // 否则客户绑定了小规模主体、用户主体留空时，下拉仍显示 6% 而提交被拒 400。
                  const entity = resolveTaxEntity({
                    taxEntityId: form.watch('taxEntityId'),
                    taxEntities: taxEntities ?? [],
                    customerTaxEntityId:
                      (customers ?? []).find(
                        (row) => row.id === form.watch('customerId')
                      )?.taxEntityId ?? null,
                  });
                  const rates = resolveRateOptions(entity);
                  return (
                    <FormItem className="w-36">
                      <div className="flex items-center gap-0.5"><FormLabel>税率（%）</FormLabel><FieldHelp label="税率">按纳税主体默认档位带出；小规模与一般纳税人的可选档位不同。</FieldHelp></div>
                      <Select
                        value={String(field.value)}
                        onValueChange={(value) => field.onChange(Number(value))}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="税率" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {rates.map((rate) => (
                            <SelectItem key={rate} value={String(rate)}>
                              {rate}%
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  );
                }}
              />
            </div>
            <p className="text-xs text-muted-foreground -mt-2">
              {formatTaxSplitLine(
                Number(form.watch('amount') ?? 0),
                Number(form.watch('taxRate') ?? 0)
              )}
            </p>
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="signDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>签订日期</FormLabel>
                    <DateField value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="startDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>开始日期</FormLabel>
                    <DateField value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="endDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>结束日期</FormLabel>
                    <DateField value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="owner"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>负责人</FormLabel>
                    <FormControl>
                      <Input placeholder="请输入负责人" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="paymentTerms"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>付款条款</FormLabel>
                    <FormControl>
                      <Input placeholder="如：验收后 30 天" {...field} />
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
                    <Textarea placeholder="备注信息" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <ContractFormFooter
              asPage={asPage}
              isEdit={Boolean(editTarget)}
              onCancel={onCancel}
            />
          </form>
        </Form>
  );

  if (asPage) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <div className="rounded-xl border border-border/80 bg-card p-6">
          {formInner}
        </div>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{editTarget ? '编辑合同' : '登记合同'}</DialogTitle>
        </DialogHeader>
        {formInner}
      </DialogContent>
    </Dialog>
  );
};

export default ContractFormDialog;





