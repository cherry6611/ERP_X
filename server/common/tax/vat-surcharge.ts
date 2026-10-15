/**
 * 增值税附加税费计算规则（城建税 / 教育费附加 / 地方教育附加）。
 *
 * ## 口径（业务方 2026-10-15 批准，不得自行调整）
 *
 * 1. **城建税率按主体配置、逐主体录入**（7% / 5% / 1% 取决于主体所在地，
 *    代码无法推断，因此本函数**不接受默认值**）；
 * 2. 计税基数 = **应纳增值税额**（与计提口径一致，便于账表勾稽）；
 * 3. 计提时点 = 随增值税同月计提（由调用方保证，本函数只算金额）；
 * 4. 教育费附加 **3%**、地方教育附加 **2%**。
 *
 * ## 两类"0"必须区分开（本模块最核心的设计点）
 *
 * - **合法的 0**：期末留抵或免税导致应纳增值税 ≤ 0 → 附加税确实为 0，
 *   此时返回 `skippedReason`，底稿上可解释；
 * - **要件缺失的 0**：主体没配城建税率 → **不是 0，而是拒绝出数**。
 *
 * 如果第二类也返回 0，结果是附加税漏缴、且账面上完全看不出来 ——
 * 这类"静默按 0 通过"是财税系统最危险的失败模式，因此本函数用
 * `ok: false` 显式阻断，调用方**必须**处理（TS 判别联合会让它很难被忽略）。
 */

/** 城建税率未配置等要件缺失时，拒绝出数的原因 */
export interface VatSurchargeBlocked {
  ok: false;
  /** 面向使用者的拒绝原因（可直接展示） */
  blockedReason: string;
}

export interface VatSurchargeComputed {
  ok: true;
  /** 城建税 */
  urbanMaint: number;
  /** 教育费附加 */
  education: number;
  /** 地方教育附加 */
  localEducation: number;
  /** 合计 = 三个分项之和（见下方取整说明） */
  total: number;
  /** 仅在"合法的 0"时出现，如 期末留抵 / 免税 */
  skippedReason?: string;
  /** 本次实际适用的减免，逐条可解释（底稿要能说清"为什么是这个数"） */
  adjustments: string[];
}

export type VatSurchargeResult = VatSurchargeComputed | VatSurchargeBlocked;

export interface VatSurchargeInput {
  /** 应纳增值税额（已按主体口径算出）；<= 0 表示留抵或免税 */
  payableVat: number;
  /** 城建税率（百分数，如 7 表示 7%）；null = 主体未配置 */
  urbanMaintRate: number | null | undefined;
  /** 教育费附加率，默认 3（百分数） */
  educationRate?: number;
  /** 地方教育附加率，默认 2（百分数） */
  localEducationRate?: number;
  /**
   * 是否适用"六税两费"减半：增值税小规模纳税人 / 小型微利企业 / 个体工商户
   * （财政部 税务总局公告 2023 年第 12 号，2023-01-01 至 2027-12-31，减征 50%）。
   *
   * 注意：**小规模纳税人与本项减半不是一回事**——一个一般纳税人若同时是小型微利企业，
   * 同样适用减半（判定看小微指标，不看纳税人资格）。因此本参数由调用方按主体算出后传入，
   * 而不是在本函数里拿 `taxpayerType` 推断。
   */
  sixTaxTwoFeeHalved?: boolean;
  /**
   * 是否处于小规模免征额度内：月销售额 ≤ 10 万（季 ≤ 30 万）。
   * 依据财税〔2016〕12 号，免征**教育费附加与地方教育附加**，
   * 但**城建税不在免征范围**，仍照征 —— 这两者不能一起免。
   */
  withinSmallScaleExemption?: boolean;
}

/**
 * 分转元：取到分。
 *
 * 取整策略：**逐税种取整，合计由分项相加得出**。若改成"先算合计再取整"，
 * 在基数带小数（如 333.33）时会与分项之和不一致，而凭证上是按分项三行记账的，
 * 合计与分项对不上就是借贷不平。
 */
function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function computeVatSurcharge(input: VatSurchargeInput): VatSurchargeResult {
  const payableVat = Number(input.payableVat ?? 0);
  const educationRate = Number(input.educationRate ?? 3);
  const localEducationRate = Number(input.localEducationRate ?? 2);

  // 要件缺失优先于一切都判断：不能因为基数为 0 就跳过"城建税率未配置"的报错，
  // 否则留抵月份会掩盖配置缺失，等到有税可缴的月份才发现，属于延迟暴露。
  const urbanMaintRate =
    input.urbanMaintRate === null || input.urbanMaintRate === undefined
      ? null
      : Number(input.urbanMaintRate);
  if (urbanMaintRate === null || !Number.isFinite(urbanMaintRate)) {
    return {
      ok: false,
      blockedReason: '主体未配置城建税率，无法计提附加税费（请在主体资料中录入城建税率）',
    };
  }

  // 合法的 0：留抵/免税时附加税确实为 0，但必须带上原因，底稿上可解释
  if (!Number.isFinite(payableVat) || payableVat <= 0) {
    return {
      ok: true,
      urbanMaint: 0,
      education: 0,
      localEducation: 0,
      total: 0,
      skippedReason: '无应纳增值税（期末留抵或免税），附加税费为 0',
      adjustments: [],
    };
  }

  // 顺序很重要：**先免征、再减半**。
  // 月销 10 万以下的小规模，两项附加本身已免征，减半是针对"还要交的那部分"，
  // 若先减半再免征，或两者叠加减 75%，就会少缴。
  const adjustments: string[] = [];
  let educationRaw = (payableVat * educationRate) / 100;
  let localEducationRaw = (payableVat * localEducationRate) / 100;
  let urbanMaintRaw = (payableVat * urbanMaintRate) / 100;

  if (input.withinSmallScaleExemption) {
    educationRaw = 0;
    localEducationRaw = 0;
    adjustments.push(
      '月销售额未超小规模免征额度：免征教育费附加与地方教育附加（城建税不在此免征范围，仍照征）'
    );
  }

  if (input.sixTaxTwoFeeHalved) {
    urbanMaintRaw /= 2;
    educationRaw /= 2;
    localEducationRaw /= 2;
    adjustments.push(
      '六税两费减半：城建税、教育费附加、地方教育附加减征 50%（2023-01-01 至 2027-12-31）'
    );
  }

  const urbanMaint = round2(urbanMaintRaw);
  const education = round2(educationRaw);
  const localEducation = round2(localEducationRaw);

  return {
    ok: true,
    urbanMaint,
    education,
    localEducation,
    // 合计取分项之和：让"借 6403 明细三行"与"合计"在凭证上必然相等
    total: round2(urbanMaint + education + localEducation),
    adjustments,
  };
}
