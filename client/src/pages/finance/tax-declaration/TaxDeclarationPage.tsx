import React, { useMemo, useState } from 'react';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileCheck2,
  Receipt,
  RefreshCw,
  TrendingDown,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import PageShell from '@client/src/components/PageShell';
import TaxRiskPanel from './TaxRiskPanel';
import FilterBar from '@client/src/components/erp/FilterBar';
import PeriodSelect from '@client/src/components/erp/PeriodSelect';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import StatCard from '@client/src/components/erp/StatCard';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@client/src/components/ui/table';
import { Textarea } from '@client/src/components/ui/textarea';
import {
  exportRowsToXlsx,
  type ExcelSheetColumn,
} from '@client/src/components/excel/excel-utils';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import * as financeReportsApi from '@client/src/api/finance-reports';
import * as masterDataApi from '@client/src/api/master-data';
import { cn } from '@client/src/lib/utils';
import { currentPeriod, formatMoney } from '@client/src/utils/format';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type {
  TaxEntity,
  VatDeclarationHistoryItem,
  VatDeclarationLine,
  VatDeclarationResult,
} from '@shared/api.interface';

const ALL_ENTITIES = '__all__';
const MIN_REASON_LENGTH = 4;

const CATEGORY_LABELS: Record<VatDeclarationLine['category'], string> = {
  output: '销项',
  input: '进项',
  transfer: '进项税额转出',
  credit: '留抵',
  payable: '应纳税额',
};

const VAT_LINE_COLUMNS: ExcelSheetColumn<VatDeclarationLine>[] = [
  { header: '行次', value: (row) => row.rowNo },
  { header: '项目', value: (row) => row.rowName },
  { header: '类别', value: (row) => CATEGORY_LABELS[row.category] ?? row.category },
  { header: '申报表金额', value: (row) => row.amount },
  { header: '总账口径金额', value: (row) => row.ledgerAmount },
  { header: '差异', value: (row) => row.difference },
  { header: '已说明', value: (row) => (row.explained ? '是' : '否') },
];

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
  const lines = data?.lines ?? [];

  const differenceLines = useMemo(
    () => lines.filter((line) => line.difference !== 0),
    [lines],
  );

  const handleExport = () => {
    if (!data || lines.length === 0) {
      toast.error('当前申报底稿无可导出数据');
      return;
    }
    exportRowsToXlsx(
      `增值税申报底稿_${data.period}.xlsx`,
      '增值税申报底稿',
      VAT_LINE_COLUMNS,
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

  return (
    <PageShell
      title="增值税申报"
      description="发票台账口径与总账口径的销项/进项比对底稿，确认后留痕可追溯；含 D-06 税务风险扫描"
    >
      <TaxRiskPanel period={period} />

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
              <SelectItem value={ALL_ENTITIES}>全部主体（不按主体过滤）</SelectItem>
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
        <CanCapabilityWrite capability="finance_write">
          <Button
            type="button"
            size="sm"
            onClick={openConfirmDialog}
            disabled={!data || data.status === 'confirmed'}
          >
            <FileCheck2 className="size-4" />
            {data?.status === 'confirmed' ? '底稿已确认' : '确认底稿'}
          </Button>
        </CanCapabilityWrite>
      </FilterBar>

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
            <div className="grid grid-cols-2 gap-4 xl:grid-cols-5">
              <StatCard
                label="销项税额（发票台账口径）"
                value={formatMoney(data.outputTaxFromInvoices)}
                icon={TrendingUp}
                tone="primary"
                hint={`总账口径 ${formatMoney(data.outputTaxFromLedger)}`}
              />
              <StatCard
                label="进项税额"
                value={formatMoney(data.inputTaxFromInvoices)}
                icon={TrendingDown}
                tone="info"
                hint={`总账口径 ${formatMoney(data.inputTaxFromLedger)}`}
              />
              <StatCard
                label="上期留抵"
                value={formatMoney(data.previousCredit)}
                icon={Wallet}
                tone="neutral"
                hint="上一期间未抵扣完的进项"
              />
              <StatCard
                label="本期应纳税额"
                value={formatMoney(data.payableTax)}
                icon={Receipt}
                tone={data.payableTax > 0 ? 'warning' : 'success'}
                hint="销项 − 进项 − 上期留抵"
              />
              <StatCard
                label="期末留抵"
                value={formatMoney(data.closingCredit)}
                icon={Wallet}
                tone={data.closingCredit > 0 ? 'info' : 'neutral'}
                hint="结转下期继续抵扣"
              />
            </div>

            <div className="rounded-lg border bg-card">
              <div className="flex items-center gap-2 border-b px-4 py-3">
                <SectionTitle>申报表行次</SectionTitle>
                <Badge variant={data.reconciled ? 'success' : 'destructive'}>
                  {data.reconciled ? '台账与总账一致' : `${differenceLines.length} 行存在差异`}
                </Badge>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[80px]">行次</TableHead>
                    <TableHead>项目</TableHead>
                    <TableHead className="w-[120px]">类别</TableHead>
                    <TableHead className="w-[150px] text-right">申报表金额</TableHead>
                    <TableHead className="w-[150px] text-right">总账口径金额</TableHead>
                    <TableHead className="w-[140px] text-right">差异</TableHead>
                    <TableHead className="w-[90px]">已说明</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {lines.map((line) => (
                    <TableRow
                      key={line.rowNo}
                      className={cn(line.difference !== 0 && 'bg-warning/10')}
                    >
                      <TableCell className="tabular-nums">{line.rowNo}</TableCell>
                      <TableCell>{line.rowName}</TableCell>
                      <TableCell>{CATEGORY_LABELS[line.category] ?? line.category}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(line.amount)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatMoney(line.ledgerAmount)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          'text-right tabular-nums',
                          line.difference !== 0
                            ? 'font-medium text-warning'
                            : 'text-muted-foreground',
                        )}
                      >
                        {formatMoney(line.difference)}
                      </TableCell>
                      <TableCell>
                        {line.explained ? (
                          <Badge variant="success">已说明</Badge>
                        ) : (
                          <Badge variant="secondary">未说明</Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell colSpan={3}>合计</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(lines.reduce((sum, line) => sum + line.amount, 0))}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(lines.reduce((sum, line) => sum + line.ledgerAmount, 0))}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(lines.reduce((sum, line) => sum + line.difference, 0))}
                    </TableCell>
                    <TableCell />
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          </div>
        ) : null}
      </DataBoundary>

      <div className="flex flex-col gap-4">
        <SectionTitle>历史申报底稿</SectionTitle>
        <DataBoundary
          loading={history.loading}
          error={history.error}
          empty={!history.loading && !history.error && (history.data ?? []).length === 0}
          emptyText="暂无已生成或已确认的申报底稿记录"
          onRetry={() => void history.reload()}
        >
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">期间</TableHead>
                  <TableHead>纳税主体</TableHead>
                  <TableHead className="w-[100px]">状态</TableHead>
                  <TableHead className="w-[130px] text-right">销项税额</TableHead>
                  <TableHead className="w-[130px] text-right">进项税额</TableHead>
                  <TableHead className="w-[130px] text-right">应纳税额</TableHead>
                  <TableHead className="w-[130px] text-right">期末留抵</TableHead>
                  <TableHead className="w-[110px]">台账核对</TableHead>
                  <TableHead className="min-w-[200px]">差异说明</TableHead>
                  <TableHead className="w-[150px]">生成人 / 时间</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(history.data ?? []).map((row) => (
                  <TableRow key={`${row.period}-${row.taxEntityId ?? 'all'}`}>
                    <TableCell className="tabular-nums">{row.period}</TableCell>
                    <TableCell>{row.taxEntityName ?? '全部主体'}</TableCell>
                    <TableCell>
                      <Badge variant={row.status === 'confirmed' ? 'success' : 'secondary'}>
                        {row.status === 'confirmed' ? '已确认' : '草稿'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(row.outputTax)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(row.inputTax)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(row.payableTax)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(row.closingCredit)}
                    </TableCell>
                    <TableCell>
                      {row.reconciled ? (
                        <Badge variant="success">一致</Badge>
                      ) : (
                        <Badge variant="destructive">有差异</Badge>
                      )}
                    </TableCell>
                    <TableCell className="max-w-[260px] truncate">
                      {row.differenceReason ?? '-'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.generatedBy ?? '-'}
                      <br />
                      {row.generatedAt
                        ? new Date(row.generatedAt).toLocaleString('zh-CN')
                        : '-'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </DataBoundary>
      </div>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!open) setConfirmOpen(false);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>确认申报底稿</DialogTitle>
            <DialogDescription>
              期间 {period}
              {data?.taxEntityName ? ` · ${data.taxEntityName}` : ''}
              ，确认后底稿进入已确认状态并记录留痕；差异说明必填。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor="vat-reason">
              差异说明（至少 {MIN_REASON_LENGTH} 个字）
            </Label>
            <Textarea
              id="vat-reason"
              rows={4}
              value={reason}
              placeholder="例如：本期存在跨期开票，发票在次月确认收入，差异已核对无误"
              onChange={(e) => {
                setReason(e.target.value);
                if (reasonError && e.target.value.trim().length >= MIN_REASON_LENGTH) {
                  setReasonError(null);
                }
              }}
            />
            {reasonError ? <p className="text-xs text-destructive">{reasonError}</p> : null}
            {!data?.reconciled ? (
              <p className="text-xs text-warning">
                当前台账与总账口径不一致，请确认差异原因已核实。
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={submitting}
            >
              取消
            </Button>
            <Button type="button" onClick={() => void handleConfirm()} disabled={submitting}>
              {submitting ? '提交中…' : '确认底稿'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
};

export default TaxDeclarationPage;
