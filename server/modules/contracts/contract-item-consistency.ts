/**
 * 合同明细与合同头的**三项一致性校验**（从 `contracts.service.ts#assertItemSum` 抽出，§5.9）。
 *
 * ## 为什么三条都要校验
 *
 * 原实现只比较**含税金额合计**，于是可以构造"含税额相等、税额差 6,603.77"的合同：
 *
 * | | 含税额 | 税率 | 不含税 | 税额 |
 * |---|---|---|---|---|
 * | 合同头 | 113,000 | 13% | 100,000 | 13,000 |
 * | 明细行 | 113,000 | 6% | 106,603.77 | **6,396.23** |
 *
 * 后果不是"报表不好看"：项目预算取 `splitTax().net`（不含税额），于是
 * **项目预算凭空多出 6,603.77**；而开票/收入确认/申报都按明细的税率走 ——
 * 同一份合同在系统里有两个"净额"，且**没有任何对账能发现**。
 *
 * ## 为什么容差随行数放大（而不是固定 0.01）
 *
 * 合同头的税额来自 `splitTax(整单含税额, 税率)`，每行税额来自 `splitTax(行含税额, 税率)`
 * —— 同税率、不同基数，逐行取整后 **Σ行税额与头税额天然可能差几分**：
 *
 *   3 × 29.997 元、6% ⇒ 各行税额各 1.70，Σ = 5.10；
 *   而头 `splitTax(89.99, 6)` 的税额 = 5.09，**差 1 分**。
 *
 * 若用固定容差，两个方向都不可接受：
 *   · 太紧 → 把这种**正常差异**判成错误，大量假失败 → 使用者习惯性忽略这道校验；
 *   · 太松 → 掩盖真实的税率错配。
 *
 * 所以容差 = `0.01 × (行数 + 1)`：每行最多贡献 1 分取整差，再留 1 分余量。
 * 被审计点名的真实缺陷（头 113,000@13% vs 明细 113,000@6%）税额差 **6,603.77**，
 * 高出该容差三个数量级，必然被拦住。
 *
 * ## 为什么"金额为 0 的空合同"允许无明细
 *
 * 0 条明细会让"合同金额 100 万、明细为空"的合同生效，收入确认/开票/结算**全部失去依据**，
 * 所以必须拦。但金额同为 0 的空合同（占位/待填）没有这个问题，放行。
 */

import { round2 } from '@server/common/utils/number';

/** 含税金额合计的固定容差：逐行 `splitTax` 与整单 `splitTax` 的取整差最多 1 分 */
export const ITEM_TOTAL_TOLERANCE = 0.01;

/** 逐行取整容差：每行最多贡献 1 分，再留 1 分余量 */
export function itemSumTolerance(itemCount: number): number {
  const n = Number.isFinite(itemCount) && itemCount > 0 ? itemCount : 0;
  return round2(ITEM_TOTAL_TOLERANCE * (n + 1));
}

export interface ItemSumInput {
  /** 合同头含税金额 */
  headerAmount: number | string | null | undefined;
  /** 合同头税额（未提供则跳过税额校验） */
  headerTaxAmount?: number | string | null;
  /** 合同头不含税额（未提供则跳过净额校验） */
  headerNetAmount?: number | string | null;
  /** 当前生效明细行数 */
  itemCount: number;
  /** 明细含税金额合计 */
  totalAmount: number | string | null | undefined;
  /** 明细税额合计 */
  totalTaxAmount?: number | string | null;
  /** 明细不含税金额合计 */
  totalNetAmount?: number | string | null;
}

const num = (v: number | string | null | undefined): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * 返回**问题描述数组**（空数组 = 通过）。
 *
 * 纯函数：不抛异常、不碰数据库，调用方决定怎么呈现（当前实现是拼成
 * `BadRequestException` 抛出，消息必须为可读中文）。
 */
export function checkItemSumConsistency(input: ItemSumInput): string[] {
  const problems: string[] = [];
  const header = num(input.headerAmount);
  const itemCount = Number.isFinite(input.itemCount) ? input.itemCount : 0;

  /* ① 0 明细保护：金额非 0 的合同不允许没有明细 */
  if (itemCount === 0) {
    if (Math.abs(header) > ITEM_TOTAL_TOLERANCE) {
      problems.push('合同至少需要一条明细才能提交/生效，请先在「合同明细」中添加明细行');
    }
    return problems;
  }

  /* ② 含税金额合计（固定 0.01 容差） */
  const total = num(input.totalAmount);
  /*
   * ⚠️ 差值必须过 round2 再比容差。
   * 实测 `|60.02 − 60|` 的浮点结果是 `0.020000000000003` —— 恰好等于容差
   * 却因浮点尾巴被判"超出"。金额比较一律走 round2 是本仓的一贯纪律
   * （见 shared/number.ts 的说明），这里同样适用。
   */
  if (round2(Math.abs(total - header)) > ITEM_TOTAL_TOLERANCE) {
    problems.push(`合同明细合计 ${total} 与合同金额 ${header} 相差超过 ${ITEM_TOTAL_TOLERANCE}`);
  }

  const tolerance = itemSumTolerance(itemCount);

  /* ③ 税额合计（逐行取整容差） */
  if (input.headerTaxAmount !== undefined && input.headerTaxAmount !== null) {
    const headerTax = num(input.headerTaxAmount);
    const taxTotal = num(input.totalTaxAmount);
    if (round2(Math.abs(taxTotal - headerTax)) > tolerance) {
      problems.push(
        `合同明细税额合计 ${taxTotal} 与合同税额 ${headerTax} 相差 ${round2(
          Math.abs(taxTotal - headerTax),
        )}，超出逐行取整的正常范围（容差 ${round2(tolerance)}）：` +
          '明细行使用了与合同头不同的税率。含税金额相同不代表税额相同 —— ' +
          '请在明细中统一税率，或修正合同头税率',
      );
    }
  }

  /* ④ 不含税合计（逐行取整容差） */
  if (input.headerNetAmount !== undefined && input.headerNetAmount !== null) {
    const headerNet = num(input.headerNetAmount);
    const netTotal = num(input.totalNetAmount);
    if (round2(Math.abs(netTotal - headerNet)) > tolerance) {
      problems.push(
        `合同明细不含税合计 ${netTotal} 与合同不含税额 ${headerNet} 相差 ${round2(
          Math.abs(netTotal - headerNet),
        )}，超出逐行取整的正常范围（容差 ${round2(tolerance)}）：` +
          '明细行税率与合同头税率不同。项目预算按不含税额取数，' +
          '两者不一致会让同一份合同出现两个净额',
      );
    }
  }

  return problems;
}
