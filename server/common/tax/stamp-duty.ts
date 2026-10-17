/**
 * 印花税计算规则（《中华人民共和国印花税法》，2022-07-01 施行）。
 *
 * ## 为什么需要独立模块
 *
 * 审计报告 §4.7(f) 的结论是：**印花税完全未实现** ——
 * 全仓（ts/tsx/sql/md）grep「印花税」**零命中**。
 * 这意味着签了 500 万技术合同，系统里既不计提、也不申报、也不进利润表。
 *
 * 印花税的特点是「税率低、漏缴后果重」（滞纳金按日万分之五，
 * 且税务稽查对印花税是常规项），而计算本身是纯乘法 ——
 * 因此实现成本低、收益明确，是本轮补的第二个缺失税种。
 *
 * ## 计税依据（**这是最容易搞错的一点**）
 *
 * 印花税法第五条 + 财政部 税务总局公告 2022 年第 22 号：
 *   · 应税合同的计税依据为**合同所列金额**；
 *   · **不包括列明的增值税税款** —— 即合同若分别列明价款与增值税，
 *     按**不含税金额**计税；若未分别列明（只有一个含税总价），
 *     按**含税金额**计税。
 *
 * 本仓的合同模型**正好分别列明**：`erp_contract.amount`（含税）、
 * `net_amount`（不含税）、`tax_amount`（税额）三列齐备。
 * 因此本函数**优先取 `netAmount`**，而 `netAmount` 缺失（历史数据/未拆税）
 * 时**退化为含税金额** —— 方向是**多缴**，符合"宁可多缴不可少缴"的安全侧。
 *
 * ⚠️ 若将来业务上选择"按含税总价签约、不单独列明增值税"，
 * 则应改传含税额。这个选择必须由业务确认，**不由代码猜**。
 *
 * ## 税率档位（印花税法所附《印花税税目税率表》）
 *
 * | 税目 | 税率 |
 * |---|---|
 * | 借款合同 | 0.05‰ |
 * | 融资租赁合同 | 0.05‰ |
 * | 买卖合同（动产） | 0.3‰ |
 * | **承揽合同** | 0.3‰ |
 * | 建设工程合同 | 0.3‰ |
 * | 运输合同 | 0.3‰ |
 * | **技术合同** | **0.3‰** |
 * | 租赁合同 | 1‰ |
 * | 保管合同 | 1‰ |
 * | 仓储合同 | 1‰ |
 * | 财产保险合同 | 1‰ |
 * | 产权转移书据（股权/土地/房屋等） | 0.5‰ |
 * | 营业账簿（实收资本+资本公积） | 0.25‰ |
 *
 * 数据服务公司的合同属于**技术合同**（技术开发/转让/许可/咨询/服务），
 * 因此本仓默认档位取 `technology` = 0.3‰。
 *
 * ## 减免（可与其它政策叠加的判断留给调用方）
 *
 * 印花税法第十二条：**增值税小规模纳税人**、小型微利企业、个体工商户
 * 可享受「六税两费」减半（财政部 税务总局公告 2023 年第 12 号，
 * 执行至 2027-12-31）。**印花税在六税两费范围内**（六税 = 城建税、
 * 房产税、城镇土地使用税、**印花税**、耕地占用税、资源税），
 * 因此小规模主体同样减半。
 *
 * 与 `vat-surcharge.ts` 同一策略：**先免征、再减半**的顺序无关紧要
 * （印花税没有"额度内免征"这一层），但减半与否必须由调用方按主体判定后传入，
 * 不在本函数里猜 —— 与 `resolveSixTaxTwoFeeHalved` 的分工一致。
 */
import { round2 } from '@server/common/utils/number';

/** 印花税税目（对应《印花税税目税率表》） */
export const STAMP_DUTY_ITEMS = [
  'loan',
  'finance_lease',
  'sales',
  'work',
  'construction',
  'transport',
  'technology',
  'lease',
  'custody',
  'warehouse',
  'property_insurance',
  'property_transfer',
  'capital_book',
] as const;

export type StampDutyItem = (typeof STAMP_DUTY_ITEMS)[number];

/**
 * 税率表（**千分比**，与《印花税税目税率表》的原表口径一致）。
 *
 * 用千分比而不是小数，是为了让"0.3‰"这种档位在代码里就是 `0.3` ——
 * 写成小数会得到 `0.0003`，而少写一个 0 就是 10 倍误差。
 * 千分比 + 本文件的档位校验（只允许表内取值）让这类笔误无法静默通过。
 */
export const STAMP_DUTY_RATES: Record<StampDutyItem, number> = {
  loan: 0.05,
  finance_lease: 0.05,
  sales: 0.3,
  work: 0.3,
  construction: 0.3,
  transport: 0.3,
  technology: 0.3,
  lease: 1,
  custody: 1,
  warehouse: 1,
  property_insurance: 1,
  property_transfer: 0.5,
  capital_book: 0.25,
};

/** 档位中文名（用于凭证摘要与申报表，避免界面上出现英文 key） */
export const STAMP_DUTY_ITEM_LABELS: Record<StampDutyItem, string> = {
  loan: '借款合同',
  finance_lease: '融资租赁合同',
  sales: '买卖合同',
  work: '承揽合同',
  construction: '建设工程合同',
  transport: '运输合同',
  technology: '技术合同',
  lease: '租赁合同',
  custody: '保管合同',
  warehouse: '仓储合同',
  property_insurance: '财产保险合同',
  property_transfer: '产权转移书据',
  capital_book: '营业账簿',
};

/** 本仓业务默认档位：数据服务合同属技术合同 */
export const DEFAULT_STAMP_DUTY_ITEM: StampDutyItem = 'technology';

export interface StampDutyInput {
  /** 合同含税金额（`erp_contract.amount`） */
  amount: number;
  /**
   * 合同不含税金额（`erp_contract.net_amount`）。
   *
   * 印花税法 + 2022 年第 22 号公告：合同**分别列明**价款的，
   * 按不含税金额计税。本仓合同模型分别列明，因此优先用它。
   * 传 null/undefined 表示未拆税（历史数据）→ 退化为含税金额（偏严，多缴）。
   */
  netAmount?: number | null;
  /** 税目；缺省为技术合同 */
  item?: StampDutyItem;
  /** 是否适用「六税两费」减半（由调用方按主体判定后传入，不在此猜） */
  halved?: boolean;
}

export interface StampDutyResult {
  item: StampDutyItem;
  /** 实际采用的税率（千分比） */
  rate: number;
  /** 实际采用的计税依据 */
  base: number;
  /** 计税依据是否取自不含税金额（false = 含税，属偏严方向） */
  baseIsNet: boolean;
  /** 减半前的应纳税额 */
  grossTax: number;
  /** 应纳税额（考虑减半后） */
  tax: number;
  /** 逐条可解释的说明（底稿/凭证摘要要能说清"为什么是这个数"） */
  notes: string[];
}

/** 印花税应纳税额**不足 1 角**的按 0 计（印花税法第十一条） */
const MIN_TAXABLE = 0.1;

/**
 * 计算印花税应纳税额。
 *
 * ## 边界（不得自行扩大）
 *
 * 1. **未知税目** → 抛错而不是回退默认档位。静默回退会让一个拼错的税目
 *    按技术合同 0.3‰ 计税，而正确档位可能是 1‰ —— 少缴 70%。
 *    "看起来能跑"的静默兜底在税种计算里是最危险的写法。
 * 2. **金额 ≤ 0** → 返回 0 税额并说明原因，不抛错：0 元合同是合法业务事实
 *    （框架协议、补充协议），不是参数错误。
 * 3. **不足 1 角** → 按印花税法第十一条**不计**。这是法定规则，
 *    不是取整习惯；把它当成"四舍五入"会让小额合同被多征。
 */
export function computeStampDuty(input: StampDutyInput): StampDutyResult {
  const item = input.item ?? DEFAULT_STAMP_DUTY_ITEM;
  if (!STAMP_DUTY_ITEMS.includes(item)) {
    throw new Error(
      `未知的印花税税目：${String(item)}。` +
        `允许值：${STAMP_DUTY_ITEMS.join(' / ')}（见《印花税税目税率表》）`
    );
  }
  const rate = STAMP_DUTY_RATES[item];
  const notes: string[] = [`税目「${STAMP_DUTY_ITEM_LABELS[item]}」，税率 ${rate}‰`];

  const amount = Number(input.amount ?? 0);
  const net = input.netAmount === null || input.netAmount === undefined
    ? null
    : Number(input.netAmount);

  if (!Number.isFinite(amount) || amount <= 0) {
    return {
      item,
      rate,
      base: 0,
      baseIsNet: net !== null && net > 0,
      grossTax: 0,
      tax: 0,
      notes: [...notes, '合同金额为 0（框架/补充协议等），应纳税额为 0'],
    };
  }

  /*
   * 计税依据选择（见文件头论证）：
   *   优先 net_amount（合同分别列明增值税 → 按不含税计税）；
   *   缺失时退化为含税额 —— 方向是多缴，安全侧。
   */
  const useNet = net !== null && Number.isFinite(net) && net > 0;
  const base = round2(useNet ? net : amount);
  notes.push(
    useNet
      ? '计税依据取合同不含税金额（合同已分别列明增值税，依 2022 年第 22 号公告按不含税计税）'
      : '合同未单独列明增值税额，计税依据取含税金额（偏严方向：多缴而非少缴）'
  );

  const grossTax = round2((base * rate) / 1000);
  let tax = grossTax;
  if (input.halved) {
    tax = round2(tax / 2);
    notes.push(
      '六税两费减半：增值税小规模纳税人 / 小型微利企业 / 个体工商户减征 50%（2023 年第 12 号，执行至 2027-12-31）'
    );
  }
  if (tax < MIN_TAXABLE) {
    notes.push(
      `应纳税额 ${tax} 元不足 1 角，按《印花税法》第十一条不计（应纳税额为零）`
    );
    tax = 0;
  }

  return { item, rate, base, baseIsNet: useNet, grossTax, tax, notes };
}

/**
 * 由主体的增值税纳税人资格推导是否适用「六税两费」减半。
 *
 * 与 `vat-surcharge-eligibility.ts` 的 `resolveSixTaxTwoFeeHalved` **同一口径**：
 * 只按小规模纳税人判定（数据齐备、安全）；一般纳税人若同时是小微企业也适用，
 * 但需要三项指标，当前主体资料没有 → 返回 false（偏严，多缴）。
 *
 * 有意在此**重写一份而不是 import 那个函数**：那个在 `modules/finance-reports`，
 * 从 `common/tax` 反向依赖模块层会造成 `common → modules` 的循环倾向。
 * 两处都只是 `taxpayerType === 'small'` 一行，且各自的 spec 都钉了边界；
 * 真正需要统一时应当把判定提到 `common` 层，那是一次独立的搬迁。
 */
export function resolveStampDutyHalved(taxpayerType?: string | null): boolean {
  return taxpayerType === 'small';
}
