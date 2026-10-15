import React, { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  RefreshCw,
  XCircle,
} from 'lucide-react';
import PageShell from '@client/src/components/PageShell';
import FilterBar from '@client/src/components/erp/FilterBar';
import PeriodSelect from '@client/src/components/erp/PeriodSelect';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { Label } from '@client/src/components/ui/label';
import { Switch } from '@client/src/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@client/src/components/ui/collapsible';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@client/src/components/ui/tabs';
import {
  exportRowsToXlsx,
  type ExcelSheetColumn,
} from '@client/src/components/excel/excel-utils';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { useAuth } from '@client/src/platform/auth';
import * as financeReportsApi from '@client/src/api/finance-reports';
import * as masterDataApi from '@client/src/api/master-data';
import { cn } from '@client/src/lib/utils';
import { currentPeriod, formatMoney } from '@client/src/utils/format';

import type {
  BalanceSheetResult,
  CashFlowResult,
  IncomeStatementResult,
  ReportCheck,
  ReportCode,
  ReportQueryArgs,
  ReportRow,
  ReportSheet,
  TaxEntity,
} from '@shared/api.interface';

type ReportResult = BalanceSheetResult | IncomeStatementResult | CashFlowResult;

const ALL_ENTITIES = '__all__';

const REPORT_TABS: Array<{ code: ReportCode; label: string }> = [
  { code: 'balance_sheet', label: '资产负债表' },
  { code: 'income_statement', label: '利润表' },
  { code: 'cash_flow', label: '现金流量表' },
];

/** section 是模板里的分组码，用于给行插分组小标题（取值来自报表模板种子数据） */
const SECTION_LABELS: Record<string, string> = {
  assets: '资产',
  liabilities: '负债',
  equity: '所有者权益',
  revenue: '收入',
  cost: '成本费用',
  profit: '利润',
  operating: '经营活动',
  investing: '投资活动',
  financing: '筹资活动',
  summary: '净增加额',
  cash: '现金余额',
  default: '',
};

const COLUMN_WIDTHS = {
  no: 'w-[72px]',
  name: 'min-w-[280px] flex-1',
  amount: 'w-[150px]',
} as const;

interface AmountColumnMeta {
  /** 资产负债表为期末余额，利润表/现金流量表为本期金额 */
  thirdLabel: string;
  fourthLabel: string;
  fifthLabel: string;
}

function amountColumns(reportCode: ReportCode): AmountColumnMeta {
  if (reportCode === 'balance_sheet') {
    return {
      thirdLabel: '期末余额',
      fourthLabel: '年初余额',
      fifthLabel: '年初余额',
    };
  }
  return {
    thirdLabel: '本期金额',
    fourthLabel: '本年累计',
    fifthLabel: '上期金额',
  };
}

const CheckCard: React.FC<{ check: ReportCheck }> = ({ check }) => (
  <div
    className={cn(
      'flex flex-col gap-2 rounded-xl border bg-card p-4',
      check.passed ? 'border-success/30' : 'border-destructive/40',
    )}
  >
    <div className="flex items-start justify-between gap-2">
      <p className="text-xs text-muted-foreground">{check.label}</p>
      <Badge variant={check.passed ? 'success' : 'destructive'}>
        {check.passed ? '通过' : '不通过'}
      </Badge>
    </div>
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span>
        左值 <span className="tabular-nums text-foreground">{formatMoney(check.left)}</span>
      </span>
      <span>
        右值 <span className="tabular-nums text-foreground">{formatMoney(check.right)}</span>
      </span>
      <span>
        差额{' '}
        <span
          className={cn(
            'tabular-nums',
            check.difference === 0 ? 'text-foreground' : 'text-destructive',
          )}
        >
          {formatMoney(check.difference)}
        </span>
      </span>
    </div>
  </div>
);

const ReportRowItem: React.FC<{ row: ReportRow; meta: AmountColumnMeta }> = ({
  row,
  meta,
}) => {
  const [open, setOpen] = useState(false);
  const hasDetails = (row.details ?? []).length > 0;
  const indent = Math.max(0, Number(row.indent ?? 0));

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="border-b last:border-b-0">
        <CollapsibleTrigger
          type="button"
          disabled={!hasDetails}
          className={cn(
            'flex w-full items-center text-left text-sm transition-colors',
            hasDetails ? 'cursor-pointer hover:bg-muted/50' : 'cursor-default',
            row.bold && 'font-semibold',
          )}
        >
          <span className={cn('px-2 py-2 text-muted-foreground', COLUMN_WIDTHS.no)}>
            {row.rowNo}
          </span>
          <span className={cn('px-2 py-2', COLUMN_WIDTHS.name)}>
            <span style={{ paddingLeft: `${indent * 16}px` }}>{row.rowName}</span>
            {hasDetails ? (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {open ? '收起明细' : `取数明细 ${(row.details ?? []).length}`}
              </span>
            ) : null}
          </span>
          <span className={cn('px-2 py-2 text-right tabular-nums', COLUMN_WIDTHS.amount)}>
            {formatMoney(row.amount)}
          </span>
          <span className={cn('px-2 py-2 text-right tabular-nums', COLUMN_WIDTHS.amount)}>
            {formatMoney(row.ytdAmount)}
          </span>
          <span className={cn('px-2 py-2 text-right tabular-nums', COLUMN_WIDTHS.amount)}>
            {formatMoney(row.previousAmount)}
          </span>
        </CollapsibleTrigger>
        {hasDetails ? (
          <CollapsibleContent>
            <div className="bg-muted/30 px-4 py-2">
              <p className="mb-1 text-xs text-muted-foreground">
                行次 {row.rowNo} 取数明细（公式：{row.formula || '-'}）
              </p>
              <div className="flex flex-col">
                {(row.details ?? []).map((detail) => (
                  <div
                    key={`${detail.accountCode}-${detail.accountName}`}
                    className="flex items-center gap-4 border-b border-dashed py-1 text-xs last:border-b-0"
                  >
                    <span className="w-[120px] tabular-nums text-muted-foreground">
                      {detail.accountCode}
                    </span>
                    <span className="min-w-[200px] flex-1">{detail.accountName}</span>
                    <span className="w-[150px] text-right tabular-nums">
                      {formatMoney(detail.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </CollapsibleContent>
        ) : null}
      </div>
    </Collapsible>
  );
};

/** 把连续同 section 的行聚成块，用于插分组小标题行 */
function groupBySection(
  rows: ReportRow[],
  sections: Map<string, string>,
): Array<{ section: string; rows: ReportRow[] }> {
  const groups: Array<{ section: string; rows: ReportRow[] }> = [];
  for (const row of rows) {
    const section = sections.get(row.rowNo) ?? '';
    const last = groups[groups.length - 1];
    if (last && last.section === section) last.rows.push(row);
    else groups.push({ section, rows: [row] });
  }
  return groups;
}

interface ReportSheetViewProps {
  sheet: ReportSheet;
  reportCode: ReportCode;
  /** rowNo → section（来自报表模板接口，用于分组小标题） */
  sections: Map<string, string>;
}

const ReportSheetView: React.FC<ReportSheetViewProps> = ({
  sheet,
  reportCode,
  sections,
}) => {
  const meta = amountColumns(reportCode);
  const rows = sheet.rows ?? [];
  const groups = groupBySection(rows, sections);

  return (
    <div className="flex flex-col gap-4">
      {!sheet.balanced ? (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          <AlertTriangle className="size-4 shrink-0" />
          报表未通过会计恒等式校验，请检查凭证
        </div>
      ) : null}

      {(sheet.checks ?? []).length > 0 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {sheet.checks.map((check) => (
            <CheckCard key={check.code} check={check} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">该报表本次未返回校验项。</p>
      )}

      <div className="rounded-lg border bg-card">
        <div className="flex items-center text-xs font-medium text-muted-foreground">
          <span className={cn('px-2 py-2', COLUMN_WIDTHS.no)}>行次</span>
          <span className={cn('px-2 py-2', COLUMN_WIDTHS.name)}>项目</span>
          <span className={cn('px-2 py-2 text-right', COLUMN_WIDTHS.amount)}>
            {meta.thirdLabel}
          </span>
          <span className={cn('px-2 py-2 text-right', COLUMN_WIDTHS.amount)}>
            {meta.fourthLabel}
          </span>
          <span className={cn('px-2 py-2 text-right', COLUMN_WIDTHS.amount)}>
            {meta.fifthLabel}
          </span>
        </div>
        {groups.map((group) => {
          const label = SECTION_LABELS[group.section] ?? group.section;
          return (
            <div key={group.section || 'default'}>
              {label ? (
                <div className="border-y bg-muted/40 px-2 py-1 text-xs font-semibold">
                  {label}
                </div>
              ) : null}
              {group.rows.map((row) => (
                <ReportRowItem key={row.rowNo} row={row} meta={meta} />
              ))}
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        报表生成时间：
        {sheet.generatedAt ? new Date(sheet.generatedAt).toLocaleString('zh-CN') : '-'}
        ；纳税主体：{sheet.taxEntityName ?? '全部（未指定主体）'}
      </p>
    </div>
  );
};

const ReportsPage: React.FC = () => {
  const { user } = useAuth();
  const [period, setPeriod] = useState<string>(currentPeriod());
  const [taxEntityId, setTaxEntityId] = useState<string>(ALL_ENTITIES);
  const [tab, setTab] = useState<ReportCode>('balance_sheet');
  // P0-2：默认只取已过账凭证；打开开关后按「含草稿预览」口径取数
  const [includeDraft, setIncludeDraft] = useState(false);

  const args: ReportQueryArgs = useMemo(
    () => ({
      period,
      taxEntityId: taxEntityId === ALL_ENTITIES ? undefined : taxEntityId,
      includeDraft,
    }),
    [period, taxEntityId, includeDraft],
  );

  const entities = useAsyncData<TaxEntity[]>(() => masterDataApi.listTaxEntities(), []);

  const { data: sheet, loading, error, reload } = useAsyncData<ReportResult>(
    () => financeReportsApi.getReport(tab, args),
    [tab, args],
  );

  // 模板提供行分组（section），报表结果本身不带该字段，用模板做映射补分组小标题
  const templates = useAsyncData(
    () => financeReportsApi.listReportTemplates(tab),
    [tab],
  );

  const sections = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of templates.data ?? []) map.set(row.rowNo, row.section);
    return map;
  }, [templates.data]);

  const rows = sheet?.rows ?? [];

  const handleExport = () => {
    if (!sheet || rows.length === 0) {
      toast.error('当前报表无可导出数据');
      return;
    }
    const meta = amountColumns(tab);
    const checks = sheet.checks ?? [];
    const columns: ExcelSheetColumn<ReportRow>[] = [
      { header: '报表名称', value: () => sheet.reportName },
      { header: '期间', value: () => sheet.period },
      { header: '纳税主体', value: () => sheet.taxEntityName ?? '' },
      { header: '行次', value: (row) => row.rowNo },
      {
        header: '项目',
        value: (row) => `${'　'.repeat(Math.max(0, row.indent ?? 0))}${row.rowName}`,
      },
      { header: meta.thirdLabel, value: (row) => row.amount },
      { header: meta.fourthLabel, value: (row) => row.ytdAmount },
      { header: meta.fifthLabel, value: (row) => row.previousAmount },
      {
        header: '校验结果',
        value: () =>
          checks.length === 0
            ? '无校验项'
            : checks
                .map(
                  (check) =>
                    `${check.label}:${check.passed ? '通过' : `不通过(差额${check.difference})`}`,
                )
                .join('；'),
      },
      { header: '导出人', value: () => user?.userName ?? '' },
    ];
    exportRowsToXlsx(
      `${sheet.reportName}_${sheet.period}.xlsx`,
      sheet.reportName,
      columns,
      rows,
    );
  };

  const handleRefresh = () => {
    void entities.reload();
    void reload();
  };

  const entityName =
    entities.data?.find((item) => item.id === taxEntityId)?.name ??
    (taxEntityId === ALL_ENTITIES ? '全部主体' : '-');

  return (
    <PageShell
      title="财务报表"
      description={`资产负债表、利润表、现金流量表（取数来源：${includeDraft ? '已过账 + 草稿预览' : '已过账凭证'} + 报表模板公式）`}
    >
      <FilterBar>
        <div className="flex items-center gap-2">
          <Label htmlFor="reports-period" className="text-xs text-muted-foreground">
            期间
          </Label>
          <PeriodSelect id="reports-period" value={period} onChange={setPeriod} />
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="reports-entity" className="text-xs text-muted-foreground">
            纳税主体
          </Label>
          <Select value={taxEntityId} onValueChange={setTaxEntityId}>
            <SelectTrigger id="reports-entity" className="w-[220px]">
              <SelectValue placeholder="全部主体" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_ENTITIES}>全部主体（不按主体过滤）</SelectItem>
              {(entities.data ?? []).map((entity) => (
                <SelectItem key={entity.id} value={entity.id}>
                  {entity.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="reports-include-draft"
            checked={includeDraft}
            onCheckedChange={setIncludeDraft}
          />
          <Label htmlFor="reports-include-draft" className="text-xs text-muted-foreground">
            含草稿预览
          </Label>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleRefresh}
          disabled={loading}
        >
          <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
          刷新
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleExport}
          disabled={rows.length === 0}
        >
          <Download className="size-4" />
          导出 Excel
        </Button>
        <span className="ml-auto text-xs text-muted-foreground">
          当前口径：{period} · {entityName}
        </span>
      </FilterBar>

      {includeDraft ? (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-2 text-sm text-amber-700 dark:text-amber-400"
        >
          <AlertTriangle className="size-4 shrink-0" />
          当前为「含草稿预览」口径：已包含<b>未过账草稿凭证</b>，不得作为正式报表对外报送。
        </div>
      ) : null}

      {entities.error ? (
        <p className="text-sm text-destructive">
          纳税主体列表加载失败：{entities.error}（可继续按「全部主体」查询）
        </p>
      ) : null}

      <Tabs value={tab} onValueChange={(value) => setTab(value as ReportCode)}>
        <TabsList>
          {REPORT_TABS.map((item) => (
            <TabsTrigger key={item.code} value={item.code}>
              {item.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {REPORT_TABS.map((item) => (
          <TabsContent key={item.code} value={item.code}>
            <DataBoundary
              loading={loading}
              error={error}
              skeleton="table"
              empty={!loading && !error && rows.length === 0}
              emptyText={`期间 ${period} 未取到 ${item.label} 数据：请确认报表模板已种子化、相关凭证已过账`}
              onRetry={() => void reload()}
            >
              {sheet ? (
                <div className="flex flex-col gap-4">
                  <div className="flex items-center gap-2">
                    <SectionTitle>{sheet.reportName}</SectionTitle>
                    {sheet.balanced ? (
                      <Badge variant="success">
                        <CheckCircle2 className="mr-1 size-3" />
                        恒等式校验通过
                      </Badge>
                    ) : (
                      <Badge variant="destructive">
                        <XCircle className="mr-1 size-3" />
                        恒等式校验未通过
                      </Badge>
                    )}
                  </div>
                  <ReportSheetView
                    sheet={sheet}
                    reportCode={item.code}
                    sections={sections}
                  />
                </div>
              ) : null}
            </DataBoundary>
          </TabsContent>
        ))}
      </Tabs>
    </PageShell>
  );
};

export default ReportsPage;
