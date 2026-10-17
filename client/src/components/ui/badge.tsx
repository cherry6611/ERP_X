import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  // Whitespace-nowrap: Badges should never wrap.
  // hover-elevate: adds subtle dark overlay on hover for interactive feedback
  "whitespace-nowrap inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold hover-elevate",
  {
    variants: {
      variant: {
        default:
          // Primary badge with subtle shadow for elevation
          "border-transparent bg-primary text-primary-foreground shadow-xs",
        secondary:
          // Subtle filled badge for secondary information
          "border-transparent bg-secondary text-secondary-foreground",
        destructive:
          // Error/danger state with matching shadow
          "border-transparent bg-destructive text-destructive-foreground shadow-xs",
        /*
         * F3（§5.4）：语义变体的前景色用**专用 token**，不再直接复用
         * `--success` / `--warning` / `--primary` / `--destructive`。
         *
         * 原写法 `bg-<token>/10 text-<token>` 是"10% 浅底 + 原色字"，
         * 实测对比度全部低于 WCAG AA 的 4.5:1，其中
         * `text-warning on bg-warning/10` 只有 **1.98:1** ——
         * 而 `biz-labels.ts` 把 **12 个"进行中"状态**全映射到 warning，
         * `StatusBadge` 全仓渲染 31 处 / 25 文件。
         * 即：最能一眼看清的"进行中"，恰好是全站可读性最差的一处。
         *
         * 新 token 是同色相的深档（暗色下为浅档，见 tailwind-theme.css），
         * 底色不动 —— 视觉语义完全不变，只把明度差拉开到 ≥ 4.5:1。
         */
        success: "border-transparent bg-success/10 text-[color:var(--badge-success-foreground)]",
        warning: "border-transparent bg-warning/10 text-[color:var(--badge-warning-foreground)]",
        info: "border-transparent bg-primary/10 text-[color:var(--badge-info-foreground)]",
        // Outline uses badge-outline variable to blend with parent background
        outline: "border [border-color:var(--badge-outline)] shadow-xs",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

/**
 * 徽标。
 *
 * ⚠️ 渲染为 `<span>` 而不是 `<div>`，这不是风格偏好，是**正确性**要求：
 *   徽标被到处放进 `<p>` 里（如合同详情 `ContractDetailDialog.tsx`
 *   `<p className="text-muted-foreground">计费模式</p><p><Badge/></p>`）。
 *   当 Badge 渲染 `<div>` 时，产生 `<p><div></div></p>` ——
 *   **HTML 非法嵌套**，React 19 会在控制台报
 *     "In HTML, <div> cannot be a descendant of <p>. This will cause a hydration error."
 *   浏览器会自动闭合 `<p>`，导致布局意外与 DOM 结构错位。
 *   `<span>` + `inline-flex` 视觉完全一致，且是 span 的合法用法。
 *   （shadcn 官方 badge 同样是 span。）
 */
export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants }
