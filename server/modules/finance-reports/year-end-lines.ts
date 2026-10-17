import { round2 } from '@server/common/utils/number';

/**
 * 年结结转损益的**分录构造（纯函数）**。
 *
 * 为什么从 `year-end.service.ts` 里抽出来：结转方向的错法有两个相反方向
 * （盈利/亏损各一种），且都被同一条「借贷不平衡」校验挡下 —— 表现都是"年结失败"，
 * 不看代码根本分不清是哪边错。放在 service 里只能靠 pglite 集成测试覆盖，
 * 而这里恰恰是**纯算术**，用单测双向锁定成本最低、也最不容易被跳过。
 *
 * 历史缺陷（本函数即为此而建）：
 *  1. 本年利润（3131）方向写反 —— 盈利记借方、亏损记贷方，导致只要当年有盈亏，
 *     结转凭证借贷必然不等，年结在 profitDelta ≠ 0 时 100% 抛错不可用；
 *  2. 损益科目方向改用 `accountType`（收入/费用）判断，丢弃了 `carryDirection`，
 *     于是「收入类科目出现借方余额」时不是冲平它而是把余额翻倍。
 */
export interface CarryForwardItem {
  accountCode: string;
  accountName: string;
  /** 待结转金额（恒为正数） */
  carryAmount: number;
  /**
   * 结转分录的方向，即**原余额的反方向**：
   * - `debit`：该科目当前是**贷方**余额 → 借记它以冲平（典型：收入类）
   * - `credit`：该科目当前是**借方**余额 → 贷记它以冲平（典型：费用类）
   */
  carryDirection: 'debit' | 'credit';
}

export interface CarryForwardLine {
  accountCode: string;
  summary: string;
  debit: string;
  credit: string;
}

export interface CarryForwardLinesResult {
  lines: CarryForwardLine[];
  /** Σ(费用 − 收入)：< 0 为盈利，> 0 为亏损 */
  profitDelta: number;
  totalDebit: number;
  totalCredit: number;
  balanced: boolean;
}

/**
 * 构造结转凭证分录。
 *
 * @param items 预览算出的待结转损益科目
 * @param profitAccountCode 本年利润科目编码（3131）
 * @param fiscalYear 用于摘要
 */
export function buildCarryForwardLines(
  items: CarryForwardItem[],
  profitAccountCode: string,
  fiscalYear: number
): CarryForwardLinesResult {
  const lines: CarryForwardLine[] = [];
  let profitDelta = 0;

  for (const item of items) {
    const debit = item.carryDirection === 'debit' ? item.carryAmount : 0;
    const credit = item.carryDirection === 'credit' ? item.carryAmount : 0;
    lines.push({
      accountCode: item.accountCode,
      summary: `结转损益 ${item.accountCode} ${item.accountName}`,
      debit: String(debit),
      credit: String(credit),
    });
    profitDelta += credit - debit;
  }
  profitDelta = round2(profitDelta);

  // profitDelta = Σ费用 − Σ收入：
  //   < 0 ⇒ 盈利 ⇒ 本年利润记贷方；> 0 ⇒ 亏损 ⇒ 本年利润记借方。
  lines.push({
    accountCode: profitAccountCode,
    summary: `结转本年利润 ${fiscalYear}`,
    debit: String(profitDelta > 0 ? profitDelta : 0),
    credit: String(profitDelta < 0 ? Math.abs(profitDelta) : 0),
  });

  const totalDebit = round2(
    lines.reduce((sum, line) => sum + Number(line.debit || 0), 0)
  );
  const totalCredit = round2(
    lines.reduce((sum, line) => sum + Number(line.credit || 0), 0)
  );
  return {
    lines,
    profitDelta,
    totalDebit,
    totalCredit,
    balanced: totalDebit === totalCredit,
  };
}
