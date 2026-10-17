/**
 * 企业所得税（CIT）计算规则。
 *
 * ## 为什么需要独立模块
 *
 * 审计报告 §4.7(e) 的结论是：**企业所得税完全未实现** ——
 * `ACCOUNT_INCOME_TAX = '6801'`（所得税费用）在 `account-codes.ts` 里存在，
 * 但**全仓无引用**，利润表第 11 行（所得税费用）与第 12 行（净利润）
 * 的实际取数恒为 0。
 *
 * 后果不是"少一个报表数字"：
 *   · 季度预缴无从计算 —— 而**未按期预缴要加收滞纳金**（《企业所得税法》第五十四条）；
 *   · 年度汇算清缴没有底稿，只能线下用 Excel 算，与账上利润总额脱钩；
 *   · 利润表"净利润"永远等于"利润总额"，管理层看到的盈利是**税前**的。
 *
 * ## 计算框架（《企业所得税法》）
 *
 * ```
 *   应纳税所得额 = 利润总额 + 纳税调增 − 纳税调减 − 弥补以前年度亏损
 *   应纳税额     = 应纳税所得额 × 适用税率 − 减免税额 − 已预缴税额
 * ```
 *
 * 本模块负责**算术**，不负责"哪些项该调增/调减" —— 那是会计判断，
 * 由调用方（底稿/人工）以 `adjustments` 传入，并在结果里逐条列出，
 * 使底稿能说清"这个数是怎么来的"。
 *
 * ## 税率（《企业所得税法》第四条、第二十八条）与小微优惠
 *
 * | 主体 | 法定税率 | 实际税负 |
 * |---|---|---|
 * | 一般企业 | 25% | 25% |
 * | 高新技术企业 | 15% | 15% |
 * | **小型微利企业** | 20% | **5%**（2023-01-01 至 2027-12-31） |
 *
 * ### 小型微利企业口径（财政部 税务总局公告 2023 年第 12 号）
 *
 * 三个条件**同时**满足：
 *   ① 年度应纳税所得额 **≤ 300 万元**；
 *   ② 从业人数 ≤ 300 人；
 *   ③ 资产总额 ≤ 5,000 万元。
 *
 * 优惠内容：**减按 25% 计入应纳税所得额，按 20% 税率**缴纳
 * ⇒ 实际税负 = 25% × 20% = **5%**。
 *
 * ⚠️ **本模块不自己判定"是否小微企业"**。条件 ②③（从业人数、资产总额）
 * 需要主体资料，而 `md_tax_entity` 当前**没有这两个字段**。
 * 若在这里"用行业平均值猜"或"只看应纳税所得额"，会在人数/资产超标时
 * **错误适用 5%** —— 那是实打实的少缴。因此：
 *   · 由调用方按 `md_tax_entity.cit_small_micro`（逐主体人工确认）传入 `smallMicro`；
 *   · 该列为 NULL 时调用方按"不享受优惠"处理（偏严，见 `resolveCitRate`）。
 *
 * ### 与增值税资格（`taxpayer_type`）的关系
 *
 * **两套标准，不得互相代理**（与 `vat-surcharge-eligibility.ts` 同一约定）：
 * "小规模纳税人"是增值税概念，"小型微利企业"是企业所得税概念。
 * 一个小规模纳税人可能是小型微利企业，也可能因人数超标而不是。
 * 因此本模块**只认 `smallMicro` 参数**，绝不从 `taxpayerType` 推导。
 */
import { round2 } from '@server/common/utils/number';

/** 法定税率档位 */
export const CIT_RATES = {
  /** 《企业所得税法》第四条 */
  general: 25,
  /** 《企业所得税法》第二十八条第二款：国家需要重点扶持的高新技术企业 */
  highTech: 15,
  /** 《企业所得税法》第二十八条第一款：小型微利企业 */
  smallMicro: 20,
} as const;

export type CitRateKind = keyof typeof CIT_RATES;

/**
 * 小型微利企业的应纳税所得额上限（万元）。
 *
 * 财政部 税务总局公告 2023 年第 12 号：**300 万元**。
 * 超过则不再是小型微利企业，全额按 25% 计（**不是超额累进** ——
 * 这一点最容易被写错：300 万零 1 元要按 300 万零 1 元 × 25% 全额计税）。
 */
export const CIT_SMALL_MICRO_INCOME_CAP = 3_000_000;

/**
 * 小型微利企业的**实际税负**（百分数）。
 *
 * = 减按 25% 计入应纳税所得额 × 20% 税率 = 5%。
 *
 * 为什么单列这个常量而不是让调用方算 `25 × 20 / 100`：
 * 这个 5% 是**政策结果**而不是"两个税率相乘"，政策一变（如 2022 年曾是
 * "100 万以下 2.5%、100–300 万 5%"两档）就整体改变。
 * 写成一处以减少"把 5% 算成 4%"这类错误。
 */
export const CIT_SMALL_MICRO_EFFECTIVE_RATE = 5;

/**
 * 纳税调整项。
 *
 * 只承载"金额与理由"，不含判断逻辑 —— 判断属于会计政策，不应埋在算术模块里。
 * `direction` 用 `add` / `less` 而不是正负号：负数金额在"调减"语义下
 * 容易写成 `-amount` 导致方向反了，而方向反了会让应纳税所得额差**两倍**该项金额。
 */
export interface CitAdjustment {
  /** 项目名，如「业务招待费超支」「研发费用加计扣除」 */
  name: string;
  /** 调增 `add` / 调减 `less` */
  direction: 'add' | 'less';
  /** 正数金额；方向由 `direction` 决定 */
  amount: number;
  /** 政策依据或说明（底稿要能自证） */
  note?: string;
}

export interface CitInput {
  /** 会计利润总额（取自利润表第 10 行；负数表示亏损） */
  accountingProfit: number;
  /** 纳税调整项（默认空 = 不做调整） */
  adjustments?: CitAdjustment[];
  /**
   * 可弥补的以前年度亏损（正数）。
   *
   * 《企业所得税法》第十八条：结转年限**最长 5 年**。
   * 本参数由调用方按 5 年窗口计算后传入 —— 本模块不查历史账，
   * 也不自己判断哪一年亏损是否还在有效期内。
   */
  lossCarryForward?: number;
  /**
   * 小型微利企业资格：`true` 享受 5% 实际税负。
   *
   * `null` / `undefined` / `false` 一律**不享受**（偏严）。
   * 见文件头论证：不从增值税资格推导，也不自行按 300 万门槛推断 ——
   * 人数与资产总额两个条件本仓没有数据。
   */
  smallMicro?: boolean | null;
  /** 高新技术企业资格（15%）。与小微同时存在时取**孰低**（税负更轻者） */
  highTech?: boolean;
  /** 已预缴税额（季度预缴累计），用于算"本期应补(退)" */
  prepaidTax?: number;
}

export interface CitResult {
  accountingProfit: number;
  /** 调增合计 */
  addedTotal: number;
  /** 调减合计 */
  lessTotal: number;
  /** 调整后所得（未弥补亏损前） */
  adjustedIncome: number;
  /** 实际弥补的亏损额（不超过调整后所得） */
  lossUsed: number;
  /** 应纳税所得额（≥0；亏损时为 0 并给出 carryForward） */
  taxableIncome: number;
  /** 本年度可结转以后年度的亏损（>0 时才有意义） */
  lossCarryForward: number;
  /** 适用档位 */
  rateKind: CitRateKind;
  /** 适用法定税率（百分数） */
  statutoryRate: number;
  /** 实际税负率（百分数）—— 小微为 5%，其余等于法定税率 */
  effectiveRate: number;
  /** 应纳税额（按实际税负率） */
  taxPayable: number;
  /** 已预缴 */
  prepaidTax: number;
  /** 本期应补（正）或应退（负） */
  balanceDue: number;
  /** 逐条可解释说明（底稿/凭证摘要用） */
  notes: string[];
}

/**
 * 计算企业所得税。
 *
 * ## 边界（不得自行扩大）
 *
 * 1. **亏损（调整后所得 ≤ 0）**：应纳税所得额为 0、税额为 0，
 *    并把亏损额作为 `lossCarryForward` 返回以便结转。
 *    **不抛错** —— 亏损是合法经营结果，不是参数错误。
 * 2. **弥补亏损不超过调整后所得**：多传的部分不产生负数所得
 *    （那会变成"政府倒欠企业"，且下一步会算出正税额的负数）。
 * 3. **小微门槛是"全额适用/全额不适用"**，不是超额累进：
 *    应纳税所得额 3,000,001 元时按 25% 全额计税（75 万），
 *    而不是"300 万 × 5% + 1 元 × 25%"。这是本条最容易写错的地方，
 *    规格里有专门的断言。
 * 4. **小微与高新同时具备**：取实际税负更低者（小微 5% < 高新 15%）。
 *    两者不能叠加（小微是"减按 25% 计入 × 20%"，高新是"减按 15%"，
 *    政策未规定可叠加），取孰低是**不会少缴**的安全取法。
 * 5. **`smallMicro` 超门槛时自动降级为一般税率**并记 note ——
 *    这是本模块唯一"自行判断"的地方，因为它只依赖本模块已经算出的
 *    `taxableIncome`（不依赖人数/资产），判断是完备的。
 *    反过来说：**不满足门槛时"降级"是安全的**（少享受优惠 = 多缴），
 *    而"满足门槛但资格列未确认"时不升级也是安全的。
 */
export function computeIncomeTax(input: CitInput): CitResult {
  const notes: string[] = [];
  const accountingProfit = round2(Number(input.accountingProfit ?? 0));

  /* ── ① 纳税调整 ── */
  let addedTotal = 0;
  let lessTotal = 0;
  for (const adj of input.adjustments ?? []) {
    const amount = round2(Math.abs(Number(adj.amount ?? 0)));
    if (amount === 0) continue;
    if (adj.direction === 'add') {
      addedTotal += amount;
      notes.push(`调增「${adj.name}」${amount}${adj.note ? `（${adj.note}）` : ''}`);
    } else {
      lessTotal += amount;
      notes.push(`调减「${adj.name}」${amount}${adj.note ? `（${adj.note}）` : ''}`);
    }
  }
  addedTotal = round2(addedTotal);
  lessTotal = round2(lessTotal);
  const adjustedIncome = round2(accountingProfit + addedTotal - lessTotal);
  notes.push(
    `调整后所得 = 利润总额 ${accountingProfit} + 调增 ${addedTotal} − 调减 ${lessTotal} = ${adjustedIncome}`
  );

  /* ── ② 弥补以前年度亏损 ── */
  if (adjustedIncome <= 0) {
    return {
      accountingProfit,
      addedTotal,
      lessTotal,
      adjustedIncome,
      lossUsed: 0,
      taxableIncome: 0,
      lossCarryForward: round2(-adjustedIncome),
      rateKind: 'general',
      statutoryRate: CIT_RATES.general,
      effectiveRate: CIT_RATES.general,
      taxPayable: 0,
      prepaidTax: round2(Number(input.prepaidTax ?? 0)),
      balanceDue: round2(-Number(input.prepaidTax ?? 0)),
      notes: [
        ...notes,
        `调整后所得为 ${adjustedIncome}（亏损），应纳税所得额为 0、应纳税额为 0；` +
          `可结转以后年度弥补的亏损 ${round2(-adjustedIncome)} 元` +
          `（《企业所得税法》第十八条，结转年限最长 5 年）`,
      ],
    };
  }
  const requestedLoss = round2(Math.max(0, Number(input.lossCarryForward ?? 0)));
  const lossUsed = round2(Math.min(requestedLoss, adjustedIncome));
  if (lossUsed > 0) {
    notes.push(
      `弥补以前年度亏损 ${lossUsed} 元` +
        (requestedLoss > lossUsed
          ? `（申报可弥补 ${requestedLoss} 元，但以调整后所得 ${adjustedIncome} 元为限，余额继续结转）`
          : '')
    );
  }
  const taxableIncome = round2(adjustedIncome - lossUsed);

  /* ── ③ 税率档位 ── */
  const rateKind = resolveCitRateKind({
    taxableIncome,
    smallMicro: input.smallMicro,
    highTech: input.highTech,
    notes,
  });
  const statutoryRate = CIT_RATES[rateKind];
  const effectiveRate =
    rateKind === 'smallMicro'
      ? CIT_SMALL_MICRO_EFFECTIVE_RATE
      : statutoryRate;
  notes.push(
    rateKind === 'smallMicro'
      ? `适用小型微利企业优惠：减按 25% 计入应纳税所得额、按 20% 税率，` +
          `**实际税负 ${CIT_SMALL_MICRO_EFFECTIVE_RATE}%**（财政部 税务总局公告 2023 年第 12 号，执行至 2027-12-31）`
      : `适用税率 ${statutoryRate}%`
  );

  /* ── ④ 税额 ── */
  const taxPayable = round2((taxableIncome * effectiveRate) / 100);
  const prepaidTax = round2(Number(input.prepaidTax ?? 0));
  const balanceDue = round2(taxPayable - prepaidTax);
  if (prepaidTax !== 0) {
    notes.push(
      `已预缴 ${prepaidTax} 元，本期${balanceDue >= 0 ? '应补' : '应退'} ${Math.abs(balanceDue)} 元`
    );
  }

  return {
    accountingProfit,
    addedTotal,
    lessTotal,
    adjustedIncome,
    lossUsed,
    taxableIncome,
    lossCarryForward: 0,
    rateKind,
    statutoryRate,
    effectiveRate,
    taxPayable,
    prepaidTax,
    balanceDue,
    notes,
  };
}

/**
 * 判定适用档位。
 *
 * 抽成独立函数是为了让"小微门槛是全额适用/全额不适用"这条规则
 * 能被单独断言 —— 它是本模块最容易写错的一点。
 */
function resolveCitRateKind(args: {
  taxableIncome: number;
  smallMicro?: boolean | null;
  highTech?: boolean;
  notes: string[];
}): CitRateKind {
  const { taxableIncome, smallMicro, highTech, notes } = args;
  const qualifiesSmallMicro =
    smallMicro === true && taxableIncome <= CIT_SMALL_MICRO_INCOME_CAP;
  if (smallMicro === true && !qualifiesSmallMicro) {
    /*
     * 资格列为 true 但应纳税所得额超标 —— 自动降级并说明。
     *
     * 这个降级是**完备的**：它只依赖本模块已算出的 taxableIncome，
     * 不依赖人数/资产。降级方向是"少享受优惠 = 多缴"，安全。
     */
    notes.push(
      `主体标记为小型微利企业，但应纳税所得额 ${taxableIncome} 元超过 ` +
        `${CIT_SMALL_MICRO_INCOME_CAP} 元门槛，**不再适用小微优惠**，改按 25% 全额计税` +
        `（注意：不是超额累进 —— 超 1 元也按全额 25% 计）`
    );
  }
  if (qualifiesSmallMicro) return 'smallMicro';
  if (highTech === true) return 'highTech';
  return 'general';
}

/**
 * 由主体的企业所得税资格列推导 `smallMicro` 入参。
 *
 * `md_tax_entity.cit_small_micro` 的取值：
 *   · `1` = 已确认符合小型微利企业三项条件 → `true`
 *   · `0` = 已确认不符合 → `false`
 *   · **NULL / 其它 = 未确认** → `false`（**偏严：不享受优惠**）
 *
 * 为什么 NULL 按"不享受"而不是"享受"：
 *   · 按不享受 → 多计提。多缴可以汇算清缴时退，且不会有滞纳金；
 *   · 按享受 → 少计提。少缴要补税 + 按日万分之五滞纳金，
 *     且"以为自己是小微结果不是"是稽查中的常见情形。
 *   两者代价不对称，因此取偏严侧。
 *
 * 与 `vat-surcharge-eligibility.ts` / `stamp-duty.ts` 同一约定：
 * **不从增值税纳税人资格（`taxpayer_type`）推导企业所得税资格** ——
 * 两套标准的判定要件完全不同。
 */
export function resolveCitSmallMicro(
  citSmallMicro?: number | null
): boolean {
  return citSmallMicro === 1;
}
