/**
 * 报表取数的**方向口径**（从 `reports.service.ts#accountAmount` 抽出，§5.9）。
 *
 * ## 为什么这三行必须有 spec
 *
 * 报表每一行的金额都由它算出来。三个分支的差别**极难在界面上看出来**，
 * 而后果是"数字本身就是错的、但报表仍然平"：
 *
 * | `direction` | 取值 | 现象 |
 * |---|---|---|
 * | `借` / `debit` | `max(借 − 贷, 0)` | **贷方余额被钳成 0** → 资产类行**虚增** |
 * | `贷` / `credit` | `max(贷 − 借, 0)` | 借方余额被钳成 0 → 负债类行虚增 |
 * | 其他（净） | `借 − 贷`（**不钳**，可负） | 保留符号 |
 *
 * 第二列那个"钳成 0"不是随手写的：资产负债表按方向取数时，
 * 一个子科目出现反向余额（如 `100202 银行存款-一般户` 在账户间划转后出现贷方）
 * 若被钳成 0，**货币资金就虚增**了 —— 这正是迁移
 * `2026-10-15-upgrade-bs-moneyfunds-net.sql` 修的那个缺陷，
 * 该迁移把"货币资金"一行从 `借` 改成 `净`。
 *
 * 所以本模块的规格不是"验算算术"，而是**把三种口径的语义钉死**：
 * 谁钳、谁不钳、`change` 为何与方向和无关。
 */

import { round2 } from '@server/common/utils/number';

/** 取数类型：余额 / 本期发生额 / 年初 / 变动额 */
export type AmountKind = 'balance' | 'occurrence' | 'opening' | 'change';

/** 方向：`借`/`debit`、`贷`/`credit`，其余按"净额"处理 */
export type AccountDirection = string;

export interface AccountValues {
  openingDebit: number;
  openingCredit: number;
  debitOccur: number;
  creditOccur: number;
  closingDebit: number;
  closingCredit: number;
}

/** 是否为"借方"口径（兼容中文符号与英文） */
export function isDebitDirection(direction: AccountDirection): boolean {
  return direction === '借' || direction === 'debit';
}

/** 是否为"贷方"口径（兼容中文符号与英文） */
export function isCreditDirection(direction: AccountDirection): boolean {
  return direction === '贷' || direction === 'credit';
}

/**
 * 按口径取数。
 *
 * ⚠️ `change`（变动额）**完全忽略 `direction`**：它算的是
 * `(期末借−期末贷) − (年初借−年初贷)`，本身就是带符号的净变动，
 * 再按方向钳 0 会把"减少"抹成 0（那是另一个方向的虚增）。
 */
export function accountAmount(
  kind: AmountKind,
  direction: AccountDirection,
  values: AccountValues | undefined | null,
): number {
  if (!values) return 0;

  if (kind === 'change') {
    return round2(
      values.closingDebit -
        values.closingCredit -
        (values.openingDebit - values.openingCredit),
    );
  }

  const debit =
    kind === 'occurrence'
      ? values.debitOccur
      : kind === 'opening'
        ? values.openingDebit
        : values.closingDebit;
  const credit =
    kind === 'occurrence'
      ? values.creditOccur
      : kind === 'opening'
        ? values.openingCredit
        : values.closingCredit;

  if (isDebitDirection(direction)) {
    /* ⚠️ 钳 0：贷方余额的借方科目记 0（不是负数） */
    return Math.max(round2(debit - credit), 0);
  }
  if (isCreditDirection(direction)) {
    return Math.max(round2(credit - debit), 0);
  }
  /* 净额口径：**不钳**，可负 —— 这是"同一份数据两个口径"的关键区别 */
  return round2(debit - credit);
}
