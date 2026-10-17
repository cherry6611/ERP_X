import React, { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, Download, FileCheck2, RefreshCw } from 'lucide-react';
import PageShell from '@client/src/components/PageShell';
import VatLineTable from './components/VatLineTable';
import VatHistorySection from './components/VatHistorySection';
import VatConfirmDialog from './components/VatConfirmDialog';
import VatSummaryCards from './components/VatSummaryCards';
import { VAT_LINE_EXPORT_COLUMNS } from './tax-declaration-export-columns';
import FilterBar from '@client/src/components/erp/FilterBar';
import PeriodSelect from '@client/src/components/erp/PeriodSelect';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { exportRowsToXlsx } from '@client/src/components/excel/excel-utils';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import * as financeReportsApi from '@client/src/api/finance-reports';
import * as masterDataApi from '@client/src/api/master-data';
import { cn } from '@client/src/lib/utils';
import { currentPeriod, formatMoney } from '@client/src/utils/format';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type {
  TaxEntity,
  VatDeclarationHistoryItem,
  VatDeclarationResult,
} from '@shared/api.interface';

const ALL_ENTITIES = '__all__';
const MIN_REASON_LENGTH = 4;

const TaxDeclarationPage: React.FC = () => {
  const [period, setPeriod] = useState<string>(currentPeriod());
  const [taxEntityId, setTaxEntityId] = useState<string>(ALL_ENTITIES);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const entityArg = taxEntityId === ALL_ENTITIES ? undefined : taxEntityId;

  const entities = useAsyncData<TaxEntity[]>(() => masterDataApi.listTaxEntities(), []);

  const declaration = useAsyncData<VatDeclarationResult>(
    () => financeReportsApi.getVatDeclaration({ period, taxEntityId: entityArg }),
    [period, entityArg],
  );

  const history = useAsyncData<VatDeclarationHistoryItem[]>(
    () => financeReportsApi.listVatDeclarations(24),
    [],
  );

  const data = declaration.data;
  // §5.5：`?? []` 每次渲染产生新数组 → 会让下游 useMemo（列定义/数据源）失效。
  const lines = useMemo(() => data?.lines ?? [], [data]);

  const differenceLines = useMemo(
    () => lines.filter((line) => line.difference !== 0),
    [lines],
  );

  /* §5.9（F8）：导出列定义已移到 `./tax-declaration-export-columns`
   * （零运行时依赖，可被单测逐列断言 —— 列序错或取错字段在界面上看不出来）。*/
  const handleExport = () => {
    if (!data || lines.length === 0) {
      toast.error('当前申报底稿无可导出数据');
      return;
    }
    exportRowsToXlsx(
      `增值税申报底稿_${data.period}.xlsx`,
      '增值税申报底稿',
      VAT_LINE_EXPORT_COLUMNS,
      lines,
    );
  };

  const openConfirmDialog = () => {
    setReason('');
    setReasonError(null);
    setConfirmOpen(true);
  };

  const handleConfirm = async () => {
    const trimmed = reason.trim();
    if (trimmed.length < MIN_REASON_LENGTH) {
      setReasonError(`差异说明至少 ${MIN_REASON_LENGTH} 个字`);
      return;
    }
    setSubmitting(true);
    try {
      const result = await financeReportsApi.confirmVatDeclaration({
        period,
        taxEntityId: entityArg,
        differenceReason: trimmed,
      });
      toast.success(
        result.status === 'confirmed'
          ? `期间 ${result.period} 的申报底稿已确认`
          : '申报底稿已提交确认',
      );
      setConfirmOpen(false);
      await declaration.reload();
      await history.reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '确认底稿失败'));
    } finally {
      setSubmitting(false);
    }
  };

  /**
   * §5.5（F4）「申报表行次」与「申报历史」两块列定义已移到
   * `./tax-declaration-columns`（原为这里的两个 `useMemo`，各约 80 行）。
   *
   * ⚠️ **引用稳定性与原先等价**：原 `useMemo(..., [])` 是空依赖，
   * 即"整个组件生命周期内同一个数组引用"（这正是 §5.5 注释担心的
   * "`?? []` 每次渲染产生新数组 → 让下游 useMemo 失效"的另一面：
   * 列定义换新引用会让 antd 重置排序/筛选状态）。搬成模块级常量后，
   * 引用跨渲染**乃至跨组件实例**都稳定 —— 等价且更强，故父组件不再需要
   * `useMemo` 包裹（包一层空依赖 `useMemo` 只是多一次无意义的比较）。
   * 两个常量的标识符没有被引用进任何 `useMemo` 回调体，因此不存在
   * "常量必须进依赖数组"的问题。
   */
  return (
    <PageShell
      title="增值税申报"
      description="发票台账口径与总账口径的销项/进项比对底稿，确认后留痕可追溯"
      actions={
        /*
         * 「确认底稿」是本页唯一写操作，放在页头 `actions` 插槽。
         */
        <>
          <CanCapabilityWrite capability="finance_write">
            <Button
              type="button"
              onClick={openConfirmDialog}
              /*
               * 附加税费须按纳税主体逐户计提（城建税率按主体分档，跨主体无法合并），
               * 未指定主体时后端必然拒绝确认，所以这里直接禁掉，避免用户点完才吃 400。
               */
              disabled={
                !data || data.status === 'confirmed' || taxEntityId === ALL_ENTITIES
              }
            >
              <FileCheck2 className="size-4" />
              {data?.status === 'confirmed' ? '底稿已确认' : '确认底稿'}
            </Button>
          </CanCapabilityWrite>
        </>
      }
    >
      <FilterBar>
        <div className="flex items-center gap-2">
          <Label htmlFor="vat-period" className="text-xs text-muted-foreground">
            期间
          </Label>
          <PeriodSelect id="vat-period" value={period} onChange={setPeriod} />
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="vat-entity" className="text-xs text-muted-foreground">
            纳税主体
          </Label>
          <Select value={taxEntityId} onValueChange={setTaxEntityId}>
            <SelectTrigger id="vat-entity" className="w-[220px]">
              <SelectValue placeholder="全部主体" />
            </SelectTrigger>
            <SelectContent>
              {/*
                ⚠️ 文案修正：这里传出去的 `entityArg` 是 `undefined`，
                后端据此返回**全部主体**（不做收窄），而不是"仅未归属主体"。
                原文案「未指定主体（仅统计未归属主体的凭证）」与实现相反 ——
                那会让使用者以为选了它只会看到未归属的凭证。
              */}
              <SelectItem value={ALL_ENTITIES}>全部主体（不按主体收窄）</SelectItem>
              {(entities.data ?? []).map((entity) => (
                <SelectItem key={entity.id} value={entity.id}>
                  {entity.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            void declaration.reload();
            void history.reload();
          }}
          disabled={declaration.loading}
        >
          <RefreshCw className={cn('size-4', declaration.loading && 'animate-spin')} />
          刷新
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleExport}
          disabled={lines.length === 0}
        >
          <Download className="size-4" />
          导出 Excel
        </Button>
      </FilterBar>

      {taxEntityId === ALL_ENTITIES ? (
        <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/5 px-4 py-2 text-sm text-warning">
          <AlertTriangle className="size-4" />
          附加税费须按纳税主体计提，请先选择具体纳税主体后再确认底稿
        </div>
      ) : null}

      {data?.status === 'confirmed' ? (
        <div className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/5 px-4 py-2 text-sm text-success">
          <CheckCircle2 className="size-4" />
          该期间申报底稿已确认（生成人：{data.generatedBy ?? '-'}）
        </div>
      ) : null}

      {data && !data.reconciled ? (
        <div
          role="alert"
          className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          <span className="flex items-center gap-2 font-medium">
            <AlertTriangle className="size-4" />
            发票台账口径与总账口径存在差异，确认底稿前请先核实
          </span>
          <ul className="ml-6 list-disc">
            {(data.differences ?? []).map((item) => (
              <li key={item.code}>
                {item.label}：差异 {formatMoney(item.amount)}
                {item.reason ? `（说明：${item.reason}）` : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <DataBoundary
        loading={declaration.loading}
        error={declaration.error}
        skeleton="card"
        empty={false}
        onRetry={() => void declaration.reload()}
      >
        {data ? (
          <div className="flex flex-col gap-6">
            {/* §5.9：六张指标卡（含各自的口径提示）已抽到 ./components/VatSummaryCards */}
            <VatSummaryCards data={data} />

            {/*
              T9：小规模免征额度三态提示。
              `unknown` 是最重要的一态 —— 它意味着**要件缺失导致长期多缴**，
              而不是"本该如此"。必须显式提示补录，否则没人会发现。
            */}
            {data.smallScaleExemption === 'unknown' ? (
              <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/5 px-4 py-3 text-sm text-warning">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                <span>
                  小规模免征额度未判定，本期按偏严口径
                  <strong>未减免</strong>两项附加（方向不会少缴，但可能多缴）。
                  {data.smallScaleExemptionReason
                    ? `原因：${data.smallScaleExemptionReason}`
                    : ''}
                </span>
              </div>
            ) : null}
            {data.smallScaleExemption === 'within' ? (
              <div className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/5 px-4 py-2 text-sm text-success">
                <CheckCircle2 className="size-4" />
                小规模免征额度内：已免征教育费附加与地方教育附加（城建税仍照征）
              </div>
            ) : null}
            <div className="rounded-lg border bg-card">
              <div className="flex items-center gap-2 border-b px-4 py-3">
                <SectionTitle>申报表行次</SectionTitle>
                <Badge variant={data.reconciled ? 'success' : 'destructive'}>
                  {data.reconciled ? '台账与总账一致' : `${differenceLines.length} 行存在差异`}
                </Badge>
              </div>
              {/*
                §5.5（F4）：申报表行次改 antd `<Table>`。
                · 原先用 shadcn `Table`（纯样式表）：无排序/固定列/空态钩子。
                  本表 30+ 行次且金额列需横向滚动，固定「行次/项目」两列
                  是**可读性**需求（原先滚动后不知道在看哪一行）；
                · 差异行高亮从 `className={cn(...)}` 改为 `rowClassName` ——
                  antd 的等价写法，且能同时覆盖 `&:hover` 状态；
                · 合计行用 `Table.Summary`（antd 原生聚合行）。

                §5.9：表格本体（含"合计只汇总 summable 行"这条易错口径）
                已抽到 `./components/VatLineTable`。
              */}
              <VatLineTable lines={lines} />
            </div>
          </div>
        ) : null}
      </DataBoundary>

      {/* §5.9：历史底稿区块（含三态与分页文案）已抽到 ./components/VatHistorySection */}
      <VatHistorySection
        items={history.data ?? []}
        loading={history.loading}
        error={history.error}
        onRetry={() => void history.reload()}
      />

      {/* §5.9：「确认底稿」弹窗（含差异说明字数规则）已抽到 ./components/VatConfirmDialog */}
      <VatConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        period={period}
        taxEntityName={data?.taxEntityName}
        reconciled={data?.reconciled ?? true}
        reason={reason}
        onReasonChange={setReason}
        reasonError={reasonError}
        onReasonErrorClear={() => setReasonError(null)}
        minReasonLength={MIN_REASON_LENGTH}
        submitting={submitting}
        onConfirm={() => void handleConfirm()}
      />
    </PageShell>
  );
};

export default TaxDeclarationPage;
