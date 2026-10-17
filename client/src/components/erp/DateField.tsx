/**
 * 日期选择控件（Popover + Calendar）。
 *
 * ## 为什么 `FormControl` 是**可选**的
 *
 * 原生写法是 `<FormItem><FormControl><DateField/></FormControl></FormItem>`，
 * 此时 `FormItemContext` 提供 `id`，触发器按钮能被 `<Label htmlFor>` 正确关联。
 *
 * 但本仓有**不带 `<Form>` 的场景**（如 `EmployeeOffboardDialog` 用的是裸
 * `<Label htmlFor="resign-date">` + 一个 `useState`，整个弹窗没有 `useForm`）。
 * 那种场景下如果仍然无条件渲染 `<FormControl>`，`useFormField()` 会因为
 * `useFormContext()` 为 `null` 直接抛错：
 *
 * ```
 * TypeError: Cannot destructure property 'getFieldState' of 'useFormContext(...)' as it is null.
 * ```
 * 走查实测：**点「离职」按钮即整页白屏**（错误边界接管），弹窗根本打不开。
 *
 * 因此这里改成二选一：
 *   · 在 `FormItem` 内（拿得到 `id`）→ 保持原来的 `<FormControl>` 包装；
 *   · 不在 `FormItem` 内 → 直接用按钮，并通过 `labelledBy` 指向外部 `<Label>` 的 id。
 * 两条路都满足「标签与控件真的关联」这条门禁要求，且都不依赖 `useForm`。
 */
import React from 'react';
import { Popover, PopoverContent, PopoverTrigger } from '@client/src/components/ui/popover';
import { Button } from '@client/src/components/ui/button';
import { Calendar } from '@client/src/components/ui/calendar';
import { FormControl, FormItemContext } from '@client/src/components/ui/form';

interface DateFieldProps {
  value: string | null | undefined;
  onChange: (value: string | undefined) => void;
  /** 无 `FormItem` 包裹时，用它把控件关联到外部 `<Label id>` */
  labelledBy?: string;
}

const toLocalDate = (date: Date): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

const DateField: React.FC<DateFieldProps> = ({ value, onChange, labelledBy }) => {
  const itemContext = React.useContext(FormItemContext);
  const insideFormItem = Boolean(itemContext?.id);
  const trigger = (
    <Button
      variant="outline"
      className="w-full justify-start font-normal"
      type="button"
      aria-labelledby={insideFormItem ? undefined : labelledBy}
    >
      {value ? value : '请选择日期'}
    </Button>
  );
  return (
    <Popover>
      <PopoverTrigger asChild>
        {insideFormItem ? <FormControl>{trigger}</FormControl> : trigger}
      </PopoverTrigger>
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          selected={value ? new Date(`${value}T00:00:00`) : undefined}
          onSelect={(date: Date | undefined) => onChange(date ? toLocalDate(date) : undefined)}
        />
      </PopoverContent>
    </Popover>
  );
};

export default DateField;
