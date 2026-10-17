/**
 * 「新建 / 编辑客户」弹窗（§5.9 / F8）。
 *
 * 从 `CustomersPage.tsx` 抽出的弹窗渲染块 —— 即该文件末尾的整段
 * `<Dialog open={dialogOpen} …>` 表单 JSX。主文件保留数据查询、列定义、
 * 导出/导入与本弹窗的编排，本文件只承担这一段表单的渲染。
 *
 * ## 为什么 `useForm` 留在父组件（不是漏搬）
 *
 * 原实现在**点击「新建客户」/「编辑」的那一刻同步**重置表单，触发点是父组件的
 * 两个处理器（`openCreate` / `openEdit`），随后才 `setDialogOpen(true)`：
 *
 *     const openCreate = () => {
 *       setEditing(null);
 *       form.reset({ ...CUSTOMER_EMPTY_FORM });
 *       setDialogOpen(true);
 *     };
 *     const openEdit = (customer: Customer) => {
 *       setEditing(customer);
 *       form.reset({ ...该行各字段 });
 *       setDialogOpen(true);
 *     };
 *
 * 全文件**没有** `useEffect(…, [open])` 这类"打开即清空"的逻辑 —— 触发点那次
 * `reset` 才是唯一的重置来源。搬进本组件后这行重置无处安放：改成
 * `useEffect` 会把"同步"变成"打开后一帧"，用户会先看到上一条记录的值。
 * 故表单实例以下沉的**同名 props** 传入（`form`），提交处理器同样由父组件传入
 * （`onSubmit`，即 `form.handleSubmit(…)` 的返回值）。本组件**没有**新增任何重置。
 *
 * ⚠️ **行为零变更**：JSX 逐字搬运，只做了三件事 ——
 *   ① 整体去掉一层缩进（每行 2 个空格）；
 *   ② `dialogOpen` / `setDialogOpen` 改为 props `open` / `onOpenChange`；
 *   ③ `editing` / `form` / `taxEntities` / `onSubmit` 由父组件的同名 props 传入。
 * 文案、placeholder、Select 选项与各 `<FormField name>` 全部逐字未动。
 */
import React from 'react';
import type { UseFormReturn } from 'react-hook-form';
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
import { resolveRateOptions } from '@client/src/utils/tax-rate-options';
import type { CustomerFormData, CustomerFormInput } from '../customer-import';
import type { Customer, TaxEntity } from '@shared/api.interface';

export type CustomerForm = UseFormReturn<CustomerFormInput, unknown, CustomerFormData>;

interface CustomerFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 正在编辑的客户；`null` 表示新建（原实现用同一个 state 决定标题与提交分支） */
  editing: Customer | null;
  /** 父组件持有的表单实例：打开弹窗时的 `reset` 由父组件调用（见文件头说明） */
  form: CustomerForm;
  /** 纳税主体选项。父组件持有查询，加载中为 `null`（原实现的 `(taxEntities ?? [])` 兜底不变） */
  taxEntities: TaxEntity[] | null;
  /** 父组件的提交处理器，即 `form.handleSubmit(…)` 的返回值 */
  onSubmit: (e?: React.BaseSyntheticEvent) => Promise<void>;
}

const CustomerFormDialog: React.FC<CustomerFormDialogProps> = ({
  open,
  onOpenChange,
  editing,
  form,
  taxEntities,
  onSubmit,
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? '编辑客户' : '新建客户'}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      名称 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="请输入客户名称" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="industry"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>行业</FormLabel>
                    <FormControl>
                      <Input placeholder="如：金融、制造" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="uscc"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>统一社会信用代码</FormLabel>
                    <FormControl>
                      <Input placeholder="选填" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="creditLevel"
                render={({ field }) => (
                  <FormItem className="w-32">
                    <FormLabel>信用等级</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="A">A</SelectItem>
                        <SelectItem value="B">B</SelectItem>
                        <SelectItem value="C">C</SelectItem>
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
                name="creditLimit"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>信用额度（元）</FormLabel>
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
                name="termsDays"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>账期（天）</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        max={365}
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
                name="status"
                render={({ field }) => (
                  <FormItem className="w-36">
                    <FormLabel>状态</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="prospect">潜在客户</SelectItem>
                        <SelectItem value="active">合作中</SelectItem>
                        <SelectItem value="inactive">停用</SelectItem>
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
                name="taxEntityId"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>关联纳税主体</FormLabel>
                    <Select
                      value={field.value || '__none__'}
                      onValueChange={(value) =>
                        field.onChange(value === '__none__' ? '' : value)
                      }
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="可选" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="__none__">不指定</SelectItem>
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
                name="defaultTaxRate"
                render={({ field }) => {
                  const entityId = form.watch('taxEntityId');
                  const entity = (taxEntities ?? []).find((row) => row.id === entityId);
                  const rates = resolveRateOptions(entity);
                  return (
                  <FormItem className="w-36">
                    <FormLabel>默认税率</FormLabel>
                    <Select
                      value={field.value || '__none__'}
                      onValueChange={(value) =>
                        field.onChange(value === '__none__' ? '' : value)
                      }
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="可选" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="__none__">不指定</SelectItem>
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
            <DialogFooter>
              <Button type="submit">保存</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default CustomerFormDialog;
