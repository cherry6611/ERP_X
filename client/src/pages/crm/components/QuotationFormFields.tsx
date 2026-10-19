/**
 * 报价单表头字段区（§5.9 / F8，从 `QuotationFormDialog.tsx` 拆出）。
 *
 * 7 个 `FormField`（标题/客户/关联商机/报价日期/有效期至/整单折扣/备注）原先占主文件
 * 120 余行，是纯 JSX：状态全部在父组件的 `useForm` 里，本组件不再有 `useForm`、
 * 不再有 `useState`（**没有搬动任何状态**，与「子组件自持状态」的常规拆法不同 ——
 * 这里字段值与明细、合计、提交处理器共用同一份 `form`，人为复制一份必然分叉）。
 *
 * 因此 props 直接接收父组件的 `form`（`QuoteForm`），JSX 里 `form.control`、
 * `customers`、`opportunities` 三个标识符**逐字未改**，无需改动块内任何一行。
 * 客户/商机选项由父组件查询后传入（父组件持有数据查询）。
 */
import React from 'react';
import { Explained } from '@client/src/components/erp/ItemHelp';
import DateField from '@client/src/components/erp/DateField';
import {
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
import { applySelectChange, type QuoteForm } from './quotation-form';
import type { Customer, Opportunity } from '@shared/api.interface';

interface QuotationFormFieldsProps {
  /** 父组件持有的表单实例；本组件只渲染字段 */
  form: QuoteForm;
  /** 客户选项。父组件持有查询，故允许 null（加载中） */
  customers?: Customer[] | null;
  /** 商机选项。父组件持有查询，故允许 null（加载中） */
  opportunities?: Opportunity[] | null;
}

const QuotationFormFields: React.FC<QuotationFormFieldsProps> = ({
  form,
  customers,
  opportunities,
}) => {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-4">
      <FormField
        control={form.control}
        name="title"
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              标题 <span aria-hidden="true" className="text-destructive">*</span>
            </FormLabel>
            <FormControl>
              <Input placeholder="如：数据中台建设一期报价" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="customerId"
        render={({ field }) => (
          <FormItem>
            <FormLabel>
              客户 <span aria-hidden="true" className="text-destructive">*</span>
            </FormLabel>
            {/*
              ⚠️ `onValueChange` 必须过 `applySelectChange`（**本仓实测过的缺陷**）：
              编辑报价单时 `customers` 是异步拉的，首帧下拉里 0 个选项，
              而 `form.reset` 已经把 `customerId` 填好了 —— 此时 Radix Select
              因为**找不到与该 value 匹配的 SelectItem**，会主动回调
              `onValueChange('')`，直接把刚回填的客户抹成空串。
              后果：编辑页「保存修改」被必填校验拦住（提示"请选择客户"），
              必须手动重选一次客户才能保存。详见 `./quotation-form.ts` 的说明。
            */}
            <Select
              onValueChange={(next) =>
                field.onChange(
                  applySelectChange(next, field.value, { allowEmpty: false }),
                )
              }
              value={field.value}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="请选择客户" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {(customers ?? []).map((c: Customer) => (
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
        name="opportunityId"
        render={({ field }) => (
          <FormItem>
            <FormLabel>关联商机</FormLabel>
            {/* 同「客户」：没有"不关联"选项，就必须拒绝 Radix 的空值回调（见 quotation-form.ts） */}
            <Select
              onValueChange={(next) =>
                field.onChange(
                  applySelectChange(next, field.value, { allowEmpty: false }),
                )
              }
              value={field.value}
            >
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="不关联商机" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {(opportunities ?? []).map((o: Opportunity) => (
                  <SelectItem key={o.id} value={o.id}>
                    {o.title}
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
        name="quoteDate"
        render={({ field }) => (
          <FormItem>
            <FormLabel>报价日期</FormLabel>
            <DateField value={field.value} onChange={field.onChange} />
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="validUntil"
        render={({ field }) => (
          <FormItem>
            <Explained
              title="有效期至"
              content="报价在这一天之后视为过期。过期后仍可改，但不应再按这张报价成交。"
            >
              <FormLabel>有效期至</FormLabel>
            </Explained>
            <DateField value={field.value} onChange={field.onChange} />
            <FormMessage />
          </FormItem>
        )}
      />
      <FormField
        control={form.control}
        name="discountPct"
        render={({ field }) => (
          <FormItem>
            <Explained
              title="整单折扣"
              content="在明细合计上再打的折扣。100 表示不打折，90 表示按九折。它不改变每一行的单价。"
            >
              <FormLabel>整单折扣（%）</FormLabel>
            </Explained>
            <FormControl>
              <Input
                type="number"
                min={0}
                max={100}
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
        name="remark"
        render={({ field }) => (
          <FormItem className="col-span-2">
            <FormLabel>备注</FormLabel>
            <FormControl>
              <Input placeholder="备注信息（可选）" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
};

export default QuotationFormFields;
