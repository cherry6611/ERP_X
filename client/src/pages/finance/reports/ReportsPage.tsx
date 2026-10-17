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
import UnassignedEntityVoucherBanner from '@client/src/components/erp/UnassignedEntityVoucherBanner';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@client/src/components/ui/tabs';
import {
  exportRowsToXlsx,
  type ExcelSheetColumn,
} from '@client/src/components/excel/excel-utils';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import {
  amountColumns,
  ReportSheetView,
} from './components/report-sheet';
import { useAuth } from '@client/src/platform/auth';
import * as financeReportsApi from '@client/src/api/finance-reports';
import * as masterDataApi from '@client/src/api/master-data';
import { cn } from '@client/src/lib/utils';
import { currentPeriod } from '@client/src/utils/format';

import type {
  BalanceSheetResult,
  CashFlowResult,
  IncomeStatementResult,
  ReportCode,
  ReportQueryArgs,
  ReportRow,
  TaxEntity,
} from '@shared/api.interface';

type ReportResult = BalanceSheetResult | IncomeStatementResult | CashFlowResult;

const ALL_ENTITIES = '__all__';

const REPORT_TABS: Array<{ code: ReportCode; label: string }> = [
  { code: 'balance_sheet', label: '资产负债表' },
  { code: 'income_statement', label: '利润表' },
  { code: 'cash_flow', label: '现金流量表' },
];


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
              {/*
                修复误导文案：原先写「全部主体（不按主体过滤）」，但后端在以
                `taxEntityId` 缺省调用时是 `WHERE tax_entity_id IS NULL` ——
                即**只统计未归属主体的凭证**，已归属某主体的凭证会被全部排除。
                写着"不过滤"却实际过滤，用户看到报表全 0 会误判为"系统没数据"，
                而真正原因是凭证都挂了主体。文案改为如实描述实际行为。
              */}
              <SelectItem value={ALL_ENTITIES}>
                未指定主体（仅统计未归属主体的凭证）
              </SelectItem>
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

      {/* B-1 / REQ-BE-01：未归属主体的凭证不会进任何主体的报表，必须在报表页显著提示 */}
      <UnassignedEntityVoucherBanner period={period} />

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
