import * as React from 'react';
import { Label } from '@client/src/components/ui/label';
import { cn } from '@client/src/lib/utils';

/**
 * P2-3（§5.10）：**表单字段的标签关联** —— 修掉 37 处 `<Label>` 无 `htmlFor`。
 *
 * ## 问题
 *
 * 仓库里有 37 处形如：
 * ```tsx
 * <div className="grid gap-1">
 *   <Label className="text-xs">指标</Label>
 *   <Select ...><SelectTrigger>…</SelectTrigger></Select>
 * </div>
 * ```
 * 标签与控件之间**没有任何关联**。后果（WCAG 1.3.1 / 3.3.2）：
 *   · 屏幕阅读器只念"组合框"，不念它是什么字段；
 *   · 点击标签不会把焦点移到控件上（鼠标用户的可点击区域白白变小）。
 *
 * ## 为什么不能简单地加 `htmlFor`
 *
 * `htmlFor` 需要一个 DOM id，而 id 必须**全页唯一**。给 37 处各手写一个 id
 * 是"看起来修好了、实际埋了新雷"：复制粘贴会撞 id，撞 id 后
 * `htmlFor` 指向**错误的第一个元素** —— 点标签聚焦到别的输入框，
 * 比不关联更糟（而且没人会测）。
 *
 * 因此这里用 `React.useId()`：**由 React 保证唯一**，跨组件实例、跨渲染稳定。
 *
 * ## 为什么分 `htmlFor` 与 `aria-label` 两条路
 *
 * `Select` / `Combobox` 这类控件渲染出来的不是 `<label for>` 能关联的原生表单元素
 * （Radix 的 `SelectTrigger` 是一个 `role="combobox"` 的 `<button>`）。
 * 对它们，标准做法是给控件加 `aria-label` 或 `aria-labelledby`，
 * 而不是硬塞一个 `htmlFor`。
 *
 * 所以本组件暴露两种用法：
 *
 * ```tsx
 * // ① 原生控件（Input / Textarea / NativeSelect）：传 controlId
 * const id = useId();
 * <FieldLabel htmlFor={id}>阈值</FieldLabel>
 * <Input id={id} … />
 *
 * // ② 复合控件（Radix Select 等）：用 render prop 把 id 交给 aria-labelledby
 * <FieldLabel>
 *   {({ labelId }) => <SelectTrigger aria-labelledby={labelId} … />}
 * </FieldLabel>
 * ```
 *
 * ② 的 `aria-labelledby` 指向 `<label>` 元素本身即可 —— 无障碍树会把
 * label 的文本当作控件名，效果与 `htmlFor` 等价。
 */
export interface FieldLabelProps {
  /** 原生控件的 id（`Input` / `Textarea` / `NativeSelect` 用这条路） */
  htmlFor?: string;
  className?: string;
  /** 必填标记（渲染为 `*`，与既有 `aria-hidden` 写法一致） */
  required?: boolean;
  children: React.ReactNode;
}

/**
 * 简单形态：`htmlFor` + 文本。
 *
 * 也提供 `labelId` 通过 `useFieldLabelId()` 单独取，供复合控件用。
 */
export function FieldLabel({
  htmlFor,
  className,
  required,
  children,
}: FieldLabelProps) {
  return (
    <Label htmlFor={htmlFor} className={cn('text-xs', className)}>
      {children}
      {required ? (
        <span aria-hidden="true" className="text-destructive">
          {' '}
          *
        </span>
      ) : null}
    </Label>
  );
}

/**
 * 复合控件（Radix Select / Combobox）的标签。
 *
 * 渲染一个 `<span role="presentation">` 而不是 `<label>`：
 * 复合控件的可访问名来自 `aria-labelledby`，指向 `<label>` 元素会让
 * 无障碍树同时产生"label 关联"与"labelledby 关联"两条路径，
 * 部分读屏器会重复念一遍。用 `<span>` + 稳定的 id 更干净。
 */
export function FieldGroupLabel({
  className,
  required,
  children,
  onLabelId,
}: {
  className?: string;
  required?: boolean;
  children: React.ReactNode;
  /** 把生成的 id 交给调用方，用于 `aria-labelledby` */
  onLabelId: (id: string) => void;
}) {
  const id = React.useId();
  React.useEffect(() => {
    onLabelId(id);
  }, [id, onLabelId]);
  return (
    <span id={id} className={cn('text-xs font-medium', className)}>
      {children}
      {required ? (
        <span aria-hidden="true" className="text-destructive">
          {' '}
          *
        </span>
      ) : null}
    </span>
  );
}

/**
 * 取一个稳定的字段 id（供原生控件与它的 `htmlFor` 共用）。
 *
 * 单独导出是为了让调用点写成：
 * ```tsx
 * const id = useFieldId();
 * <FieldLabel htmlFor={id}>阈值</FieldLabel>
 * <Input id={id} … />
 * ```
 * 而不必在每个组件里自己 import `useId` —— 统一入口也便于将来
 * 若要改成"可预测 id"（如端到端测试需要固定 id）只改一处。
 */
export function useFieldId(prefix = 'field'): string {
  const raw = React.useId();
  // `useId` 返回形如 `:r1:` 的字符串；作为 HTML id 合法，但去掉冒号更易读、
  // 也避免在某些 CSS 选择器/测试选择器里需要转义。
  return `${prefix}-${raw.replace(/:/gu, '')}`;
}
