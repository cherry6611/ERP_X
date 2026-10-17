/**
 * 报表自查项的**构造与自洽**（从 `reports.service.ts` 抽出，§5.9）。
 *
 * ## 为什么这一小块值得单独成文件
 *
 * 报表接口返回的 `checks[]` 是**给使用者看的结论**（"资产 = 负债 + 权益"、
 * "营业收入 − 营业成本 = 营业利润"…）。它有三个字段描述同一件事：
 *
 * | 字段 | 含义 |
 * |---|---|
 * | `left` / `right` | 被比较的左右两侧金额（**界面上会显示**） |
 * | `difference` | `left − right`（界面显示为"差异"） |
 * | `passed` | 结论（界面显示为通过/不通过） |
 *
 * 三者**必须自洽**：如果 `passed` 与 `difference` 不一致，使用者会看到
 * "差异 ¥0.00 但标记为不通过"（或反过来"差异 ¥1234 但标记通过"）——
 * 前者让人以为系统坏了，后者更糟：**把真实的不平当成了平**。
 *
 * 抽出前 `passed` 在三处各写了一遍 `round2(a) === round2(b)`，而 `difference`
 * 是另一次独立计算。把"差异"与"结论"绑在同一个函数里，这种不自洽就不可能发生。
 *
 * ## 判等口径
 *
 * 一律走 `round2` 后比较（与 `finance/statement.logic.ts` 的 `sameAmount` 同判据）：
 * 金额是 2 位小数口径，直接 `===` 比浮点会被 `0.1+0.2` 这类累加噪声误判。
 */

import { round2 } from '@server/common/utils/number';
import type { ReportCheck } from '@shared/api.interface';

/** 金额判等：先按 2 位小数取整再比（与 `statement.logic.ts` 的 `sameAmount` 同判据） */
export function sameAmount(a: number, b: number): boolean {
  return round2(a) === round2(b);
}

/**
 * 构造一条报表自查项。
 *
 * ⚠️ `passed` **由 `difference` 推导**，不接受调用方另行传入 ——
 * 这正是防止"差异 0 却判不通过"这类不自洽的关键。
 */
export function buildReportCheck(params: {
  code: string;
  label: string;
  left: number;
  right: number;
}): ReportCheck {
  const left = round2(params.left);
  const right = round2(params.right);
  const difference = round2(left - right);
  return {
    code: params.code,
    label: params.label,
    left,
    right,
    difference,
    /* 结论与差异同源：difference === 0 ⇔ passed */
    passed: sameAmount(left, right),
  };
}

/**
 * 校验一组自查项是否自洽（`passed` 与 `difference` 不矛盾）。
 *
 * 用于单测与"报表生成后自检"：返回不自洽的项，正常应为空数组。
 */
export function findInconsistentChecks(checks: ReportCheck[]): ReportCheck[] {
  return checks.filter((c) => {
    const differenceZero = round2(c.difference ?? 0) === 0;
    return differenceZero !== c.passed;
  });
}
