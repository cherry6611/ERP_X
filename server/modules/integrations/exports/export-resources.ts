import { BadRequestException } from '@nestjs/common';
import type { ExportResourceType } from '@shared/api.interface';
import type { BankAccountService } from '../bank/bank-account.service';
import type { BankStatementService } from '../bank/bank-statement.service';
import type { BankReconciliationService } from '../bank/bank-reconciliation.service';
import {
  statementItemToRow,
  toExportRecord,
  type BankStatementRowRaw,
} from '../bank/bank-statement.service';
import type { ExportColumn, ExportRecord } from './export-file';

export type { ExportColumn, ExportRecord };

export interface ExportFilterSpec {
  key: string;
  label: string;
  /** 允许的取值（枚举类筛选）；缺省表示自由文本/UUID */
  values?: string[];
  required?: boolean;
}

export interface ExportResourceContext {
  bankAccounts: BankAccountService;
  statements: BankStatementService;
  reconciliation: BankReconciliationService;
}

export interface ExportResourceDescriptor {
  type: ExportResourceType;
  label: string;
  /** 默认文件名前缀（不含扩展名与时间戳） */
  filePrefix: string;
  columns: ExportColumn[];
  filters: ExportFilterSpec[];
  /** 单次导出硬上限，超过时截断并在文件说明中标注 */
  maxRows: number;
  load: (
    ctx: ExportResourceContext,
    filters: Record<string, string>
  ) => Promise<ExportRecord[]>;
}

function coerceFilters(
  descriptor: ExportResourceDescriptor,
  raw: Record<string, unknown> | undefined
): Record<string, string> {
  const allowed = new Map(descriptor.filters.map((item) => [item.key, item]));
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!allowed.has(key)) continue;
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text === '') continue;
    const spec = allowed.get(key);
    if (spec?.values && !spec.values.includes(text)) {
      throw new BadRequestException(
        `筛选参数 ${spec.label} 取值非法（允许：${spec.values.join(' / ')}）`
      );
    }
    result[key] = text;
  }
  for (const spec of descriptor.filters) {
    if (spec.required && !result[spec.key]) {
      throw new BadRequestException(`筛选参数 ${spec.label} 必填`);
    }
  }
  return result;
}

export function validateFilters(
  descriptor: ExportResourceDescriptor,
  raw: Record<string, unknown> | undefined
): Record<string, string> {
  return coerceFilters(descriptor, raw);
}

/** 人类可读的筛选说明（写入文件首行，满足审计留痕要求） */
export function describeFilters(
  descriptor: ExportResourceDescriptor,
  filters: Record<string, string>
): string {
  const parts = descriptor.filters
    .filter((spec) => filters[spec.key])
    .map((spec) => `${spec.label}=${filters[spec.key]}`);
  return parts.length > 0 ? parts.join('；') : '无筛选条件（全量导出）';
}

function statementRecord(row: BankStatementRowRaw): ExportRecord {
  return toExportRecord(row) as ExportRecord;
}

const DIRECTION_VALUES = ['income', 'expense'];
const MATCH_STATUS_VALUES = ['unmatched', 'matched', 'manual', 'ignored'];

/** C-07：可导出资源注册表。新增资源只需在此登记（列 + 筛选 + 取数） */
export const EXPORT_RESOURCES: Record<ExportResourceType, ExportResourceDescriptor> = {
  bank_statement: {
    type: 'bank_statement',
    label: '银行流水',
    filePrefix: 'bank-statement',
    maxRows: 50_000,
    filters: [
      { key: 'bankAccountId', label: '银行账户' },
      { key: 'period', label: '期间' },
      { key: 'matchStatus', label: '匹配状态', values: MATCH_STATUS_VALUES },
      { key: 'direction', label: '方向', values: DIRECTION_VALUES },
    ],
    columns: [
      { key: 'tradeDate', label: '交易日期', width: 14 },
      { key: 'account', label: '银行账户', width: 22 },
      { key: 'direction', label: '方向', width: 8 },
      { key: 'amount', label: '金额', width: 16 },
      { key: 'balance', label: '余额', width: 16 },
      { key: 'counterpartyName', label: '对方户名', width: 24 },
      { key: 'counterpartyAccount', label: '对方账号', width: 24 },
      { key: 'summary', label: '摘要', width: 36 },
      { key: 'transactionNo', label: '交易流水号', width: 24 },
      { key: 'matchStatus', label: '匹配状态', width: 12 },
      { key: 'bizCode', label: '匹配单据', width: 18 },
      { key: 'matchScore', label: '匹配分', width: 10 },
    ],
    load: async (ctx, filters) => {
      const rows: BankStatementRowRaw[] = [];
      let page = 1;
      const pageSize = 500;
      for (;;) {
        const chunk = await ctx.statements.listStatements({
          bankAccountId: filters.bankAccountId,
          period: filters.period,
          matchStatus: filters.matchStatus as never,
          page,
          pageSize,
        });
        for (const item of chunk.items) {
          if (filters.direction && item.direction !== filters.direction) continue;
          rows.push(statementItemToRow(item));
        }
        if (chunk.items.length === 0 || page * pageSize >= chunk.total) break;
        if (rows.length >= 50_000) break;
        page += 1;
      }
      return rows.map((row) => statementRecord(row));
    },
  },
  bank_statement_unmatched: {
    type: 'bank_statement_unmatched',
    label: '未匹配银行流水',
    filePrefix: 'bank-statement-unmatched',
    maxRows: 20_000,
    filters: [
      { key: 'bankAccountId', label: '银行账户' },
      { key: 'period', label: '期间' },
    ],
    columns: [
      { key: 'tradeDate', label: '交易日期', width: 14 },
      { key: 'account', label: '银行账户', width: 22 },
      { key: 'direction', label: '方向', width: 8 },
      { key: 'amount', label: '金额', width: 16 },
      { key: 'counterpartyName', label: '对方户名', width: 24 },
      { key: 'counterpartyAccount', label: '对方账号', width: 24 },
      { key: 'summary', label: '摘要', width: 36 },
      { key: 'transactionNo', label: '交易流水号', width: 24 },
    ],
    load: async (ctx, filters) => {
      const rows: ExportRecord[] = [];
      let page = 1;
      const pageSize = 500;
      for (;;) {
        const chunk = await ctx.statements.listUnmatched({
          bankAccountId: filters.bankAccountId,
          period: filters.period,
          page,
          pageSize,
        });
        rows.push(...chunk.items.map((item) => statementRecord(statementItemToRow(item))));
        if (chunk.items.length === 0 || page * pageSize >= chunk.total) break;
        page += 1;
      }
      return rows;
    },
  },
  bank_reconciliation: {
    type: 'bank_reconciliation',
    label: '银行存款余额调节表',
    filePrefix: 'bank-reconciliation',
    maxRows: 5_000,
    filters: [
      { key: 'bankAccountId', label: '银行账户' },
      { key: 'period', label: '期间', required: true },
    ],
    columns: [
      { key: 'section', label: '分区', width: 18 },
      { key: 'item', label: '项目', width: 34 },
      { key: 'amount', label: '金额', width: 18 },
      { key: 'source', label: '来源', width: 18 },
      { key: 'sourceCode', label: '单号/流水号', width: 22 },
      { key: 'tradeDate', label: '日期', width: 14 },
    ],
    load: async (ctx, filters) => {
      const report = await ctx.reconciliation.buildReport({
        bankAccountId: filters.bankAccountId,
        period: filters.period,
      });
      const rows: ExportRecord[] = [
        { section: '一、银行对账单余额', item: '银行对账单余额', amount: report.bankStatementBalance, source: report.bankStatementBalanceSource, sourceCode: null, tradeDate: null },
        { section: '一、银行对账单余额', item: '加：企业已收银行未收', amount: report.enterpriseReceivedBankNotReceived, source: null, sourceCode: null, tradeDate: null },
        { section: '一、银行对账单余额', item: '减：企业已付银行未付', amount: report.enterprisePaidBankNotPaid, source: null, sourceCode: null, tradeDate: null },
        { section: '一、银行对账单余额', item: '调节后银行对账单余额', amount: report.adjustedBankBalance, source: null, sourceCode: null, tradeDate: null },
        { section: '二、企业账面余额', item: '企业账面余额', amount: report.bookBalance, source: report.accountCode, sourceCode: null, tradeDate: null },
        { section: '二、企业账面余额', item: '加：银行已收企业未收', amount: report.bankReceivedEnterpriseNotReceived, source: null, sourceCode: null, tradeDate: null },
        { section: '二、企业账面余额', item: '减：银行已付企业未付', amount: report.bankPaidEnterpriseNotPaid, source: null, sourceCode: null, tradeDate: null },
        { section: '二、企业账面余额', item: '调节后企业账面余额', amount: report.adjustedBookBalance, source: null, sourceCode: null, tradeDate: null },
      ];
      for (const check of report.checks) {
        rows.push({
          section: '三、恒等式断言',
          item: check.label,
          amount: check.difference,
          source: check.passed ? '通过' : '不通过',
          sourceCode: null,
          tradeDate: null,
        });
      }
      for (const item of report.outstandingItems) {
        rows.push({
          section: item.side === 'bank_only' ? '四、银行已入账企业未入账' : '五、企业已入账银行未入账',
          item: item.description,
          amount: item.direction === 'income' ? item.amount : -item.amount,
          source: item.source,
          sourceCode: item.sourceCode ?? item.sourceId,
          tradeDate: item.tradeDate,
        });
      }
      return rows;
    },
  },
  bank_account: {
    type: 'bank_account',
    label: '银行账户',
    filePrefix: 'bank-account',
    maxRows: 1_000,
    filters: [{ key: 'status', label: '状态', values: ['active', 'disabled'] }],
    columns: [
      { key: 'code', label: '账户编码', width: 16 },
      { key: 'name', label: '账户名', width: 24 },
      { key: 'accountNo', label: '账号', width: 24 },
      { key: 'bankName', label: '开户行', width: 26 },
      { key: 'currency', label: '币种', width: 8 },
      { key: 'accountCode', label: '会计科目', width: 12 },
      { key: 'openingBalance', label: '期初余额', width: 16 },
      { key: 'isDefault', label: '默认账户', width: 10 },
      { key: 'status', label: '状态', width: 10 },
    ],
    load: async (ctx, filters) => {
      const result = await ctx.bankAccounts.listAccounts({
        page: 1,
        pageSize: 100,
        status: filters.status,
      });
      return result.items.map((item) => ({
        code: item.code,
        name: item.name,
        accountNo: item.accountNo,
        bankName: item.bankName,
        currency: item.currency,
        accountCode: item.accountCode,
        openingBalance: item.openingBalance,
        isDefault: item.isDefault ? '是' : '否',
        status: item.status === 'active' ? '启用' : '停用',
      }));
    },
  },
};

export function getExportResource(type: string): ExportResourceDescriptor {
  const descriptor = EXPORT_RESOURCES[type as ExportResourceType];
  if (!descriptor) {
    throw new BadRequestException(
      `不支持的导出资源类型：${type}（可选：${Object.keys(EXPORT_RESOURCES).join(' / ')}）`
    );
  }
  return descriptor;
}
