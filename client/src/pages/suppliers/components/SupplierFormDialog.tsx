/**
 * §5.9 拆分：供应商表单弹窗从 `SuppliersPage` 抽出。
 *
 * ## 为什么这一块可以整体搬走
 *
 * 弹窗的状态（`dialogOpen` / `editing` / `form`）与提交逻辑（`onSubmit`）
 * **没有任何一处被页面其它部分读取** —— 表格只调"打开"，提交成功只回调"刷新"。
 * 这类自闭环的块搬走后行为可逐字保持。
 *
 * ## 保留的三条业务细节（改的人容易丢，都是本仓踩过的坑）
 *
 * ① **"不指定"用哨兵值 `__none__` 而不是空串**：Radix `Select` 不允许
 *    `<SelectItem value="">`（空串被它保留给"清空"语义，用作 item value 会抛错），
 *    所以未指定态必须用一个显式哨兵，读写时来回映射 `'' ⇄ '__none__'`。
 *
 * ② **纳税主体下拉只列 `status === 'active'`**：停用主体不能再被新关联，
 *    但**已关联的历史数据仍要能显示**（编辑既有供应商时它的主体可能已停用）——
 *    所以是"下拉项过滤"，不是"把值清掉"。
 *
 * ③ 提交前 `'' → null`（不是 `|| undefined`）：`|| undefined` 会让服务端
 *    把这次提交当成"未传该字段"而**保留旧值**，使用者以为清空了、库里其实还在。
 */
import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
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
import { masterDataApi } from '@client/src/api';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { resolveRateOptions } from '@client/src/utils/tax-rate-options';
import type { CreateSupplierDto, Supplier, UpdateSupplierDto } from '@shared/api.interface';
import type { TaxEntity } from '@client/src/api/master-data';
import {
  EMPTY_FORM,
  SUPPLIER_TYPE_LABELS,
  supplierSchema,
  type SupplierFormData,
  type SupplierFormInput,
} from '../supplier-import';

/** 见文件头 ① —— Radix Select 的"未指定"哨兵值 */
const NONE = '__none__';

export interface SupplierFormDialogHandle {
  /** 不传 = 新建；传 = 编辑该行 */
  open: (supplier?: Supplier) => void;
}

interface Props {
  taxEntities: TaxEntity[] | undefined;
  /** 保存成功后调用（父页面据此重取列表） */
  onSaved: () => void | Promise<void>;
}

const SupplierFormDialog = React.forwardRef<SupplierFormDialogHandle, Props>(
  ({ taxEntities, onSaved }, ref) => {
    const [open, setOpen] = useState(false);
    const [editing, setEditing] = useState<Supplier | null>(null);

    const form = useForm<SupplierFormInput, unknown, SupplierFormData>({
      resolver: zodResolver(supplierSchema),
      /* 与 open 的无参分支共用一个字面量（见 supplier-import.ts 的 EMPTY_FORM） */
      defaultValues: EMPTY_FORM,
    });

    React.useImperativeHandle(
      ref,
      () => ({
        open: (supplier?: Supplier) => {
          if (supplier) {
            setEditing(supplier);
            form.reset({
              name: supplier.name,
              type: supplier.type ?? 'other',
              contactName: supplier.contactName ?? '',
              contactPhone: supplier.contactPhone ?? '',
              bankAccount: supplier.bankAccount ?? '',
              rating: supplier.rating,
              status: supplier.status,
              remark: supplier.remark ?? '',
              taxEntityId: supplier.taxEntityId ?? '',
              defaultTaxRate:
                supplier.defaultTaxRate != null ? String(supplier.defaultTaxRate) : '',
            });
          } else {
            setEditing(null);
            form.reset(EMPTY_FORM);
          }
          setOpen(true);
        },
      }),
      [form],
    );

    const onSubmit = form.handleSubmit(async (data) => {
      try {
        /* 见文件头 ③：'' → null，不要改成 || undefined */
        const taxPayload = {
          taxEntityId: data.taxEntityId || null,
          defaultTaxRate: data.defaultTaxRate === '' ? null : Number(data.defaultTaxRate),
        };
        if (editing) {
          const dto: UpdateSupplierDto = { ...data, ...taxPayload };
          await masterDataApi.updateSupplier(editing.id, dto);
          toast.success('供应商已更新');
        } else {
          const dto: CreateSupplierDto = { ...data, ...taxPayload };
          await masterDataApi.createSupplier(dto);
          toast.success('供应商已创建');
        }
        setOpen(false);
        await onSaved();
      } catch (err) {
        toast.error(getApiErrorMessage(err, '保存失败'));
      }
    });

    return (
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? '编辑供应商' : '新建供应商'}</DialogTitle>
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
                        <Input placeholder="请输入供应商名称" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="type"
                  render={({ field }) => (
                    <FormItem className="w-44">
                      <FormLabel>
                        类型 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.entries(SUPPLIER_TYPE_LABELS).map(([value, label]) => (
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
                  name="contactName"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>联系人</FormLabel>
                      <FormControl>
                        <Input placeholder="请输入联系人" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="contactPhone"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>联系电话</FormLabel>
                      <FormControl>
                        <Input placeholder="请输入联系电话" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="bankAccount"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>银行账户</FormLabel>
                      <FormControl>
                        <Input placeholder="请输入银行账户" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="rating"
                  render={({ field }) => (
                    <FormItem className="w-44">
                      <FormLabel>评级（0-5）</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
                          max={5}
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
              </div>
              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem className="w-44">
                    <FormLabel>状态</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="active">合作中</SelectItem>
                        <SelectItem value="inactive">停用</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="taxEntityId"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>关联纳税主体</FormLabel>
                      <Select
                        value={field.value || NONE}
                        onValueChange={(value) =>
                          field.onChange(value === NONE ? '' : value)
                        }
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="可选" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value={NONE}>不指定</SelectItem>
                          {/* 见文件头 ②：只列启用中的主体 */}
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
                          value={field.value || NONE}
                          onValueChange={(value) =>
                            field.onChange(value === NONE ? '' : value)
                          }
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="可选" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value={NONE}>不指定</SelectItem>
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
                      <Input placeholder="请输入备注" {...field} />
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
  },
);

SupplierFormDialog.displayName = 'SupplierFormDialog';

export default SupplierFormDialog;
