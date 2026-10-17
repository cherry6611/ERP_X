import {
  BadRequestException,
  Inject,
  Injectable,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { finVatDeclaration, mdTaxEntity } from '@server/database/schema';
import {
  ACCOUNT_VAT_INPUT,
  ACCOUNT_VAT_OUTPUT,
} from '@server/common/tax/account-codes';
import {
  computeVatSurcharge,
  type VatSurchargeResult,
} from '@server/common/tax/vat-surcharge';
import { vatSurchargeAccrualLines } from '@server/common/tax/vat-surcharge-posting';
import { vatTransferOutLines } from '@server/common/tax/vat-transfer-posting';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import { resolveSixTaxTwoFeeHalved } from './vat-surcharge-eligibility';
import { LedgersService, previousPeriod } from './ledgers.service';
import { unbilledRevenueNet } from './vat-unbilled';
import { round2 } from '@server/common/utils/number';
import type {
  ConfirmVatDeclarationDto,
  VatDeclarationLine,
  VatDeclarationResult,
} from '@shared/api.interface';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * T-S3：期间最后一天（转出未交增值税是**月末结转**分录，日期取月末）。
 *
 * 为什么不用 `todayInShanghai()`：确认申报可能发生在次月申报期内
 * （如 11 月确认 10 月申报），按当天日期会把 10 月的结转分录记到 11 月，
 * 两个期间的 2221 发生额都会错。期间与凭证日期必须同源，都取 `period`。
 */
function lastDayOfPeriod(period: string): string {
  const [year, month] = period.split('-').map(Number);
  // Date.UTC(year, month, 0) = month 的最后一天（month 为 1 基，0 即上月末）
  const lastDate = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(lastDate).padStart(2, '0')}`;
}


function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

const NULL_ENTITY = '00000000-0000-0000-0000-000000000000';

/**
 * 未指定纳税主体时的阻断文案。
 *
 * 附加税费（城建税 7%/5%/1%、教育费附加、地方教育附加）**必须按纳税主体逐户计提**，
 * 城建税率取决于主体所在地，跨主体无法合并计算。因此不传 `taxEntityId`（"全部主体"）
 * 时 `entityRows` 为空 → 城建税率取不到 → `computeVatSurcharge` 必然 blocked。
 *
 * 阻断本身是对的（拒绝出数，不是静默按 0，不会漏缴），但原因**不是**"主体没配税率"，
 * 而是"根本没选主体"。两者必须分开说：写成前者会让用户去翻主体配置，而那里什么毛病都没有。
 */
const NO_ENTITY_SURCHARGE_REASON =
  '未指定纳税主体：附加税费须按纳税主体逐户计提，请先选择具体纳税主体后再确认';
const NO_ENTITY_SURCHARGE_LABEL = '未指定纳税主体，附加税费无法按主体计提';

/** 附加税费计提所需的主体字段（md_tax_entity） */
type TaxEntityRow = {
  name: string;
  urbanMaintRate: string | null;
  /** 增值税纳税人资格：'general' | 'small'（schema.ts:2625 CHECK 约束） */
  taxpayerType: string | null;
  /** T9：申报周期 'monthly' | 'quarterly' | null（null = 未声明，不做免征判定） */
  vatFilingCycle: string | null;
  /** T9：是否启用免征额度判定（0 = 一律不免征） */
  vatExemptionEnabled: number | null;
};

/**
 * T9：小规模纳税人免征额度（财税〔2016〕12 号）。
 *
 * - 按月申报：月销售额（**不含税**）≤ 10 万；
 * - 按季申报：季度销售额 ≤ 30 万。
 *
 * 额度内**免征教育费附加与地方教育附加**，但**城建税不在免征范围**，仍照征
 * —— 这两者不能一起免，`vat-surcharge.ts` 已按此实现（先免征、再减半）。
 */
const SMALL_SCALE_MONTHLY_EXEMPTION = 100_000;
const SMALL_SCALE_QUARTERLY_EXEMPTION = 300_000;

/** T9 判定结果：三态（额度内 / 额度外 / 无法判定） */
type SmallScaleExemption =
  | { kind: 'within' }
  | { kind: 'beyond' }
  | { kind: 'unknown'; reason: string };

/**
 * A-06：增值税申报底稿。
 *
 * 数据来源：
 *   ① 发票台账 erp_invoice（direction=sales 为销项、purchase 为进项；status='issued' 才计入）；
 *   ② 总账明细科目 222101（销项税额）/ 222102（进项税额）的本期发生额。
 *
 * 口径：本项只做"底稿生成 + 导出 + 勾稽校验"，不做直接申报（属批次二集成项）。
 */
@Injectable()
export class VatDeclarationService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly ledgers: LedgersService,
    private readonly voucherHook: VoucherHookService,
  ) {}

  private assertPeriod(period: string): void {
    if (!PERIOD_PATTERN.test(period)) {
      throw new BadRequestException('期间格式必须为 YYYY-MM');
    }
  }

  /** 发票台账税额（按方向）+ 当期销项不含税销售额 */
  private async invoiceTax(
    period: string,
    taxEntityId?: string
  ): Promise<{
    output: number;
    input: number;
    outputCount: number;
    inputCount: number;
    salesNet: number;
    /**
     * P0-A：本期已登记但**未勾选认证**的进项税额。
     *
     * 这部分税额在账面（222102）里已经入了账，但依法**不得在当期抵扣**
     * （国税发〔2006〕156 号 / 国家税务总局公告 2019 年第 45 号：增值税专用发票
     * 需在勾选确认的所属期申报抵扣）。原实现把 `erp_invoice.tax_amount` 全额计入
     * 可抵扣进项，认证状态只是一个"只写不参与计算"的展示字段 —— 结果是
     * **少缴增值税，而账面全平、报表全平、测试全绿**（示例：销项 6 万 +
     * 一张未认证专票进项 6 万 → 底稿应纳税额 0，法定应纳税额 6 万）。
     */
    uncertifiedInput: number;
    /** 本期未认证进项发票张数（用于文案与勾稽说明） */
    uncertifiedCount: number;
  }> {
    // 不含税销售额取 `net_amount`：`erp_invoice.amount` 是**价税合计（含税）**，
    // 证据链（不是猜的）：
    //   ① shared/tax.ts:33-41 `splitTax` 注释「价税合计拆分…net = amount - tax」；
    //   ② server/common/tax/return-rules.ts:181-188「税额必须用 splitTax(含税额, 税率) 反算」；
    //   ③ invoice.service.ts:261+330-333 开票写入时 amount=价税合计、taxAmount=split.tax、
    //      netAmount=split.net。
    // 因此申报表第 1 行（不含税销售额）必须用 net_amount，不能用 amount。
    // net_amount 是 nullable（历史数据可能未回填），回退用 amount − tax_amount，
    // 再兜底为 0；绝不因为缺列就把含税额当销售额填进去。
    //
    // P0-A：进项税额分两段取数，`input_tax` 只统计**可抵扣**（已认证/已抵扣）的部分。
    // `certification_status` 是 notNull default 'uncertified'，历史数据一律为
    // 'uncertified' —— 即历史未勾选的专票**不会**再被算成可抵扣，方向安全
    // （宁可多缴、不可少缴）。
    const rows = await this.db.execute(sql`
      SELECT
        coalesce(sum(CASE WHEN direction = 'sales' THEN tax_amount ELSE 0 END), 0) AS output_tax,
        coalesce(sum(CASE WHEN direction = 'purchase'
          AND certification_status IN ('certified', 'deducted')
          THEN tax_amount ELSE 0 END), 0) AS input_tax,
        coalesce(sum(CASE WHEN direction = 'purchase'
          AND certification_status NOT IN ('certified', 'deducted')
          THEN tax_amount ELSE 0 END), 0) AS uncertified_input,
        count(*) FILTER (WHERE direction = 'purchase'
          AND certification_status NOT IN ('certified', 'deducted'))::int AS uncertified_count,
        coalesce(sum(CASE WHEN direction = 'sales' THEN coalesce(net_amount, coalesce(amount, 0) - coalesce(tax_amount, 0), 0) ELSE 0 END), 0) AS sales_net,
        count(*) FILTER (WHERE direction = 'sales')::int AS output_count,
        count(*) FILTER (WHERE direction = 'purchase')::int AS input_count
      FROM erp_invoice
      WHERE status = 'issued'
        AND to_char(invoice_date, 'YYYY-MM') = ${period}
        ${taxEntityId ? sql`AND tax_entity_id = ${taxEntityId}::uuid` : sql``}
    `);
    const list = Array.isArray(rows)
      ? (rows as Array<Record<string, unknown>>)
      : ((rows as { rows?: Array<Record<string, unknown>> }).rows ?? []);
    const row = list[0] ?? {};
    return {
      output: round2(toNumber(row.output_tax as string | number)),
      input: round2(toNumber(row.input_tax as string | number)),
      outputCount: Number(row.output_count ?? 0),
      inputCount: Number(row.input_count ?? 0),
      salesNet: round2(toNumber(row.sales_net as string | number)),
      uncertifiedInput: round2(toNumber(row.uncertified_input as string | number)),
      uncertifiedCount: Number(row.uncertified_count ?? 0),
    };
  }

  /**
   * T9：小规模免征额度的**三态**判定（额度内 / 额度外 / 无法判定）。
   *
   * ## 为什么必须允许"无法判定"这一态
   *
   * 原实现**有意不接线**免征额度，理由写在下方长注释里：
   * 「判定涉及月报还是季报的申报口径，若按月度阈值自动判定，在
   *   季度合计 > 30 万但单月 ≤ 10 万时会错误免征 → 少缴，方向不可接受」。
   *
   * 这个判断是对的 —— **要件缺失时不能猜**。但"不减免"的代价是长期**多缴**。
   * 正确的修法不是猜，而是把要件补上（`md_tax_entity.vat_filing_cycle`），
   * 并把"没声明"表达成一个**被披露的状态**（`kind: 'unknown'`），而不是
   * 悄悄按"不减免"处理 —— 那样使用者永远不知道自己是多缴了还是本该如此。
   *
   * ## 季度口径为什么要查整季
   *
   * 按季申报时，免征额度看的是**季度**销售额，而不是本月。`generate()` 是按月
   * 生成的，因此需要按申报周期取"该季度的累计销售额"：
   *   · 按月申报 → 本期（该月）销售额；
   *   · 按季申报 → 该季度所属三个月的销售额合计。
   * 只拿本月销售额去比 30 万，会在"季中两个月 12 万 + 本月 8 万"时错误免征。
   */
  private async resolveSmallScaleExemption(params: {
    period: string;
    taxEntityId?: string;
    taxEntity: TaxEntityRow | undefined;
    /** 本期不含税销售额（发票台账口径） */
    periodSalesNet: number;
  }): Promise<SmallScaleExemption> {
    const entity = params.taxEntity;
    if (!entity || entity.taxpayerType !== 'small') {
      return { kind: 'unknown', reason: '非小规模纳税人，不适用小规模免征额度' };
    }
    if (Number(entity.vatExemptionEnabled ?? 1) === 0) {
      return { kind: 'unknown', reason: '该主体已关闭免征额度判定（vat_exemption_enabled=0）' };
    }
    const cycle = entity.vatFilingCycle;
    if (cycle !== 'monthly' && cycle !== 'quarterly') {
      return {
        kind: 'unknown',
        reason:
          '主体未声明增值税申报周期（md_tax_entity.vat_filing_cycle），' +
          '无法判定免征额度：按月与按季的额度不同，猜错会造成少缴，故不做减免',
      };
    }
    if (cycle === 'monthly') {
      return params.periodSalesNet <= SMALL_SCALE_MONTHLY_EXEMPTION
        ? { kind: 'within' }
        : { kind: 'beyond' };
    }
    // 按季申报：取该季度三个月的销售额合计
    const quarterTotal = await this.quarterSalesNet(
      params.period,
      params.taxEntityId
    );
    return quarterTotal <= SMALL_SCALE_QUARTERLY_EXEMPTION
      ? { kind: 'within' }
      : { kind: 'beyond' };
  }

  /** 按季申报时的季度不含税销售额合计（含本期所在季度的三个月） */
  private async quarterSalesNet(
    period: string,
    taxEntityId?: string
  ): Promise<number> {
    const [yearText, monthText] = period.split('-');
    const year = Number(yearText);
    const month = Number(monthText);
    const quarterStartMonth = Math.floor((month - 1) / 3) * 3 + 1;
    const periods: string[] = [0, 1, 2].map(
      (offset) =>
        `${year}-${String(quarterStartMonth + offset).padStart(2, '0')}`
    );
    const rows = await this.db.execute(sql`
      SELECT coalesce(sum(
        coalesce(net_amount, coalesce(amount, 0) - coalesce(tax_amount, 0), 0)
      ), 0) AS sales_net
      FROM erp_invoice
      WHERE status = 'issued'
        AND direction = 'sales'
        AND to_char(invoice_date, 'YYYY-MM') IN (${sql.join(
          periods.map((p) => sql`${p}`),
          sql`, `
        )})
        ${taxEntityId ? sql`AND tax_entity_id = ${taxEntityId}::uuid` : sql``}
    `);
    const list = Array.isArray(rows)
      ? (rows as Array<Record<string, unknown>>)
      : ((rows as { rows?: Array<Record<string, unknown>> }).rows ?? []);
    return round2(toNumber(list[0]?.sales_net as string | number));
  }

  /**
   * T8：**未开票收入**（已确认收入但未开票）的本期不含税额与税额。
   *
   * ## 为什么要接进底稿
   *
   * 底稿的销项原先 **100% 来自发票台账**，于是"已收款未开票"的部分
   * **零申报** —— 这是明确的少缴增值税。系统里其实已有未开票台账
   * （`revenues.listUnbilled`），只是底稿没用它。
   *
   * ## 口径（**需财务确认**，但方向安全）
   *
   * 按纳税义务发生时间，**收入确认**即为纳税义务发生（服务已提供、款项可收）。
   * 因此未开票收入应当申报。这里取：
   *
   *   未开票收入不含税额 = Σ(本期已确认收入净额) − Σ(本期已开销项发票净额)
   *
   * 与 `revenues.listUnbilled` 的差异：那里是**项目维度、累计口径**（供业务看
   * "还有多少没开票"）；这里是**期间维度**（供申报）。两者用途不同，不可互相替代。
   *
   * 负值时**不冲减**销项（返回 0 并在差异区提示）：负数通常意味着"以前期间确认的
   * 收入在本期开票"，那部分已在上期申报过，本期再冲减会**少缴**。
   */
  /**
   * T10：**必须按纳税主体取数**。
   *
   * 原实现只按期间取数，签名里没有 `taxEntityId` —— 而底稿是**按主体逐户**生成、
   * 逐户确认申报的（`confirm()` 以 `period + tax_entity_id` 为幂等键，
   * 附加税费也必须逐户计提）。于是一笔未开票收入会**同时**出现在每个主体的
   * 底稿第 1 行销售额里：走查实测两个主体的第 1-1 行都是 33600，
   * 而库里本期已确认收入净额只有 63600（其中已开票 30000）。
   * 后果是各主体申报销售额虚增（并可能把小规模主体误推出免征额度）。
   *
   * 归属口径与发票侧**逐字一致**：`erp_invoice` 用 `tax_entity_id` 过滤；
   * `erp_project_revenue` 自身没有主体列，经 `contract_id` 取合同的 `tax_entity_id`
   * （收入确认必然挂在合同上）。合同主体为 NULL 的收入行因此不进入任何主体的
   * 小计 —— 这与发票侧的处置相同（发票 `tax_entity_id` 为 NULL 时同样不进入
   * 任何主体），**且不静默丢弃**：差额由 `revenue_excluded_other_entity` 披露。
   */
  private async unbilledRevenueTax(
    period: string,
    taxEntityId?: string
  ): Promise<{
    net: number;
    tax: number;
    revenueNet: number;
    invoicedNet: number;
    /** 因主体归属被排除在外的本期已确认收入（用于差异披露，不参与计算） */
    excludedRevenue: number;
  }> {
    const rows = await this.db.execute(sql`
      SELECT
        coalesce((
          SELECT sum(
            CASE
              WHEN coalesce(c.tax_rate, 0) <= 0 THEN r.amount
              ELSE r.amount * 100 / (100 + c.tax_rate)
            END
          )
          FROM erp_project_revenue r
          LEFT JOIN erp_contract c ON c.id = r.contract_id
          WHERE r.status = 'recognized'
            AND r.period = ${period}
            AND NOT EXISTS (
              SELECT 1 FROM erp_revenue_adjust a
              WHERE a.revenue_id = r.id AND a.status = 'applied'
            )
            ${taxEntityId ? sql`AND c.tax_entity_id = ${taxEntityId}::uuid` : sql``}
        ), 0) AS revenue_net,
        coalesce((
          SELECT sum(
            CASE
              WHEN coalesce(c.tax_rate, 0) <= 0 THEN r.amount
              ELSE r.amount * 100 / (100 + c.tax_rate)
            END
          )
          FROM erp_project_revenue r
          LEFT JOIN erp_contract c ON c.id = r.contract_id
          WHERE r.status = 'recognized'
            AND r.period = ${period}
            AND NOT EXISTS (
              SELECT 1 FROM erp_revenue_adjust a
              WHERE a.revenue_id = r.id AND a.status = 'applied'
            )
        ), 0) AS revenue_net_all,
        coalesce((
          SELECT sum(coalesce(i.net_amount, coalesce(i.amount, 0) - coalesce(i.tax_amount, 0), 0))
          FROM erp_invoice i
          WHERE i.status = 'issued'
            AND i.direction = 'sales'
            AND to_char(i.invoice_date, 'YYYY-MM') = ${period}
            ${taxEntityId ? sql`AND i.tax_entity_id = ${taxEntityId}::uuid` : sql``}
        ), 0) AS invoiced_net
    `);
    const list = Array.isArray(rows)
      ? (rows as Array<Record<string, unknown>>)
      : ((rows as { rows?: Array<Record<string, unknown>> }).rows ?? []);
    const row = list[0] ?? {};
    const revenueNet = round2(toNumber(row.revenue_net as string | number));
    const revenueNetAll = round2(toNumber(row.revenue_net_all as string | number));
    const invoicedNet = round2(toNumber(row.invoiced_net as string | number));
    /*
     * 口径必须统一为**不含税**：
     *   · erp_project_revenue.amount 是含税价税合计（收入确认分录借 1122 = amount）；
     *   · erp_invoice.net_amount 是不含税。
     * 原实现直接 `含税收入 - 不含税已开票`，全额开票也会凭空产生"未开票收入"
     * （其金额恰好等于税额），并让第 1 行销售额虚增。
     * 这里按收入所属合同的税率逐笔反算净额，再与已开票净额比较。
     */
    const net = unbilledRevenueNet(revenueNet, invoicedNet);
    return {
      net,
      tax: 0,
      revenueNet,
      invoicedNet,
      excludedRevenue: round2(Math.max(revenueNetAll - revenueNet, 0)),
    };
  }

  /**
   * 总账增值税明细科目发生额。
   *
   * `outputPosted` / `inputPosted` 表示该科目**本期是否有实际过账**（发生额非 0）。
   * 这个标志决定应纳税额取哪一侧的数，是下面"同一笔进项不得既在本期抵、
   * 又在上期留抵里再抵一次"的关键，不能省。
   *
   * T5（P1-1）：自动凭证（`voucher-hook.service.ts:152`）一律落 `status='draft'`，
   * 而底稿原先只读 `posted` → **未过账月份的总账口径恒为 0**，`inputPosted` 恒为
   * false —— 这正是 P0-B「上期留抵被丢弃」的实际触发条件，而 `closePeriod` 又要求
   * 全部过账，所以"底稿生成时尚未过账"是**常态而非例外**。
   *
   * 因此这里改为按「已过账 + 草稿」取数（`includeDraft: true`）：底稿是**申报前的
   * 预览**，必须能看见已生成但尚未过账的凭证，否则它永远看不到本月的进项。
   * 已作废凭证（`status='voided'`）仍被 `statusCondition` 排除在外，
   * 不会因"已作废凭证不代表本业务已出凭证"这条既有幂等约定而被重复计入。
   */
  private async ledgerTax(
    period: string,
    taxEntityId?: string
  ): Promise<{
    output: number;
    input: number;
    outputPosted: boolean;
    inputPosted: boolean;
  }> {
    const rolled = await this.ledgers.rolledBalances(period, {
      taxEntityId,
      includeDraft: true,
    });
    const output = rolled.get(ACCOUNT_VAT_OUTPUT);
    const input = rolled.get(ACCOUNT_VAT_INPUT);
    // 销项税额在贷方，进项税额在借方
    const outputNet = round2(
      (output?.creditOccur ?? 0) - (output?.debitOccur ?? 0)
    );
    const inputNet = round2(
      (input?.debitOccur ?? 0) - (input?.creditOccur ?? 0)
    );
    return {
      output: outputNet,
      input: inputNet,
      outputPosted: outputNet !== 0,
      inputPosted: inputNet !== 0,
    };
  }

  /** 上期期末留抵（222102 借方余额 − 222101 贷方余额，为正即留抵） */
  private async previousCredit(
    period: string,
    taxEntityId?: string
  ): Promise<number> {
    const prev = previousPeriod(period);
    const rolled = await this.ledgers.rolledBalances(prev, {
      taxEntityId,
      includeDraft: true,
    });
    const input = rolled.get(ACCOUNT_VAT_INPUT);
    const output = rolled.get(ACCOUNT_VAT_OUTPUT);
    const inputNet = round2(
      (input?.closingDebit ?? 0) - (input?.closingCredit ?? 0)
    );
    const outputNet = round2(
      (output?.closingCredit ?? 0) - (output?.closingDebit ?? 0)
    );
    return round2(Math.max(inputNet - outputNet, 0));
  }

  /**
   * P0-B：**上期已确认**底稿的期末留抵 —— 留抵结转的权威来源。
   *
   * ## 为什么不能只看总账
   *
   * 原实现用 `ledger.inputPosted ? previousCredit : 0`，即"本期总账没有进项过账
   * 就把上期留抵整个丢掉"。作者的本意是防重复抵扣（一张 10 月开票、11 月勾选认证
   * 的发票会同时出现在"11 月按开票日期归期的发票数"与"上期留抵"里，被抵两次），
   * 这个担忧是对的；但**为了防重复而丢弃留抵**的代价是系统性多缴：
   *
   *   9 月：进项 6,000，销项 0 → 留抵 6,000
   *   10 月：销项 600，无采购（或采购凭证尚未生成）
   *   系统底稿应纳税额 = 600（法定为 0）→ **多缴 600**，且账面上看不出任何异常。
   *
   * ## 权威来源为什么是"上期已确认底稿"
   *
   * `fin_vat_declaration.closing_credit` 在 `confirm()` 时写入，是**已申报的**
   * 期末留抵。它不依赖总账过账状态，也不受"本期是否有进项凭证"影响 ——
   * 恰恰是防重复抵扣所需的那把"已用过"的标记：
   *   · 上期留抵里的进项，其**抵扣权已在上期用掉**（或结转下来），
   *     与本期按开票日期归期的数不会重复；
   *   · 若上期未确认底稿，才回退到总账推算，并在 `differences` 里显式披露
   *     `previous_credit_source = ledger_estimate`，让财务知道这个数是估的。
   */
  private async previousCreditFromDeclaration(
    period: string,
    taxEntityId?: string
  ): Promise<number | null> {
    const rows = await this.db
      .select({
        closingCredit: finVatDeclaration.closingCredit,
        status: finVatDeclaration.status,
      })
      .from(finVatDeclaration)
      .where(
        and(
          eq(finVatDeclaration.period, previousPeriod(period)),
          taxEntityId
            ? eq(finVatDeclaration.taxEntityId, taxEntityId)
            : sql`${finVatDeclaration.taxEntityId} IS NULL`
        )
      )
      .limit(1);
    const row = rows[0];
    if (!row || row.status !== 'confirmed') return null;
    return round2(toNumber(row.closingCredit));
  }

  async generate(params: {
    period: string;
    taxEntityId?: string;
    userId?: string;
  }): Promise<VatDeclarationResult> {
    this.assertPeriod(params.period);
    const [
      invoice,
      ledger,
      ledgerPreviousCredit,
      confirmedPreviousCredit,
      entityRows,
      saved,
    ] = await Promise.all([
      this.invoiceTax(params.period, params.taxEntityId),
      this.ledgerTax(params.period, params.taxEntityId),
      this.previousCredit(params.period, params.taxEntityId),
      this.previousCreditFromDeclaration(params.period, params.taxEntityId),
      params.taxEntityId
        ? this.db
            .select({
              name: mdTaxEntity.name,
              urbanMaintRate: mdTaxEntity.urbanMaintRate,
              // 增值税纳税人资格（general / small）。注意这是**增值税资格**概念，
              // 与企业所得税「小型微利企业」是两套标准，不能互相代理。
              taxpayerType: mdTaxEntity.taxpayerType,
              // T9：申报周期与免征开关（免征额度判定的必要要件，未声明则不做减免）
              vatFilingCycle: mdTaxEntity.vatFilingCycle,
              vatExemptionEnabled: mdTaxEntity.vatExemptionEnabled,
            })
            .from(mdTaxEntity)
            .where(eq(mdTaxEntity.id, params.taxEntityId))
            .limit(1)
        : Promise.resolve([] as TaxEntityRow[]),
      this.db
        .select()
        .from(finVatDeclaration)
        .where(
          and(
            eq(finVatDeclaration.period, params.period),
            params.taxEntityId
              ? eq(finVatDeclaration.taxEntityId, params.taxEntityId)
              : sql`${finVatDeclaration.taxEntityId} IS NULL`
          )
        )
        .limit(1),
    ]);

    // P0-B：上期留抵的权威来源是**上期已确认底稿**的 closing_credit。
    // 只有上期未确认时才回退到总账推算，并打上来源标记供差异区披露。
    const previousCreditSource: 'confirmed_declaration' | 'ledger_estimate' =
      confirmedPreviousCredit !== null
        ? 'confirmed_declaration'
        : 'ledger_estimate';
    const previousCredit: number =
      confirmedPreviousCredit ?? ledgerPreviousCredit;

    const outputDifference = round2(invoice.output - ledger.output);
    const inputDifference = round2(invoice.input - ledger.input);
    // T-S2：小规模纳税人采用**征收率**计税，没有进项抵扣权，也不存在留抵概念。
    // 若沿用一般纳税人口径「销项 − 进项 − 上期留抵」计算应纳税额，
    // 只要台账里登记过进项发票就会直接少缴增值税（且账面看不出异常）。
    // 因此小规模主体的可抵进项与上期留抵一律按 0 计入应纳税额；
    // 台账/总账中的进项税额仍原样展示（登记备查），并在差异区显式披露。
    const isSmallScale = entityRows[0]?.taxpayerType === 'small';

    // ── 计税基数的唯一性（本段是底稿最容易算错的地方，改动前请先读完）────────────
    //
    // 进项税额在本服务里有**三个**看似都能用的数，且它们描述的是同一笔税：
    //   ① 发票台账本期数 `invoice.input`（按开票日期归期，**且仅统计已勾选认证的**）；
    //   ② 总账 222102 本期发生额 `ledger.input`（进货发票过账时借方发生）；
    //   ③ 上期期末留抵 `previousCredit`（上期已确认底稿的 closing_credit，回退总账）。
    //
    // 进货发票在 `invoice.service.ts` 开票时即生成凭证（借 222102 进项税），
    // 所以一张 10 月开票、11 月才勾选抵扣的进货发票会**同时**出现在：
    //   · 10 月：② 222102 借方发生额 +1000 → 若 10 月未抵完，则成为 11 月的 ③；
    //   · 11 月：① 按开票日期（10-25）归到 10 月，但抬头勾选期为 11 月。
    // 若沿用旧口径「应纳税额 = ①销项 − ①进项 − ③上期留抵」，这笔进项会被**抵扣两次**
    // （一次在 11 月的 ①，一次在 11 月的 ③ 里），应纳税额凭空变小 = **少缴增值税**，
    // 且借贷仍然平、报表仍然平 —— 账面上完全看不出来。
    //
    // 因此这里钉死「同一笔进项只能在本期或上期其中一侧抵」：
    //   · 本期 222102 **有**过账（`ledger.inputPosted`）→ 本期抵的就是总账数，
    //     再叠加上期留抵是安全的（上期留抵 = 上期结转的未抵完部分，与本期发生额不重叠）；
    //   · 本期 222102 **无**过账（凭证未生成/失败，或主体尚未启用凭证）→ 退化为按发票
    //     台账预览。
    //
    // ⚠️ P0-B 修正：**无论走哪一侧，上期留抵都必须计入**。
    // 原实现在"本期无过账"时把 `effectivePreviousCredit` 强制置 0，理由是防重复抵扣；
    // 但重复抵扣的真实来源是"按开票日期归期的发票数"与"上期留抵"重叠，而
    // ① 现在只统计**已勾选认证**的票，② ③ 取自**上期已确认底稿**（那笔进项的
    // 抵扣权已在上期用掉）—— 两侧都已不可能重复，再丢弃留抵只剩下"系统性多缴"。
    // 若上期未确认底稿（previousCreditSource = 'ledger_estimate'），
    // 总账推算值仍可能与本期发票数重叠，此时保守起见按**较小者**计入：
    // 少抵一点是多缴（可退/可留抵），多抵一点是少缴（不可逆）。
    const creditableInput = isSmallScale
      ? 0
      : ledger.inputPosted
        ? ledger.input
        : invoice.input;
    /*
     * 第 12 行的**行内差异**必须与"该行显示的两侧"同源。
     *
     * ⚠️ 2026-10-17 修：原先行 12 的 amount 取 creditableInput（账簿有已过账进项时
     * **等于** ledger.input），而 difference 取 inputDifference（= invoice.input − ledger.input）。
     * 于是"账簿有进项、发票侧为 0"时，界面会显示
     *   申报数 3878.75 / 账簿数 3878.75 / **差异 -3878.75 · 未解释**
     * —— 两侧明明相等却亮红灯，属**自相矛盾的自查结果**（使用者会以为系统坏了）。
     *
     * 行 11（销项）本就自洽：amount = invoice.output、difference = invoice.output − ledger.output。
     * 现在行 12 也满足同一不变量：difference === amount − ledgerAmount。
     *
     * 注意："发票台账与账簿不符"这个信号**没有丢** —— 它仍由 inputDifference
     * 在响应顶层 differences（code = input_mismatch）与第 25 行「待认证进项税额」披露；
     * 行内差异只表示"这一行显示的两个数是否一致"。
     */
    const creditableInputDifference = round2(creditableInput - ledger.input);
    const effectivePreviousCredit = isSmallScale
      ? 0
      : previousCreditSource === 'confirmed_declaration'
        ? previousCredit
        : Math.min(previousCredit, round2(Math.max(invoice.input, ledger.input)));
    const payableRaw = round2(
      invoice.output - creditableInput - effectivePreviousCredit
    );
    const payableTax = round2(Math.max(payableRaw, 0));
    const closingCredit = round2(Math.max(-payableRaw, 0));

    // 附加税费：计提基数就是本期的应纳税额 payableTax（与计提口径一致，便于账表勾稽）。
    //
    // `sixTaxTwoFeeHalved`（“六税两费”减半）的接线依据：
    //   财政部 税务总局公告 2023 年第 12 号（2023-01-01 至 2027-12-31）规定，对
    //   **增值税小规模纳税人 / 小型微利企业 / 个体工商户**减半征收城建税、教育费附加、
    //   地方教育附加。三类主体**任居其一**即适用，因此：
    //   ① 小规模纳税人身份由 `md_tax_entity.taxpayer_type` 直接判定（'small'），
    //      不需要任何小微指标 → 数据齐备，直接接线，安全；
    //   ② 一般纳税人若同时是**小型微利企业**也适用减半，但那要按「应纳税所得额 /
    //      从业人数 / 资产总额」三项指标判定，当前主体资料没有这些数据 → 保持不减半。
    //      这是有意的**偏严（多计提）**方向，不会造成漏缴；待指标数据源补齐后再接线，
    //      不得在此猜测。
    //   ③ `taxpayer_type`（增值税资格）与企业所得税「小型微利企业」是两套标准，
    //      不得互相代理，所以只按 ① 接线。
    //   ④ 未指定主体（entityRows 为空）时按 false 处理 —— 不猜。
    //
    // 仍然**有意不接线** `withinSmallScaleExemption`（小规模月销 ≤10 万 / 季 ≤30 万
    // 免征教育费附加与地方教育附加）：判定涉及「月报还是季报」的申报口径，若按月度
    // 阈值自动判定，在「季度合计 > 30 万但单月 ≤ 10 万」时会错误免征 → **少缴/漏缴**，
    // 方向不可接受。保持不减免（偏严），已作为遗留待定项记录在交付文档中。
    //
    // ── T9 修正（2026-10-16）────────────────────────────────────────────────
    // 上面这个判断是对的 —— **要件缺失时不能猜**。但"不减免"的代价是长期**多缴**。
    // 正确的修法不是猜，而是**把缺失的要件补上**：`md_tax_entity.vat_filing_cycle`
    // 让主体声明申报周期（按月 10 万 / 按季 30 万），声明了才接线；
    // 未声明则维持偏严（不减免）**并显式披露原因**，而不是让使用者永远不知道
    // 自己是多缴了还是本该如此。
    const exemption = await this.resolveSmallScaleExemption({
      period: params.period,
      taxEntityId: params.taxEntityId,
      taxEntity: entityRows[0],
      periodSalesNet: invoice.salesNet,
    });
    const surchargeBase = computeVatSurcharge({
      payableVat: payableTax,
      urbanMaintRate:
        entityRows[0]?.urbanMaintRate == null
          ? null
          : Number(entityRows[0].urbanMaintRate),
      sixTaxTwoFeeHalved: resolveSixTaxTwoFeeHalved(entityRows[0]?.taxpayerType),
      // 只有明确判定为"额度内"才免征；'unknown' 一律不免征（偏严方向）
      withinSmallScaleExemption: exemption.kind === 'within',
    });
    // 未指定主体时 `entityRows` 恒为空 → 城建税率取不到 → 上式必然 blocked。
    // 这里只**替换原因文案**，不推翻阻断本身（拒绝出数，方向安全）。
    const surcharge: VatSurchargeResult =
      !surchargeBase.ok && !params.taxEntityId
        ? { ...surchargeBase, blockedReason: NO_ENTITY_SURCHARGE_REASON }
        : surchargeBase;

    // T8：未开票收入（已确认收入 − 本期已开销项发票净额）
    const unbilled = await this.unbilledRevenueTax(params.period, params.taxEntityId);
    const totalSalesNet = round2(
      (invoice.salesNet > 0 ? invoice.salesNet : 0) + unbilled.net
    );

    const lines: VatDeclarationLine[] = [
      {
        rowNo: '1',
        rowName: '一、按适用税率计税销售额（不含税）',
        category: 'output',
        // 第 1 行是**不含税销售额**，原先错填成了销项税额 invoice.output（属错列）。
        // erp_invoice.amount 是价税合计（含税），只有 net_amount 是不含税金额，
        // 故改用 invoiceTax() 新返回的 salesNet。
        //
        // T8：再加上**未开票收入**的不含税额 —— 底稿原先销项 100% 来自发票台账，
        // 导致"已收款未开票"的部分**零申报**（少缴增值税）。
        amount: totalSalesNet,
        ledgerAmount: ledger.output,
        difference: 0,
        explained: true,
        summable: true,
        comparable: false,
      },
      {
        rowNo: '11',
        rowName: '销项税额',
        category: 'output',
        amount: invoice.output,
        ledgerAmount: ledger.output,
        difference: outputDifference,
        explained: outputDifference === 0 || Boolean(saved[0]?.differenceReason),
        summable: true,
        comparable: true,
      },
      {
        rowNo: '12',
        rowName: '进项税额',
        category: 'input',
        // 小规模纳税人无抵扣权：申报表按 0 计（原始登记额见 differences 披露）。
        // P0-A：一般纳税人只计**已勾选认证/已抵扣**的专票 —— 未勾选认证的进项
        // 依法不得在当期抵扣，其台账额（已入 222102）在 `uncertified_input` 差异项披露。
        amount: creditableInput,
        ledgerAmount: ledger.input,
        difference: creditableInputDifference,
        // 小规模下"进项 ≠ 0 但不抵扣"是政策预期，不是勾稽错误 → 视为已解释
        explained:
          isSmallScale ||
          creditableInputDifference === 0 ||
          Boolean(saved[0]?.differenceReason),
        summable: true,
        comparable: true,
      },
      {
        // P0-A：申报表的"待认证进项税额"行次（对应 222105 待认证进项税额科目口径）。
        // 这一行**不可加**：它是尚未取得抵扣权的税额，与第 12 行（可抵扣进项）
        // 是互斥的，两者相加得到的是"台账进项总额"，没有申报含义。
        rowNo: '25',
        rowName: '待认证进项税额（已登记未勾选，不得抵扣）',
        category: 'input',
        amount: invoice.uncertifiedInput,
        ledgerAmount: 0,
        difference: 0,
        explained: true,
        summable: false,
        comparable: false,
      },
      {
        rowNo: '13',
        rowName: '进项税额转出',
        category: 'transfer',
        amount: 0,
        ledgerAmount: 0,
        difference: 0,
        explained: true,
        summable: true,
        comparable: true,
      },
      {
        rowNo: '17',
        rowName: '上期留抵税额',
        category: 'credit',
        // 小规模无留抵概念，申报表按 0 计
        amount: effectivePreviousCredit,
        ledgerAmount: previousCredit,
        difference: 0,
        explained: true,
        // 留抵是**减项**（余额性质），与销项/进项不同量纲，不得计入小计
        summable: false,
        comparable: true,
      },
      {
        rowNo: '19',
        rowName: '应纳税额',
        category: 'payable',
        amount: payableTax,
        ledgerAmount: payableTax,
        difference: 0,
        explained: true,
        // 第 19 行是本表算出来的**结果**（= 11 − 12 − 13 − 17），
        // 把它再加进小计会与上面的销项/进项重复计算。
        summable: false,
        comparable: true,
      },
      {
        rowNo: '20',
        rowName: '期末留抵税额',
        category: 'credit',
        amount: closingCredit,
        ledgerAmount: closingCredit,
        difference: 0,
        explained: true,
        // 期末留抵是**余额**，不是本期发生额，与其它行不同量纲
        summable: false,
        comparable: true,
      },
      {
        // T8：未开票收入单列一行。
        //
        // **可加**：它是本期销售额的一部分（已计入第 1 行），与第 1 行同量纲；
        // 把它排除在小计之外反而会让"第 1 行 = 开票 + 未开票"这个关系看不见。
        rowNo: '1-1',
        rowName: '其中：未开票收入（已确认收入未开票，不含税）',
        category: 'output',
        amount: unbilled.net,
        ledgerAmount: 0,
        difference: 0,
        explained: true,
        summable: false,
        comparable: false,
      },
    ];

    const differences: VatDeclarationResult['differences'] = [];
    if (outputDifference !== 0) {
      differences.push({
        code: 'output_mismatch',
        label: '销项税额与 222101 科目发生额不一致',
        amount: outputDifference,
        reason: saved[0]?.differenceReason ?? null,
      });
    }
    if (inputDifference !== 0) {
      differences.push({
        code: 'input_mismatch',
        label: '进项税额与 222102 科目发生额不一致',
        amount: inputDifference,
        reason: saved[0]?.differenceReason ?? null,
      });
    }
    // T-S2：小规模纳税人的进项税额是"登记了但不抵扣"的政策性差异，必须显式披露，
    // 让底稿自己说清"为什么进项有数而应纳税额没减"——否则没人能看出这是政策还是漏减。
    // reason 自带说明，确认时不需要用户再补文字（见 confirm() 的门槛调整）。
    if (isSmallScale && (invoice.input !== 0 || ledger.input !== 0)) {
      differences.push({
        code: 'small_scale_no_input_credit',
        label: '小规模纳税人进项税额不得抵扣（应纳税额未减进项）',
        amount: round2(creditableInput - invoice.input),
        reason:
          '增值税小规模纳税人采用征收率计税、无进项抵扣权：发票台账与总账中的进项税额' +
          '仅作登记备查，不参与本期应纳税额计算（亦无留抵）。此为政策口径而非勾稽差异。',
      });
    }
    // P0-A：已登记但未勾选认证的进项税额必须显式披露。
    //
    // 这是"底稿自己说清为什么应纳税额不能减它"的唯一位置：没有这段，
    // 财务只会看到第 12 行（进项税额）比台账小，无从判断是漏取数还是政策口径。
    // 与 small_scale_no_input_credit 同策略：reason 自带完整说明，
    // 不要求用户再手打一遍（那只会诱导复制粘贴），但仍进 differences 以便被看见。
    if (!isSmallScale && invoice.uncertifiedInput !== 0) {
      differences.push({
        code: 'uncertified_input_pending',
        label: `待认证进项税额（${invoice.uncertifiedCount} 张专票已登记未勾选，不得在当期抵扣）`,
        amount: invoice.uncertifiedInput,
        reason:
          '增值税专用发票须在勾选确认的所属期申报抵扣（国家税务总局公告 2019 年第 45 号）。' +
          '本期已登记但未勾选认证的进项税额不参与本期应纳税额计算；' +
          '请先在「发票台账 → 勾选认证」完成认证，再于认证所属期申报抵扣。' +
          '此为政策口径而非勾稽差异。',
      });
    }
    // P0-B：上期留抵的来源必须披露 —— 用总账推算时它是**估数**，
    // 与"上期已确认底稿的 closing_credit"权威性不同，财务需要知道这个区别。
    if (!isSmallScale && previousCreditSource === 'ledger_estimate' && previousCredit !== 0) {
      differences.push({
        code: 'previous_credit_from_ledger',
        label: '上期留抵取自总账推算（上期底稿未确认）',
        amount: previousCredit,
        reason:
          '上期增值税申报底稿尚未确认，本期上期留抵按总账 222102/222101 期末余额推算。' +
          '该数为估数：若与上期实际申报的期末留抵不符，请先确认上期底稿后重新生成本期底稿。' +
          '为避免重复抵扣，此情形下上期留抵按不超过本期进项发生额计入。',
      });
    }
    // T8：未开票收入的税额需人工确认，必须显式披露。
    // 这里只把**不含税销售额**计入（税额按 0），因此应纳税额不会因它而虚减；
    // 但财务必须知道"这笔收入还没有对应的销项税额"。
    if (unbilled.net > 0) {
      differences.push({
        code: 'unbilled_revenue_tax_pending',
        label: `未开票收入 ${unbilled.net}（不含税），其销项税额需人工确认`,
        amount: unbilled.net,
        reason:
          '本期已确认收入大于已开销项发票净额，差额按未开票收入计入第 1 行销售额。' +
          '收入台账不含税率列，无法反算其销项税额，故税额按 0 计 —— ' +
          '请按实际适用税率确认应补销项税额，或尽快为这部分收入开票（开票后自动进入台账口径）。' +
          '该口径不会造成少缴：销售额已计入，税额由人工确认后补记。',
      });
    }
    // T10：因主体归属被排除在外的收入必须**显式披露**。
    // 归属靠「收入 → 合同 → 合同.纳税主体」，合同的 tax_entity_id 为 NULL 时
    // 这笔收入不进入任何主体的小计（与发票侧 tax_entity_id 为 NULL 的处置一致）。
    // 不披露 = 静默少计销售额，而"少计"是方向不可接受的一侧，所以必须在差异区列出来。
    if (unbilled.excludedRevenue > 0) {
      differences.push({
        code: 'revenue_excluded_other_entity',
        label: `本期已确认收入中有 ${unbilled.excludedRevenue}（含税）不归属本纳税主体，未计入第 1 行`,
        amount: unbilled.excludedRevenue,
        reason:
          '未开票收入按「收入 → 合同 → 合同.纳税主体」归属到具体主体；' +
          '合同的纳税主体为空、或不属于本主体时，该笔收入不进入本主体底稿（否则同一笔收入' +
          '会在多个主体的申报表里各计一次）。请为该合同的收入指定纳税主体后重新生成底稿，' +
          '或确认该笔收入应由其他主体申报。',
      });
    }
    //   · 'within'  → 已按额度内免征两项附加，披露减免依据；
    //   · 'beyond'  → 超出额度、照征（computeVatSurcharge 的 adjustments 已有说明）；
    //   · 'unknown' → **要件缺失，未做减免（偏严）** —— 这是最容易让使用者
    //                 "长期多缴而毫不知情"的一态，必须显式说明原因与补录方式。
    if (exemption.kind === 'within') {
      differences.push({
        code: 'small_scale_exemption_applied',
        label: '小规模纳税人免征额度内：免征教育费附加与地方教育附加（城建税仍征）',
        amount: 0,
        reason:
          `主体申报周期为${
            entityRows[0]?.vatFilingCycle === 'quarterly'
              ? '按季（免征额度 30 万）'
              : '按月（免征额度 10 万）'
          }，本期销售额未超免征额度，按财税〔2016〕12 号免征教育费附加与地方教育附加；` +
          '城建税不在此免征范围，仍照征（并适用六税两费减半）。此为政策口径而非勾稽差异。',
      });
    } else if (exemption.kind === 'unknown' && isSmallScale) {
      differences.push({
        code: 'small_scale_exemption_cycle_missing',
        label: '小规模免征额度未判定（本期按偏严口径未减免）',
        amount: 0,
        reason:
          `${exemption.reason}。为不造成少缴，本期按**不减免**计提两项附加（方向偏严）。` +
          '请在「主数据 → 纳税主体」为该主体录入增值税申报周期（按月 / 按季），' +
          '之后重新生成本期底稿即可按免征额度正确计提。',
      });
    }
    // 要件缺失（如主体未配城建税率）必须显式暴露：附加税漏缴在账面上是完全看不出来的。
    // 这里进 `differences` 是为了走既有的“确认前必须写差异说明”闸门，
    // 但真正的硬门在 confirm()：缺配置不允许确认（写说明也补不上少计的税）。
    if (!surcharge.ok) {
      differences.push({
        code: 'surcharge_rate_missing',
        // 同上：未指定主体 ≠ 主体没配税率，文案必须分开，否则误导排障方向。
        label: params.taxEntityId
          ? '主体未配置城建税率，附加税费无法计提'
          : NO_ENTITY_SURCHARGE_LABEL,
        amount: 0,
        reason: null,
      });
    }

    return {
      period: params.period,
      taxEntityId: params.taxEntityId ?? null,
      taxEntityName: entityRows[0]?.name ?? null,
      status: (saved[0]?.status as 'draft' | 'confirmed') ?? 'draft',
      lines,
      outputTaxFromInvoices: invoice.output,
      inputTaxFromInvoices: invoice.input,
      outputTaxFromLedger: ledger.output,
      inputTaxFromLedger: ledger.input,
      uncertifiedInputTax: invoice.uncertifiedInput,
      uncertifiedInvoiceCount: invoice.uncertifiedCount,
      previousCredit,
      previousCreditSource,
      // T8：未开票收入（已计入第 1 行销售额）
      unbilledRevenueNet: unbilled.net,
      // T9：免征额度判定三态。非小规模 / 已关闭免征判定统一归 `not_applicable`
      // —— 二者的处置相同（不做减免且无需提示补录），但原因文案分开保留。
      smallScaleExemption: !isSmallScale
        ? 'not_applicable'
        : exemption.kind === 'unknown'
          ? 'unknown'
          : exemption.kind,
      smallScaleExemptionReason:
        exemption.kind === 'unknown' ? exemption.reason : null,
      payableTax,
      closingCredit,
      reconciled: differences.length === 0,
      differences,
      surcharge: {
        blocked: !surcharge.ok,
        blockedReason: surcharge.ok ? null : surcharge.blockedReason,
        urbanMaintRate:
          entityRows[0]?.urbanMaintRate == null
            ? null
            : toNumber(entityRows[0].urbanMaintRate),
        urbanMaint: surcharge.ok ? surcharge.urbanMaint : 0,
        education: surcharge.ok ? surcharge.education : 0,
        localEducation: surcharge.ok ? surcharge.localEducation : 0,
        total: surcharge.ok ? surcharge.total : 0,
        skippedReason: surcharge.ok ? (surcharge.skippedReason ?? null) : null,
        adjustments: surcharge.ok ? surcharge.adjustments : [],
        accrualVoucher: 'not_attempted',
      },
      // T-S3：月末转出未交增值税凭证状态（仅 confirm() 后会脱离 not_attempted）
      transferVoucher: 'not_attempted',
      generatedAt: new Date().toISOString(),
      generatedBy: saved[0]?.generatedBy ?? params.userId ?? null,
    };
  }

  /**
   * A-06 ③：确认申报底稿（勾稽不一致时必须填写差异说明）。
   * 采用 upsert，重复确认为幂等更新。
   */
  async confirm(
    dto: ConfirmVatDeclarationDto,
    userId: string
  ): Promise<VatDeclarationResult> {
    this.assertPeriod(dto.period);
    const result = await this.generate({
      period: dto.period,
      taxEntityId: dto.taxEntityId,
      userId,
    });
    // 要件缺失是硬门：写差异说明也补不上少计的税，所以这里直接拒绝确认。
    // 合法 0（期末留抵 / 免税）不在此列，那时 surcharge.blocked 为 false。
    if (result.surcharge.blocked) {
      // 直接引用 generate() 给出的 blockedReason（未指定主体时已是准确文案），
      // 只在"确实选了主体但缺城建税率"时才补上补录指引 —— 否则会把用户引向错误排障方向。
      const blockedReason = result.surcharge.blockedReason ?? '附加税费要件缺失';
      throw new BadRequestException(
        dto.taxEntityId
          ? `${blockedReason}。未配置城建税率时无法计提附加税费，` +
            `请先在主体资料中录入城建税率（市区 7% / 县镇 5% / 其他 1%）后再确认申报`
          : blockedReason
      );
    }
    if (!result.reconciled) {
      // 门槛细化：只有**未自带说明**的差异才要求用户补写差异说明。
      // 政策口径类差异（如 small_scale_no_input_credit）在 generate() 里已带上
      // 完整说明，再强制用户手打一遍只会诱导复制粘贴，反而稀释真正需要关注
      // 的勾稽不一致（output/input_mismatch 的 reason 为 null，仍会拦住）。
      const unexplained = result.differences.filter((item) => !item.reason);
      if (unexplained.length > 0) {
        const reason = dto.differenceReason?.trim();
        if (!reason || reason.length < 4) {
          throw new BadRequestException(
            `申报底稿与总账勾稽存在差异（${unexplained
              .map((item) => `${item.label} ${item.amount}`)
              .join('；')}），请填写不少于 4 个字的差异说明后再确认`
          );
        }
      }
    }
    const payload = {
      period: dto.period,
      taxEntityId: dto.taxEntityId ?? null,
      status: 'confirmed' as const,
      outputTax: String(result.outputTaxFromInvoices),
      inputTax: String(result.inputTaxFromInvoices),
      // T-S3：transfer_out 记录**实际结转出去的应纳税额**（月末结转分录金额），
      // 与 payableTax 同源。留抵月份为 0，此时不产生结转凭证（见下）。
      transferOut: String(result.payableTax),
      previousCredit: String(result.previousCredit),
      payableTax: String(result.payableTax),
      closingCredit: String(result.closingCredit),
      ledgerOutputTax: String(result.outputTaxFromLedger),
      ledgerInputTax: String(result.inputTaxFromLedger),
      differenceReason: dto.differenceReason?.trim() ?? null,
      generatedBy: userId,
      generatedAt: new Date(),
    };
    const existing = await this.db
      .select({ id: finVatDeclaration.id })
      .from(finVatDeclaration)
      .where(
        and(
          eq(finVatDeclaration.period, dto.period),
          dto.taxEntityId
            ? eq(finVatDeclaration.taxEntityId, dto.taxEntityId)
            : sql`${finVatDeclaration.taxEntityId} IS NULL`
        )
      )
      .limit(1);
    if (existing.length > 0) {
      await this.db
        .update(finVatDeclaration)
        .set(payload)
        .where(eq(finVatDeclaration.id, existing[0].id));
    } else {
      await this.db.insert(finVatDeclaration).values(payload);
    }
    // 附加税费随增值税同月计提：逐税种 借 6403xx / 贷 2221xx
    // （见 common/tax/vat-surcharge-posting.ts）。
    // 幂等：sourceRef 固定为「期间 + 主体」，重复确认不会重复计提。
    //
    // 注：`?? 'ALL'` 分支在**当前**不可达 —— 未指定主体时 generate() 必然 blocked，
    // 上面已经抛出，走不到这里。保留而非删除：将来若放开集团合并口径（届时必须
    // 解决"城建税率按主体分档、无法跨主体合并"这一前提），这里不用重新写一遍。
    const surchargeRef = `vat-surcharge:${dto.period}:${dto.taxEntityId ?? 'ALL'}`;
    const voucherDate = `${dto.period}-01`;
    let accrualVoucher: 'created' | 'skipped' | 'failed' | 'not_attempted' =
      'not_attempted';
    if (result.surcharge.total > 0) {
      const lines = vatSurchargeAccrualLines({
        ok: true,
        urbanMaint: result.surcharge.urbanMaint,
        education: result.surcharge.education,
        localEducation: result.surcharge.localEducation,
        total: result.surcharge.total,
        adjustments: result.surcharge.adjustments,
      });
      const voucherResult = await this.voucherHook.generateVoucherDraft({
        sourceType: 'vat_surcharge',
        sourceRef: surchargeRef,
        voucherDate,
        summary: `${dto.period} 计提附加税费`,
        lines,
        taxEntityId: dto.taxEntityId ?? null,
      });
      if (voucherResult === 'failed') {
        accrualVoucher = 'failed';
        // 计提失败不能只记日志：附加税漏提在账面上看不出来，必须进补偿队列可重试
        await this.voucherHook.recordCompensation(
          'vat_surcharge',
          surchargeRef,
          '附加税费计提凭证生成失败',
          lines,
          voucherDate
        );
      } else {
        accrualVoucher = 'created';
      }
    } else {
      // 合法 0：期末留抵 / 免税，本期确实无附加税可提
      accrualVoucher = 'skipped';
    }

    // T-S3：月末转出未交增值税（借 222103 / 贷 222104），把申报底稿算出的
    // 应纳税额落到账上。没有这一步，2221 明细永远停在"应交增值税"，
    // 账面应交数与实际欠税对不上（且账面看不出异常）。
    // 幂等：sourceRef 固定为「期间 + 主体」，重复确认不会重复结转。
    // 凭证日期取期间最后一天（月末结转），不用确认当天——次月申报期内
    // 确认上月申报时，按当天日期会把结转分录记错期间。
    const transferRef = `vat-transfer:${dto.period}:${dto.taxEntityId ?? 'ALL'}`;
    const transferDate = lastDayOfPeriod(dto.period);
    let transferVoucher: 'created' | 'skipped' | 'failed' | 'not_attempted' =
      'not_attempted';
    if (result.payableTax > 0) {
      const lines = vatTransferOutLines(result.payableTax);
      const voucherResult = await this.voucherHook.generateVoucherDraft({
        sourceType: 'vat_transfer',
        sourceRef: transferRef,
        voucherDate: transferDate,
        summary: `${dto.period} 转出未交增值税`,
        lines,
        taxEntityId: dto.taxEntityId ?? null,
      });
      if (voucherResult === 'failed') {
        transferVoucher = 'failed';
        // 结转失败同样进补偿队列：漏结转在账面上看不出来，必须可重试
        await this.voucherHook.recordCompensation(
          'vat_transfer',
          transferRef,
          '转出未交增值税凭证生成失败',
          lines,
          transferDate
        );
      } else {
        transferVoucher = 'created';
      }
    } else {
      // 合法 0：期末留抵 / 免税，无税可转
      transferVoucher = 'skipped';
    }

    const finalResult = await this.generate({
      period: dto.period,
      taxEntityId: dto.taxEntityId,
      userId,
    });
    finalResult.surcharge.accrualVoucher = accrualVoucher;
    finalResult.transferVoucher = transferVoucher;
    return finalResult;
  }

  /** 已确认的申报底稿清单 */
  async list(limit = 24): Promise<
    Array<{
      period: string;
      taxEntityId: string | null;
      taxEntityName: string | null;
      status: string;
      outputTax: number;
      inputTax: number;
      payableTax: number;
      closingCredit: number;
      reconciled: boolean;
      differenceReason: string | null;
      generatedBy: string | null;
      generatedAt: string | null;
    }>
  > {
    const rows = await this.db
      .select({
        period: finVatDeclaration.period,
        taxEntityId: finVatDeclaration.taxEntityId,
        status: finVatDeclaration.status,
        outputTax: finVatDeclaration.outputTax,
        inputTax: finVatDeclaration.inputTax,
        payableTax: finVatDeclaration.payableTax,
        closingCredit: finVatDeclaration.closingCredit,
        ledgerOutputTax: finVatDeclaration.ledgerOutputTax,
        ledgerInputTax: finVatDeclaration.ledgerInputTax,
        differenceReason: finVatDeclaration.differenceReason,
        generatedBy: finVatDeclaration.generatedBy,
        generatedAt: finVatDeclaration.generatedAt,
      })
      .from(finVatDeclaration)
      .orderBy(desc(finVatDeclaration.period))
      .limit(limit);
    const entityIds = Array.from(
      new Set(rows.map((row) => row.taxEntityId).filter((id): id is string => Boolean(id)))
    );
    const entities = entityIds.length
      ? await this.db
          .select({ id: mdTaxEntity.id, name: mdTaxEntity.name })
          .from(mdTaxEntity)
          // 用 inArray 走参数绑定。原先这里手拼 `ARRAY['..','..']::uuid[]` 并套 sql.raw：
          // 值虽然来自库内 uuid，但**拼接用户可控值进原始 SQL** 是注入的经典形状，
          // 一旦上游改成开放文本（如主体编码）就会直接成为漏洞。改用绑定参数即消除该形状。
          .where(inArray(mdTaxEntity.id, entityIds))
      : [];
    const entityName = new Map(entities.map((row) => [row.id, row.name]));
    return rows.map((row) => ({
      period: row.period,
      taxEntityId: row.taxEntityId ?? null,
      taxEntityName: row.taxEntityId ? (entityName.get(row.taxEntityId) ?? null) : null,
      status: row.status,
      outputTax: toNumber(row.outputTax),
      inputTax: toNumber(row.inputTax),
      payableTax: toNumber(row.payableTax),
      closingCredit: toNumber(row.closingCredit),
      reconciled:
        round2(toNumber(row.outputTax) - toNumber(row.ledgerOutputTax)) === 0 &&
        round2(toNumber(row.inputTax) - toNumber(row.ledgerInputTax)) === 0,
      differenceReason: row.differenceReason ?? null,
      generatedBy: row.generatedBy ?? null,
      generatedAt: row.generatedAt ? row.generatedAt.toISOString() : null,
    }));
  }
}
