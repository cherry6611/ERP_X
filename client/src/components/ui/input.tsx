import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, step, ...props }: React.ComponentProps<"input">) {
  /*
   * ⚠️ **`type="number"` 必须显式给 `step`** —— 否则浏览器按 HTML 规范取默认
   * `step=1`，于是带角分的金额（`348.50`）被判 `stepMismatch`。
   *
   * ## 为什么这条默认值必须在这里，而不是逐个输入框去加
   *
   * 本仓的 `<form>` **没有 `noValidate`**、提交按钮是 `type="submit"`，
   * 所以原生交互校验会**拦下提交，`onSubmit` 根本不会被调用**（不是提交后报错，
   * 是压根不提交）。实测（真实 Chrome，逐字复刻同一组属性后真实点击提交）：
   *
   * | 输入值 | stepMismatch | form.checkValidity() | submit 事件 |
   * |---|---|---|---|
   * | `348.5` / `348.50` / `0.01` | true | false | **0 次** |
   * | `348` | false | true | 1 次 |
   *
   * 也就是说：**报销金额这类"元"输入框只能填整数** —— 使用者看到的是
   * "填完点保存没反应"，而金额列是 `numeric(18,2)`。
   *
   * 全仓 `type="number"` 实测 **91 处**，其中 **73 处没有声明 `step`**，
   * 分布在 49 个文件（金额、数量、百分比、工时都有）。逐个去加既容易漏、
   * 也拦不住下一个新输入框再踩 —— 这是**组件能力缺失**，不是 73 个独立 bug，
   * 所以在共享组件上补默认值。
   *
   * ## 为什么默认是 `any` 而不是 `0.01`
   *
   * 不同字段的必要精度不同：金额需两位小数、数量常为整数、百分比/费率可能更多位。
   * 统一写 `0.01` 会**误伤数量类**输入（本仓多个数量框声明 `min={1}` 且业务上取整）；
   * `any` 只是让浏览器不再替业务层做精度判断，而**精度约束本就该由校验层承担**：
   * 服务端 DTO 有 `@IsNumber({ maxDecimalPlaces: 2 })` / `@Min()` / `@IsInt()`，
   * 前端有 zod（如 `z.coerce.number().int().min(1)`）。
   *
   * 需要更严格提示的字段（例如明确的金额框）**仍可自行传 `step`**，
   * 显式传入优先于本默认值。
   *
   * ## 没有带来的风险
   *
   * `stepMismatch` 此前唯一实际拦下的东西就是"多位小数进金额框"，而那些值在
   * 服务端会被拒（`maxDecimalPlaces`）或按分取整。本会话刚修过的一处
   * "凭证 0.001 元导致零金额分录"是**提交前先取整再判定**，与本属性无关。
   */
  const resolvedStep = step ?? (type === 'number' ? 'any' : undefined)
  return (
    <input
      type={type}
      step={resolvedStep}
      data-slot="input"
      className={cn(
        "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "enabled:hover:border-ring focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring",
        "aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Input }
