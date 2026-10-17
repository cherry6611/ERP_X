import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, eq, sql } from 'drizzle-orm';
import { erpInvoice, finAccount, mdTaxEntity } from '@server/database/schema';
import { unwrapRows } from '@server/common/utils/rows';
import { DictService } from '@server/modules/system-config/dict.service';
import { VatDeclarationService } from './vat-declaration.service';
import { round2 } from '@server/common/utils/number';
import {
  DEFAULT_BURDEN_RATE_FLUCTUATION,
  DEFAULT_BURDEN_RATE_MAX,
  DEFAULT_BURDEN_RATE_MIN,
  DEFAULT_VOID_RATE_THRESHOLD,
  assessBurdenRate,
  assessInvoiceLedgerMismatch,
  scanInvoiceAnomalies,
  summarizeTaxRisks,
  type InvoiceRowForRisk,
  type TaxRiskFinding,
  type TaxRiskSummaryResult,
} from './tax-risk-rules';
import type {
  TaxRiskScanResult,
  TaxRiskThresholds,
} from '@shared/api.interface';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;


function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 上期 YYYY-MM */
function previousPeriod(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  return month === 1
    ? `${year - 1}-12`
    : `${year}-${String(month - 1).padStart(2, '0')}`;
}

/**
 * D-06：税务风险扫描。
 *
 * ## 与既有模块的边界（不要混用）
 *
 * - `VatDeclarationService`（A-06）：**算申报底稿**，回答"本期该申报多少"；
 * - 本服务（D-06）：**挑风险线索**，回答"这个数字有没有可疑之处、该去查什么"。
 *
 * 因此本服务**复用** A-06 的底稿结果（`generate()`）作为进销项匹配的输入，
 * 而不是重算一遍 —— 两处各算一次必然会出现口径漂移。
 *
 * ## 阈值可配置
 *
 * 税负率参考区间与作废率阈值都从 `sys_param` 读，键名见
 * `TaxRiskThresholds`；缺省值定义在 `tax-risk-rules.ts`。
 * 税负率区间**高度依赖行业**，硬编码等于把某家企业的经验当普适规律。
 */
@Injectable()
export class TaxRiskService {
  private readonly logger = new Logger(TaxRiskService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly vatService: VatDeclarationService,
    private readonly dictService: DictService
  ) {}

  /** 读取可配置阈值（缺省值来自规则引擎常量） */
  async thresholds(): Promise<TaxRiskThresholds> {
    const [minRate, maxRate, fluctuation, voidRate] = await Promise.all([
      this.dictService.numberParam('tax.burden_rate_min', DEFAULT_BURDEN_RATE_MIN),
      this.dictService.numberParam('tax.burden_rate_max', DEFAULT_BURDEN_RATE_MAX),
      this.dictService.numberParam(
        'tax.burden_rate_fluctuation',
        DEFAULT_BURDEN_RATE_FLUCTUATION
      ),
      this.dictService.numberParam(
        'tax.void_rate_threshold',
        DEFAULT_VOID_RATE_THRESHOLD
      ),
    ]);
    return {
      burdenRateMin: minRate,
      burdenRateMax: maxRate,
      burdenRateFluctuation: fluctuation,
      voidRateThreshold: voidRate,
    };
  }

  /**
   * 扫描指定期间。
   *
   * 三个方向独立 try/catch：某一个方向取数失败不应让整份风险报告变成 500 ——
   * 风险扫描的价值在于"尽可能多地把线索摊开"，部分失败也要把其余结果给出来，
   * 同时如实告知哪一段没跑成功。
   */
  async scan(params: {
    period: string;
    taxEntityId?: string;
  }): Promise<TaxRiskScanResult> {
    const { period } = params;
    if (!PERIOD_PATTERN.test(period)) {
      throw new BadRequestException('period 必须为 YYYY-MM');
    }
    const thresholds = await this.thresholds();
    const findings: TaxRiskFinding[] = [];
    const skipped: string[] = [];

    /* ---------- 底稿（进项/销项口径 + 差异明细） ---------- */
    let declaration: Awaited<ReturnType<VatDeclarationService['generate']>> | null =
      null;
    try {
      declaration = await this.vatService.generate({
        period,
        taxEntityId: params.taxEntityId,
      });
    } catch (error) {
      skipped.push(
        `增值税底稿取数失败：${error instanceof Error ? error.message : String(error)}`
      );
    }

    /* ---------- ① 税负率 ---------- */
    if (declaration) {
      const previous = await this.safePreviousBurdenRate(
        period,
        params.taxEntityId,
        thresholds
      );
      const revenue = await this.periodRevenue(period);
      const burden = assessBurdenRate({
        period,
        revenue,
        outputTax: declaration.outputTaxFromInvoices,
        inputTax: declaration.inputTaxFromInvoices,
        previousBurdenRate: previous,
        minRate: thresholds.burdenRateMin,
        maxRate: thresholds.burdenRateMax,
        fluctuationThreshold: thresholds.burdenRateFluctuation,
      });
      findings.push(...burden.findings);

      /* ---------- ② 进销项匹配 ---------- */
      const mismatch = assessInvoiceLedgerMismatch({
        period,
        outputTaxFromInvoices: declaration.outputTaxFromInvoices,
        inputTaxFromInvoices: declaration.inputTaxFromInvoices,
        outputTaxFromLedger: declaration.outputTaxFromLedger,
        inputTaxFromLedger: declaration.inputTaxFromLedger,
        differences: declaration.differences,
      });
      findings.push(...mismatch.findings);
    } else {
      skipped.push('税负率异常与进销项匹配：因底稿不可用而跳过');
    }

    /* ---------- ③ 发票异常 ---------- */
    try {
      const invoices = await this.periodInvoices(period);
      findings.push(
        ...scanInvoiceAnomalies(invoices, {
          period,
          voidRateThreshold: thresholds.voidRateThreshold,
        })
      );
    } catch (error) {
      skipped.push(
        `发票异常扫描失败：${error instanceof Error ? error.message : String(error)}`
      );
    }

    const summary = summarizeTaxRisks(findings, period);
    const taxEntityName = await this.taxEntityName(
      declaration?.taxEntityId ?? params.taxEntityId ?? null
    );

    this.logger.log(
      `税务风险扫描 period=${period} 发现=${summary.totalFindings} 最高级别=${summary.highestSeverity ?? '无'}`
    );

    return {
      ...summary,
      taxEntityId: declaration?.taxEntityId ?? params.taxEntityId ?? null,
      taxEntityName,
      thresholds,
      burdenRate: declaration
        ? await this.burdenRateSnapshot(period, declaration, thresholds)
        : null,
      reconciled: declaration?.reconciled ?? false,
      generatedAt: new Date().toISOString(),
      skipped,
    };
  }

  private async burdenRateSnapshot(
    period: string,
    declaration: {
      outputTaxFromInvoices: number;
      inputTaxFromInvoices: number;
    },
    thresholds: TaxRiskThresholds
  ): Promise<TaxRiskScanResult['burdenRate']> {
    const revenue = await this.periodRevenue(period);
    const result = assessBurdenRate({
      period,
      revenue,
      outputTax: declaration.outputTaxFromInvoices,
      inputTax: declaration.inputTaxFromInvoices,
      minRate: thresholds.burdenRateMin,
      maxRate: thresholds.burdenRateMax,
    });
    return {
      revenue: result.revenue,
      outputTax: result.outputTax,
      inputTax: result.inputTax,
      payableTax: result.payableTax,
      rate: result.burdenRate,
      withinRange: result.withinRange,
    };
  }

  /** 上一期税负率（用于环比波动判定）；取不到就返回 null，不阻断扫描 */
  private async safePreviousBurdenRate(
    period: string,
    taxEntityId: string | undefined,
    thresholds: TaxRiskThresholds
  ): Promise<number | null> {
    try {
      const previous = previousPeriod(period);
      const declaration = await this.vatService.generate({
        period: previous,
        taxEntityId,
      });
      const revenue = await this.periodRevenue(previous);
      if (revenue <= 0) return null;
      void thresholds;
      return round2(
        ((declaration.outputTaxFromInvoices - declaration.inputTaxFromInvoices) /
          revenue) *
          100
      );
    } catch {
      return null;
    }
  }

  /**
   * 本期不含税收入。
   *
   * 口径与 BI 指标中心一致：已确认收入的不含税净额
   * （`erp_project_revenue.amount × 100/(100+合同税率)`）。
   * 为什么不用科目发生额：收入确认单是收入的事实来源，
   * 且此处需要与 BI 的"营业收入"口径可比，避免同一期间两处收入不一致。
   */
  private async periodRevenue(period: string): Promise<number> {
    const rows = unwrapRows<{ total: string | null }>(
      await this.db.execute(sql`
        SELECT coalesce(sum(
          coalesce(r.amount, 0) * 100.0 / (100.0 + coalesce(c.tax_rate, 6))
        ), 0) AS total
        FROM erp_project_revenue r
        LEFT JOIN erp_contract c ON c.id = r.contract_id
        WHERE r.status = 'recognized' AND r.period = ${period}
      `)
    );
    return round2(toNumber(rows[0]?.total));
  }

  /** 本期发票（用于发票异常扫描） */
  private async periodInvoices(period: string): Promise<InvoiceRowForRisk[]> {
    const rows = await this.db
      .select({
        id: erpInvoice.id,
        code: erpInvoice.code,
        invoiceNo: erpInvoice.invoiceNo,
        direction: erpInvoice.direction,
        amount: erpInvoice.amount,
        status: erpInvoice.status,
        arId: erpInvoice.arId,
        apId: erpInvoice.apId,
        invoiceDate: erpInvoice.invoiceDate,
      })
      .from(erpInvoice)
      .where(
        sql`to_char(${erpInvoice.invoiceDate}, 'YYYY-MM') = ${period}
            OR ${erpInvoice.invoiceDate} IS NULL`
      );
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      invoiceNo: row.invoiceNo,
      direction: row.direction ?? 'sales',
      amount: round2(toNumber(row.amount)),
      status: row.status ?? 'issued',
      linkedId: row.arId ?? row.apId ?? null,
      invoiceDate: row.invoiceDate,
    }));
  }

  private async taxEntityName(id: string | null): Promise<string | null> {
    if (!id) return null;
    const rows = await this.db
      .select({ name: mdTaxEntity.name })
      .from(mdTaxEntity)
      .where(eq(mdTaxEntity.id, id))
      .limit(1);
    return rows[0]?.name ?? null;
  }

  /**
   * 税务风险相关的科目余额核对（供前端"下钻"用）。
   *
   * 取 222101（销项）/222102（进项）在**本期**的贷方/借方发生额合计，
   * 与底稿的"总账口径"应当一致 —— 若不一致说明总账取数逻辑有问题，
   * 这是一条自检线索，也解释了"总账口径"数字是怎么来的。
   */
  async vatAccountMovement(period: string): Promise<{
    outputTaxCredit: number;
    inputTaxDebit: number;
  }> {
    const rows = unwrapRows<{
      output_credit: string | null;
      input_debit: string | null;
    }>(
      await this.db.execute(sql`
        SELECT
          coalesce(sum(CASE WHEN a.code = '222101' THEN l.credit ELSE 0 END), 0) AS output_credit,
          coalesce(sum(CASE WHEN a.code = '222102' THEN l.debit ELSE 0 END), 0) AS input_debit
        FROM fin_voucher_line l
        JOIN fin_voucher v ON v.id = l.voucher_id
        JOIN fin_account a ON a.code = l.account_code
        WHERE to_char(v.voucher_date, 'YYYY-MM') = ${period}
          AND v.status = 'posted'
      `)
    );
    return {
      outputTaxCredit: round2(toNumber(rows[0]?.output_credit)),
      inputTaxDebit: round2(toNumber(rows[0]?.input_debit)),
    };
  }

  /** 科目表是否含增值税明细科目（缺科目时给出可读原因，而不是静默返回 0） */
  async hasVatAccounts(): Promise<boolean> {
    const rows = await this.db
      .select({ code: finAccount.code })
      .from(finAccount)
      .where(and(eq(finAccount.code, '222101')))
      .limit(1);
    return rows.length > 0;
  }
}
