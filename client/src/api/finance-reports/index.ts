import { axiosForBackend } from '@client/src/platform/request';
import { ensureNotForbidden } from '@client/src/utils/api-error';
import type {
  AccountBalanceSheet,
  AuxAllocationArgs,
  AuxAllocationPreview,
  AuxCrossDimensionResult,
  AuxMultiDimensionBalance,
  AuxPeriodValue,
  AuxBalanceQueryArgs,
  AuxBalanceSheet,
  AuxDimensionItem,
  BalanceSheetResult,
  CarryForwardArgs,
  CashFlowResult,
  ConfirmVatDeclarationDto,
  DetailLedgerQueryArgs,
  DetailLedgerResult,
  GeneralLedgerSheet,
  IncomeStatementResult,
  LedgerQueryArgs,
  PeriodCarryForwardPreview,
  ReportCode,
  ReportQueryArgs,
  ReportTemplateRow,
  ReverseYearEndArgs,
  TaxRiskScanResult,
  TaxRiskThresholds,
  TrialBalanceResult,
  VatDeclarationHistoryItem,
  VatDeclarationResult,
  YearEndCloseResult,
  YearEndLogItem,
  YearEndStatusItem,
} from '@shared/api.interface';

/*
 * 契约来源（API-2 / NFR-M4）：
 * 本模块**不声明任何本地类型**，全部请求参数与返回类型来自
 * `shared/api.interface.ts`（该文件是前后端契约唯一权威）。
 * scripts/check-contract.mjs 会拒绝本目录下出现 interface / type / 内联对象类型。
 */

/** 剔除空值，避免 axios 把 undefined/'' 拼成 `taxEntityId=` 触发后端 UUID 校验 */
function buildArgs(args: ReportQueryArgs): {
  period: string;
  taxEntityId?: string;
} {
  return {
    period: args.period,
    taxEntityId: args.taxEntityId || undefined,
  };
}

/* ========== A-01 / A-02 法定财务报表 ========== */

export async function getBalanceSheet(
  args: ReportQueryArgs,
): Promise<BalanceSheetResult> {
  const resp = await axiosForBackend.get<BalanceSheetResult>(
    '/api/finance/reports/balance-sheet',
    { params: buildArgs(args) },
  );
  return resp.data;
}

export async function getIncomeStatement(
  args: ReportQueryArgs,
): Promise<IncomeStatementResult> {
  const resp = await axiosForBackend.get<IncomeStatementResult>(
    '/api/finance/reports/income-statement',
    { params: buildArgs(args) },
  );
  return resp.data;
}

export async function getCashFlow(args: ReportQueryArgs): Promise<CashFlowResult> {
  const resp = await axiosForBackend.get<CashFlowResult>(
    '/api/finance/reports/cash-flow',
    { params: buildArgs(args) },
  );
  return resp.data;
}

/**
 * 统一入口：报表 Tab 切换时只换 reportCode，无需分辨三套接口。
 * 返回三个结果接口的联合，调用方按 reportCode 收窄。
 */
export async function getReport(
  reportCode: ReportCode,
  args: ReportQueryArgs,
): Promise<BalanceSheetResult | IncomeStatementResult | CashFlowResult> {
  const resp = await axiosForBackend.get<
    BalanceSheetResult | IncomeStatementResult | CashFlowResult
  >(`/api/finance/reports/${reportCode}`, { params: buildArgs(args) });
  return resp.data;
}

export async function listReportTemplates(
  reportCode: ReportCode,
): Promise<ReportTemplateRow[]> {
  const resp = await axiosForBackend.get<ReportTemplateRow[]>(
    `/api/finance/reports/templates/${reportCode}`,
  );
  return resp.data;
}

/* ========== A-03 账簿 ========== */

export async function getAccountBalance(
  args: LedgerQueryArgs,
): Promise<AccountBalanceSheet> {
  const resp = await axiosForBackend.get<AccountBalanceSheet>(
    '/api/finance/ledgers/account-balance',
    { params: { ...buildArgs(args), level: args.level } },
  );
  return resp.data;
}

export async function getGeneralLedger(
  args: ReportQueryArgs,
): Promise<GeneralLedgerSheet> {
  const resp = await axiosForBackend.get<GeneralLedgerSheet>(
    '/api/finance/ledgers/general',
    { params: buildArgs(args) },
  );
  return resp.data;
}

export async function getDetailLedger(
  args: DetailLedgerQueryArgs,
): Promise<DetailLedgerResult> {
  const resp = await axiosForBackend.get<DetailLedgerResult>(
    '/api/finance/ledgers/detail',
    {
      params: {
        accountCode: args.accountCode,
        period: args.period,
        page: args.page,
        pageSize: args.pageSize,
        taxEntityId: args.taxEntityId,
        // 后端按字符串 'true' 判定（见 controller），显式序列化避免歧义
        includeChildren: args.includeChildren ? 'true' : undefined,
      },
    },
  );
  return resp.data;
}

export async function getAuxBalance(
  args: AuxBalanceQueryArgs,
): Promise<AuxBalanceSheet> {
  const resp = await axiosForBackend.get<AuxBalanceSheet>(
    '/api/finance/ledgers/aux-balance',
    {
      params: {
        period: args.period,
        dimension: args.dimension,
        dimensionId: args.dimensionId,
        taxEntityId: args.taxEntityId,
      },
    },
  );
  return resp.data;
}

export async function listAuxDimensions(): Promise<AuxDimensionItem[]> {
  const resp = await axiosForBackend.get<AuxDimensionItem[]>(
    '/api/finance/ledgers/aux-dimensions',
  );
  return resp.data;
}

export async function getTrialBalance(period: string): Promise<TrialBalanceResult> {
  const resp = await axiosForBackend.get<TrialBalanceResult>(
    '/api/finance/ledgers/trial-balance',
    { params: { period } },
  );
  return resp.data;
}

/* ========== A-04 期末结转损益与年结 ========== */

export async function previewCarryForward(
  args: ReportQueryArgs,
): Promise<PeriodCarryForwardPreview> {
  const resp = await axiosForBackend.get<PeriodCarryForwardPreview>(
    '/api/finance/year-end/preview',
    { params: buildArgs(args) },
  );
  return resp.data;
}

export async function carryForward(
  args: CarryForwardArgs,
): Promise<YearEndCloseResult> {
  const resp = await axiosForBackend.post<YearEndCloseResult>(
    '/api/finance/year-end/carry-forward',
    buildArgs(args),
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function reverseYearEnd(
  args: ReverseYearEndArgs,
): Promise<YearEndCloseResult> {
  const resp = await axiosForBackend.post<YearEndCloseResult>(
    `/api/finance/year-end/${args.fiscalYear}/reverse`,
    {
      reason: args.reason,
      approved: args.approved,
      taxEntityId: args.taxEntityId,
    },
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function listYearEndStatus(
  taxEntityId?: string,
): Promise<YearEndStatusItem[]> {
  const resp = await axiosForBackend.get<YearEndStatusItem[]>(
    '/api/finance/year-end/status',
    { params: taxEntityId ? { taxEntityId } : undefined },
  );
  return resp.data;
}

export async function listYearEndLog(
  fiscalYear?: number,
): Promise<YearEndLogItem[]> {
  const resp = await axiosForBackend.get<YearEndLogItem[]>(
    '/api/finance/year-end/log',
    { params: fiscalYear ? { fiscalYear } : undefined },
  );
  return resp.data;
}

/* ========== A-06 增值税申报底稿 ========== */

export async function getVatDeclaration(
  args: ReportQueryArgs,
): Promise<VatDeclarationResult> {
  const resp = await axiosForBackend.get<VatDeclarationResult>(
    '/api/finance/tax-declaration',
    { params: buildArgs(args) },
  );
  return resp.data;
}

export async function confirmVatDeclaration(
  dto: ConfirmVatDeclarationDto,
): Promise<VatDeclarationResult> {
  const resp = await axiosForBackend.post<VatDeclarationResult>(
    '/api/finance/tax-declaration/confirm',
    dto,
  );
  ensureNotForbidden(resp);
  return resp.data;
}

export async function listVatDeclarations(
  limit = 24,
): Promise<VatDeclarationHistoryItem[]> {
  const resp = await axiosForBackend.get<VatDeclarationHistoryItem[]>(
    '/api/finance/tax-declaration/list',
    { params: { limit } },
  );
  return resp.data;
}

/* ========== D-06 税务风险扫描 ========== */

export async function scanTaxRisk(params: {
  period: string;
  taxEntityId?: string;
}): Promise<TaxRiskScanResult> {
  const resp = await axiosForBackend.get<TaxRiskScanResult>(
    '/api/finance/tax-risk-scan',
    { params },
  );
  return resp.data;
}

export async function getTaxRiskThresholds(): Promise<TaxRiskThresholds> {
  const resp = await axiosForBackend.get<TaxRiskThresholds>(
    '/api/finance/tax-risk-thresholds',
  );
  return resp.data;
}

export async function getVatAccountMovement(period: string): Promise<{
  outputTaxCredit: number;
  inputTaxDebit: number;
}> {
  const resp = await axiosForBackend.get<{
    outputTaxCredit: number;
    inputTaxDebit: number;
  }>('/api/finance/tax-risk-vat-movement', { params: { period } });
  return resp.data;
}
/* ========== D-03 辅助核算深化 ========== */

/** 多维度组合余额（含覆盖度 —— 组合金额之和通常小于科目总额） */
export async function getAuxCombination(params: {
  period: string;
  dimensions: string[];
  taxEntityId?: string;
  accountCode?: string;
}): Promise<AuxMultiDimensionBalance> {
  const resp = await axiosForBackend.get<AuxMultiDimensionBalance>(
    '/api/finance/ledgers/aux-combination',
    { params: { ...params, dimensions: params.dimensions.join(',') } },
  );
  return resp.data;
}

/** 区间多维度组合（跨月，用于"某项目全年投入"这类问题） */
export async function getAuxCombinationRange(params: {
  from: string;
  to: string;
  dimensions: string[];
  taxEntityId?: string;
  accountCode?: string;
}): Promise<AuxMultiDimensionBalance> {
  const resp = await axiosForBackend.get<AuxMultiDimensionBalance>(
    '/api/finance/ledgers/aux-combination-range',
    { params: { ...params, dimensions: params.dimensions.join(',') } },
  );
  return resp.data;
}

/** 跨维度结构对比（各维度余额并列 + 结构占比） */
export async function getAuxCrossDimension(params: {
  period: string;
  dimensions: string[];
  taxEntityId?: string;
  accountCode?: string;
}): Promise<AuxCrossDimensionResult> {
  const resp = await axiosForBackend.get<AuxCrossDimensionResult>(
    '/api/finance/ledgers/aux-cross-dimension',
    { params: { ...params, dimensions: params.dimensions.join(',') } },
  );
  return resp.data;
}

/** 某维度本期取值范围与余额（下拉用） */
export async function getAuxDimensionValues(params: {
  period: string;
  dimensionCode: string;
}): Promise<AuxPeriodValue[]> {
  const resp = await axiosForBackend.get<AuxPeriodValue[]>(
    '/api/finance/ledgers/aux-dimension-values',
    { params },
  );
  return resp.data;
}

/** 成本分摊试算（只算不落库；分摊额合计服务端已自检严格等于总额） */
export async function previewAuxAllocation(
  args: AuxAllocationArgs,
): Promise<AuxAllocationPreview> {
  const resp = await axiosForBackend.post<AuxAllocationPreview>(
    '/api/finance/ledgers/aux-allocation-preview',
    args,
  );
  return resp.data;
}