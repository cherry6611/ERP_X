import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Download, RefreshCw, Search } from 'lucide-react';
import PageShell from '@client/src/components/PageShell';
import FilterBar from '@client/src/components/erp/FilterBar';
import PeriodSelect from '@client/src/components/erp/PeriodSelect';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@client/src/components/ui/pagination';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@client/src/components/ui/tabs';
import AuxCombinationPanel from './AuxCombinationPanel';
import {
  exportRowsToXlsx,
  type ExcelSheetColumn,
} from '@client/src/components/excel/excel-utils';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import * as financeReportsApi from '@client/src/api/finance-reports';
import * as masterDataApi from '@client/src/api/master-data';
import { cn } from '@client/src/lib/utils';
import { currentPeriod, formatMoney } from '@client/src/utils/format';
import type {
  AccountBalanceRow,
  AccountBalanceSheet,
  AuxBalanceRow,
  AuxBalanceSheet,
  AuxDimensionItem,
  DetailLedgerLine,
  DetailLedgerResult,
  GeneralLedgerRow,
  GeneralLedgerSheet,
  TaxEntity,
} from '@shared/api.interface';

const ALL_ENTITIES = '__all__';
const PAGE_SIZE = 50;

type LedgerTab = 'balance' | 'general' | 'detail' | 'aux' | 'aux-combination';

const DIRECTION_LABELS: Record<string, string> = {
  debit: '借',
  credit: '贷',
  flat: '平',
};

/** 借贷余额按方向拼前缀，避免金额正负号在账簿里产生歧义 */
function sideAmount(value: number, side: string): string {
  if (!value) return '-';
  return `${DIRECTION_LABELS[side] ?? ''} ${formatMoney(Math.abs(value))}`.trim();
}

function amount(value: number | null | undefined): string {
  return value ? formatMoney(value) : '-';
}

function voucherDate(value: string | null): string {
  if (!value) return '-';
  return value.slice(0, 10);
}

/** 科目余额表小计：按编码前缀分组，仅当父行存在且子行不全为叶子时才有意义 */
function buildLeafSubtotals(items: AccountBalanceRow[]): Map<string, AccountBalanceRow[]> {
  const subtotals = new Map<string, AccountBalanceRow[]>();
  for (const parent of items) {
    if (parent.isLeaf) continue;
    const children = items.filter(
      (row) => row.accountCode !== parent.accountCode && row.accountCode.startsWith(parent.accountCode),
    );
    const leafChildren = children.filter((row) => row.isLeaf);
    if (leafChildren.length > 1) subtotals.set(parent.accountCode, leafChildren);
  }
  return subtotals;
}

function sumRows(rows: AccountBalanceRow[]): {
  openingDebit: number;
  openingCredit: number;
  debitOccur: number;
  creditOccur: number;
  closingDebit: number;
  closingCredit: number;
} {
  return rows.reduce(
    (acc, row) => ({
      openingDebit: acc.openingDebit + row.openingDebit,
      openingCredit: acc.openingCredit + row.openingCredit,
      debitOccur: acc.debitOccur + row.debitOccur,
      creditOccur: acc.creditOccur + row.creditOccur,
      closingDebit: acc.closingDebit + row.closingDebit,
      closingCredit: acc.closingCredit + row.closingCredit,
    }),
    {
      openingDebit: 0,
      openingCredit: 0,
      debitOccur: 0,
      creditOccur: 0,
      closingDebit: 0,
      closingCredit: 0,
    },
  );
}

const LedgersPage: React.FC = () => {
  const navigate = useNavigate();
  const [tab, setTab] = useState<LedgerTab>('balance');
  const [period, setPeriod] = useState<string>(currentPeriod());
  const [taxEntityId, setTaxEntityId] = useState<string>(ALL_ENTITIES);
  const [level, setLevel] = useState<number>(6);
  const [keyword, setKeyword] = useState('');
  const [accountCode, setAccountCode] = useState<string>('');
  const [page, setPage] = useState<number>(1);
  const [includeChildren, setIncludeChildren] = useState(false);
  const [dimension, setDimension] = useState<string>('');

  const args = useMemo(
    () => ({
      period,
      taxEntityId: taxEntityId === ALL_ENTITIES ? undefined : taxEntityId,
    }),
    [period, taxEntityId],
  );

  const entities = useAsyncData<TaxEntity[]>(() => masterDataApi.listTaxEntities(), []);
  const dimensions = useAsyncData<AuxDimensionItem[]>(
    () => financeReportsApi.listAuxDimensions(),
    [],
  );

  // 只加载当前 Tab 的数据：账簿查询是四次扫描，四个都拉会拖慢首屏
  const balance = useAsyncData<AccountBalanceSheet | null>(
    () =>
      tab === 'balance'
        ? financeReportsApi.getAccountBalance({ ...args, level })
        : Promise.resolve(null),
    [args, level, tab],
  );
  const general = useAsyncData<GeneralLedgerSheet | null>(
    () =>
      tab === 'general'
        ? financeReportsApi.getGeneralLedger(args)
        : Promise.resolve(null),
    [args, tab],
  );
  const detail = useAsyncData<DetailLedgerResult | null>(
    () =>
      tab === 'detail' && accountCode
        ? financeReportsApi.getDetailLedger({
            accountCode,
            period,
            page,
            pageSize: PAGE_SIZE,
            taxEntityId: args.taxEntityId,
            includeChildren,
          })
        : Promise.resolve(null),
    [accountCode, period, page, includeChildren, args, tab],
  );
  const aux = useAsyncData<AuxBalanceSheet | null>(
    () =>
      tab === 'aux' && dimension
        ? financeReportsApi.getAuxBalance({ ...args, dimension })
        : Promise.resolve(null),
    [args, dimension, tab],
  );

  /** 三级联动第一跳：总账 → 明细账（带科目编码），再到凭证详情 */
  const openDetailLedger = (code: string) => {
    setAccountCode(code);
    setPage(1);
    setTab('detail');
  };

  const reloadActive = () => {
    if (tab === 'balance') void balance.reload();
    else if (tab === 'general') void general.reload();
    else if (tab === 'detail') void detail.reload();
    else void aux.reload();
  };

  const balanceRows = balance.data?.items ?? [];
  const leafSubtotals = useMemo(() => buildLeafSubtotals(balanceRows), [balanceRows]);
  const filteredBalanceRows = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    if (!key) return balanceRows;
    return balanceRows.filter(
      (row) =>
        row.accountCode.toLowerCase().includes(key) ||
        row.accountName.toLowerCase().includes(key),
    );
  }, [balanceRows, keyword]);

  const generalRows = general.data?.items ?? [];

  const detailRows = detail.data?.items ?? [];

  const auxRows = aux.data?.items ?? [];

  /* ========== 导出 ========== */

  const exportBalance = () => {
    if (filteredBalanceRows.length === 0) {
      toast.error('当前筛选结果为空，无可导出数据');
      return;
    }
    const columns: ExcelSheetColumn<AccountBalanceRow>[] = [
      { header: '期间', value: () => period },
      { header: '科目编码', value: (row) => row.accountCode },
      { header: '科目名称', value: (row) => row.accountName },
      { header: '级次', value: (row) => row.level },
      { header: '方向', value: (row) => DIRECTION_LABELS[row.direction] ?? row.direction },
      { header: '期初借方', value: (row) => row.openingDebit },
      { header: '期初贷方', value: (row) => row.openingCredit },
      { header: '本期发生借方', value: (row) => row.debitOccur },
      { header: '本期发生贷方', value: (row) => row.creditOccur },
      { header: '期末借方', value: (row) => row.closingDebit },
      { header: '期末贷方', value: (row) => row.closingCredit },
    ];
    exportRowsToXlsx(`科目余额表_${period}.xlsx`, '科目余额表', columns, filteredBalanceRows);
  };

  const exportGeneral = () => {
    if (generalRows.length === 0) {
      toast.error('总账暂无数据');
      return;
    }
    const columns: ExcelSheetColumn<GeneralLedgerRow>[] = [
      { header: '期间', value: () => period },
      { header: '科目编码', value: (row) => row.accountCode },
      { header: '科目名称', value: (row) => row.accountName },
      { header: '方向', value: (row) => DIRECTION_LABELS[row.direction] ?? row.direction },
      { header: '期初借方', value: (row) => row.openingDebit },
      { header: '期初贷方', value: (row) => row.openingCredit },
      { header: '本期发生借方', value: (row) => row.debitOccur },
      { header: '本期发生贷方', value: (row) => row.creditOccur },
      { header: '期末借方', value: (row) => row.closingDebit },
      { header: '期末贷方', value: (row) => row.closingCredit },
      { header: '下级科目数', value: (row) => row.childCount },
    ];
    exportRowsToXlsx(`总账_${period}.xlsx`, '总账', columns, generalRows);
  };

  const exportDetail = () => {
    if (detailRows.length === 0 || !detail.data) {
      toast.error('明细账本页无数据');
      return;
    }
    const columns: ExcelSheetColumn<DetailLedgerLine>[] = [
      { header: '期间', value: () => period },
      { header: '科目', value: () => `${detail.data?.accountCode} ${detail.data?.accountName}` },
      { header: '日期', value: (row) => voucherDate(row.voucherDate) },
      { header: '凭证号', value: (row) => row.voucherCode },
      { header: '摘要', value: (row) => row.summary ?? '' },
      { header: '对方科目', value: (row) => row.counterpartAccounts.join('、') },
      { header: '借方', value: (row) => row.debit },
      { header: '贷方', value: (row) => row.credit },
      { header: '余额', value: (row) => row.balance },
      { header: '方向', value: (row) => DIRECTION_LABELS[row.balanceSide] ?? row.balanceSide },
      {
        header: '辅助核算',
        value: (row) =>
          row.aux
            .map((item) => `${item.dimensionCode}:${item.dimensionValue ?? '-'}`)
            .join('；'),
      },
    ];
    exportRowsToXlsx(
      `明细账_${accountCode}_${period}.xlsx`,
      '明细账',
      columns,
      detailRows,
    );
  };

  const exportAux = () => {
    if (auxRows.length === 0) {
      toast.error('辅助余额表暂无数据');
      return;
    }
    const columns: ExcelSheetColumn<AuxBalanceRow>[] = [
      { header: '期间', value: () => period },
      { header: '维度', value: () => aux.data?.dimensionName ?? dimension },
      { header: '维度值', value: (row) => row.dimensionValue ?? '' },
      { header: '科目编码', value: (row) => row.accountCode },
      { header: '科目名称', value: (row) => row.accountName },
      { header: '期初借方', value: (row) => row.openingDebit },
      { header: '期初贷方', value: (row) => row.openingCredit },
      { header: '本期发生借方', value: (row) => row.debitOccur },
      { header: '本期发生贷方', value: (row) => row.creditOccur },
      { header: '期末借方', value: (row) => row.closingDebit },
      { header: '期末贷方', value: (row) => row.closingCredit },
    ];
    exportRowsToXlsx(`辅助余额表_${dimension}_${period}.xlsx`, '辅助余额表', columns, auxRows);
  };

  /* ========== 各 Tab 渲染 ========== */

  const renderBalance = () => {
    const totals = balance.data?.totals;
    return (
      <DataBoundary
        loading={balance.loading}
        error={balance.error}
        empty={!balance.loading && !balance.error && filteredBalanceRows.length === 0}
        emptyText={
          keyword
            ? `没有匹配「${keyword}」的科目，请调整关键字`
            : `期间 ${period} 无科目余额数据，请确认该期间凭证已过账`
        }
        onRetry={() => void balance.reload()}
      >
        {balance.data && !balance.data.balanced ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2 text-sm text-destructive"
          >
            科目余额表借贷不平衡（期末借方合计 ≠ 期末贷方合计），请检查该期间凭证
          </p>
        ) : null}
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>科目编码</TableHead>
                <TableHead>科目名称</TableHead>
                <TableHead className="w-[70px]">级次</TableHead>
                <TableHead className="w-[70px]">方向</TableHead>
                <TableHead className="w-[130px] text-right">期初借</TableHead>
                <TableHead className="w-[130px] text-right">期初贷</TableHead>
                <TableHead className="w-[130px] text-right">本期借</TableHead>
                <TableHead className="w-[130px] text-right">本期贷</TableHead>
                <TableHead className="w-[130px] text-right">期末借</TableHead>
                <TableHead className="w-[130px] text-right">期末贷</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredBalanceRows.map((row) => {
                const subtotalRows = leafSubtotals.get(row.accountCode) ?? [];
                const subtotal = subtotalRows.length > 0 ? sumRows(subtotalRows) : null;
                return (
                  <React.Fragment key={row.accountCode}>
                    <TableRow className={cn(row.isLeaf && 'text-foreground')}>
                      <TableCell className="tabular-nums">{row.accountCode}</TableCell>
                      <TableCell>
                        <span style={{ paddingLeft: `${Math.max(0, row.level - 1) * 12}px` }}>
                          {row.accountName}
                        </span>
                        {!row.isLeaf ? (
                          <Badge variant="outline" className="ml-2">
                            汇总
                          </Badge>
                        ) : null}
                      </TableCell>
                      <TableCell>{row.level}</TableCell>
                      <TableCell>{DIRECTION_LABELS[row.direction] ?? row.direction}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {amount(row.openingDebit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {amount(row.openingCredit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {amount(row.debitOccur)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {amount(row.creditOccur)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {amount(row.closingDebit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {amount(row.closingCredit)}
                      </TableCell>
                    </TableRow>
                    {subtotal ? (
                      <TableRow className="bg-muted/30 text-xs text-muted-foreground">
                        <TableCell />
                        <TableCell colSpan={3}>
                          其中：下级末级科目小计（{subtotalRows.length} 个）
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {amount(subtotal.openingDebit)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {amount(subtotal.openingCredit)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {amount(subtotal.debitOccur)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {amount(subtotal.creditOccur)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {amount(subtotal.closingDebit)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {amount(subtotal.closingCredit)}
                        </TableCell>
                      </TableRow>
                    ) : null}
                  </React.Fragment>
                );
              })}
            </TableBody>
            {totals ? (
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={4}>合计（{filteredBalanceRows.length} 行）</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {amount(totals.openingDebit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {amount(totals.openingCredit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {amount(totals.debitOccur)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {amount(totals.creditOccur)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {amount(totals.closingDebit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {amount(totals.closingCredit)}
                  </TableCell>
                </TableRow>
              </TableFooter>
            ) : null}
          </Table>
        </div>
      </DataBoundary>
    );
  };

  const renderGeneral = () => (
    <DataBoundary
      loading={general.loading}
      error={general.error}
      empty={!general.loading && !general.error && generalRows.length === 0}
      emptyText={`期间 ${period} 无总账数据；总账按一级科目汇总，需先有已过账凭证`}
      onRetry={() => void general.reload()}
    >
      <p className="text-sm text-muted-foreground">
        点击任一科目行可下钻到该科目的明细账，再点凭证号进入凭证详情。
      </p>
      <div className="rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>科目编码</TableHead>
              <TableHead>科目名称</TableHead>
              <TableHead className="w-[70px]">方向</TableHead>
              <TableHead className="w-[130px] text-right">期初借</TableHead>
              <TableHead className="w-[130px] text-right">期初贷</TableHead>
              <TableHead className="w-[130px] text-right">本期借</TableHead>
              <TableHead className="w-[130px] text-right">本期贷</TableHead>
              <TableHead className="w-[150px] text-right">期末余额</TableHead>
              <TableHead className="w-[90px] text-right">下级科目</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {generalRows.map((row) => (
              <TableRow
                key={row.accountCode}
                className="cursor-pointer"
                onClick={() => openDetailLedger(row.accountCode)}
              >
                <TableCell className="tabular-nums">{row.accountCode}</TableCell>
                <TableCell>{row.accountName}</TableCell>
                <TableCell>{DIRECTION_LABELS[row.direction] ?? row.direction}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {amount(row.openingDebit)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {amount(row.openingCredit)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {amount(row.debitOccur)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {amount(row.creditOccur)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {sideAmount(row.closingNet, row.closingSide)}
                </TableCell>
                <TableCell className="text-right">{row.childCount}</TableCell>
              </TableRow>
            ))}
          </TableBody>
          {general.data?.totals ? (
            <TableFooter>
              <TableRow>
                <TableCell colSpan={5}>合计</TableCell>
                <TableCell className="text-right tabular-nums">
                  {amount(general.data.totals.debitOccur)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {amount(general.data.totals.creditOccur)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {sideAmount(
                    general.data.totals.closingDebit - general.data.totals.closingCredit,
                    general.data.totals.closingDebit - general.data.totals.closingCredit >= 0
                      ? 'debit'
                      : 'credit',
                  )}
                </TableCell>
                <TableCell />
              </TableRow>
            </TableFooter>
          ) : null}
        </Table>
      </div>
    </DataBoundary>
  );

  const renderDetail = () => {
    if (!accountCode) {
      return (
        <div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
          请先在「总账」中点击科目行选择科目，或在上方筛选区输入科目编码后查询。
        </div>
      );
    }
    const totalPages = detail.data
      ? Math.max(1, Math.ceil(detail.data.total / (detail.data.pageSize || PAGE_SIZE)))
      : 1;
    return (
      <DataBoundary
        loading={detail.loading}
        error={detail.error}
        empty={!detail.loading && !detail.error && detailRows.length === 0}
        emptyText={`科目 ${accountCode} 在期间 ${period} 无明细发生额`}
        onRetry={() => void detail.reload()}
      >
        {detail.data ? (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <div className="rounded-lg border bg-card p-3">
              <p className="text-xs text-muted-foreground">科目</p>
              <p className="text-sm font-medium">
                {detail.data.accountCode} {detail.data.accountName}
              </p>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <p className="text-xs text-muted-foreground">期初余额</p>
              <p className="text-sm font-medium tabular-nums">
                {sideAmount(
                  detail.data.openingBalance,
                  detail.data.openingBalance >= 0 ? 'debit' : 'credit',
                )}
              </p>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <p className="text-xs text-muted-foreground">本期借贷发生</p>
              <p className="text-sm font-medium tabular-nums">
                {formatMoney(detail.data.periodDebit)} / {formatMoney(detail.data.periodCredit)}
              </p>
            </div>
            <div className="rounded-lg border bg-card p-3">
              <p className="text-xs text-muted-foreground">期末余额</p>
              <p className="text-sm font-medium tabular-nums">
                {sideAmount(
                  detail.data.closingBalance,
                  detail.data.closingBalance >= 0 ? 'debit' : 'credit',
                )}
              </p>
            </div>
          </div>
        ) : null}
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[110px]">日期</TableHead>
                <TableHead className="w-[150px]">凭证号</TableHead>
                <TableHead>摘要</TableHead>
                <TableHead>对方科目</TableHead>
                <TableHead className="w-[130px] text-right">借方</TableHead>
                <TableHead className="w-[130px] text-right">贷方</TableHead>
                <TableHead className="w-[150px] text-right">余额</TableHead>
                <TableHead className="w-[70px]">方向</TableHead>
                <TableHead className="w-[180px]">辅助核算</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detailRows.map((line) => (
                <TableRow key={line.lineId}>
                  <TableCell className="tabular-nums">{voucherDate(line.voucherDate)}</TableCell>
                  <TableCell>
                    <button
                      type="button"
                      className="text-primary underline-offset-2 hover:underline"
                      onClick={() => navigate(`/voucher/${line.voucherId}`)}
                    >
                      {line.voucherCode}
                    </button>
                  </TableCell>
                  <TableCell className="max-w-[260px] truncate">{line.summary ?? '-'}</TableCell>
                  <TableCell className="max-w-[220px] truncate">
                    {line.counterpartAccounts.length > 0
                      ? line.counterpartAccounts.join('、')
                      : '-'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{amount(line.debit)}</TableCell>
                  <TableCell className="text-right tabular-nums">{amount(line.credit)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {sideAmount(line.balance, line.balanceSide)}
                  </TableCell>
                  <TableCell>{DIRECTION_LABELS[line.balanceSide] ?? line.balanceSide}</TableCell>
                  <TableCell className="max-w-[220px] truncate">
                    {line.aux.length > 0
                      ? line.aux
                          .map((item) => `${item.dimensionCode}:${item.dimensionValue ?? '-'}`)
                          .join('；')
                      : '-'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            {detail.data ? (
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={4}>
                    本页合计（第 {detail.data.page} 页 / 共 {totalPages} 页，共{' '}
                    {detail.data.total} 条）
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {amount(detail.data.pageDebit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {amount(detail.data.pageCredit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {sideAmount(
                      detail.data.closingBalance,
                      detail.data.closingBalance >= 0 ? 'debit' : 'credit',
                    )}
                  </TableCell>
                  <TableCell colSpan={2}>期末余额</TableCell>
                </TableRow>
              </TableFooter>
            ) : null}
          </Table>
        </div>
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href="#"
                aria-disabled={page <= 1}
                className={cn(page <= 1 && 'pointer-events-none opacity-50')}
                onClick={(e) => {
                  e.preventDefault();
                  if (page > 1) setPage(page - 1);
                }}
              />
            </PaginationItem>
            <PaginationItem>
              <span className="px-3 text-sm text-muted-foreground">
                {page} / {totalPages}
              </span>
            </PaginationItem>
            <PaginationItem>
              <PaginationNext
                href="#"
                aria-disabled={page >= totalPages}
                className={cn(page >= totalPages && 'pointer-events-none opacity-50')}
                onClick={(e) => {
                  e.preventDefault();
                  if (page < totalPages) setPage(page + 1);
                }}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">跳转到</span>
          <Input
            type="number"
            min={1}
            max={totalPages}
            className="w-[100px]"
            value={page}
            onChange={(e) => {
              const next = Number(e.target.value);
              if (Number.isFinite(next) && next >= 1 && next <= totalPages) setPage(next);
            }}
          />
          <span className="text-sm text-muted-foreground">页</span>
        </div>
      </DataBoundary>
    );
  };

  const renderAux = () => {
    if (!dimension) {
      return (
        <div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
          请先选择辅助核算维度（来自 /api/finance/ledgers/aux-dimensions 的启用维度）。
        </div>
      );
    }
    return (
      <DataBoundary
        loading={aux.loading}
        error={aux.error}
        empty={!aux.loading && !aux.error && auxRows.length === 0}
        emptyText={`维度「${aux.data?.dimensionName ?? dimension}」在期间 ${period} 无发生额`}
        onRetry={() => void aux.reload()}
      >
        {aux.data && !aux.data.balanced ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2 text-sm text-destructive"
          >
            辅助余额表借贷不平衡，请检查辅助核算凭证
          </p>
        ) : null}
        <div className="rounded-lg border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>维度值</TableHead>
                <TableHead className="w-[140px]">科目编码</TableHead>
                <TableHead>科目名称</TableHead>
                <TableHead className="w-[150px] text-right">期初余额</TableHead>
                <TableHead className="w-[150px] text-right">本期发生</TableHead>
                <TableHead className="w-[150px] text-right">期末余额</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {auxRows.map((row) => (
                <TableRow key={`${row.dimensionId ?? 'null'}-${row.accountCode}`}>
                  <TableCell>{row.dimensionValue ?? '(未指定)'}</TableCell>
                  <TableCell className="tabular-nums">{row.accountCode}</TableCell>
                  <TableCell>{row.accountName}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {sideAmount(
                      row.openingDebit - row.openingCredit,
                      row.openingDebit - row.openingCredit >= 0 ? 'debit' : 'credit',
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(row.debitOccur)} / {formatMoney(row.creditOccur)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {sideAmount(row.closingNet, row.closingSide)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            {aux.data ? (
              <TableFooter>
                <TableRow>
                  <TableCell colSpan={3}>合计</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {sideAmount(
                      aux.data.totals.closingDebit - aux.data.totals.closingCredit,
                      aux.data.totals.closingDebit - aux.data.totals.closingCredit >= 0
                        ? 'debit'
                        : 'credit',
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(aux.data.totals.debitOccur)} /{' '}
                    {formatMoney(aux.data.totals.creditOccur)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {sideAmount(
                      aux.data.totals.closingDebit - aux.data.totals.closingCredit,
                      aux.data.totals.closingDebit - aux.data.totals.closingCredit >= 0
                        ? 'debit'
                        : 'credit',
                    )}
                  </TableCell>
                </TableRow>
              </TableFooter>
            ) : null}
          </Table>
        </div>
      </DataBoundary>
    );
  };

  const exportCurrent = () => {
    if (tab === 'balance') exportBalance();
    else if (tab === 'general') exportGeneral();
    else if (tab === 'detail') exportDetail();
    else exportAux();
  };

  return (
    <PageShell
      title="会计账簿"
      description="科目余额表、总账、明细账与辅助余额表；总账 → 明细账 → 凭证三级下钻"
    >
      <FilterBar>
        <div className="flex items-center gap-2">
          <Label htmlFor="ledgers-period" className="text-xs text-muted-foreground">
            期间
          </Label>
          <PeriodSelect
            id="ledgers-period"
            value={period}
            onChange={(value) => {
              setPeriod(value);
              setPage(1);
            }}
          />
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="ledgers-entity" className="text-xs text-muted-foreground">
            纳税主体
          </Label>
          <Select value={taxEntityId} onValueChange={setTaxEntityId}>
            <SelectTrigger id="ledgers-entity" className="w-[200px]">
              <SelectValue placeholder="全部主体" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_ENTITIES}>全部主体（不过滤）</SelectItem>
              {(entities.data ?? []).map((entity) => (
                <SelectItem key={entity.id} value={entity.id}>
                  {entity.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {tab === 'balance' ? (
          <>
            <div className="flex items-center gap-2">
              <Label htmlFor="ledgers-level" className="text-xs text-muted-foreground">
                层级
              </Label>
              <Select value={String(level)} onValueChange={(v) => setLevel(Number(v))}>
                <SelectTrigger id="ledgers-level" className="w-[110px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[1, 2, 3, 4, 5, 6].map((item) => (
                    <SelectItem key={item} value={String(item)}>
                      {item} 级
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Search className="size-4 text-muted-foreground" />
              <Input
                className="w-[220px]"
                placeholder="科目编码 / 名称关键字"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
            </div>
          </>
        ) : null}

        {tab === 'detail' ? (
          <>
            <div className="flex items-center gap-2">
              <Label htmlFor="ledgers-account" className="text-xs text-muted-foreground">
                科目编码
              </Label>
              <Input
                id="ledgers-account"
                className="w-[180px]"
                placeholder="如 1122"
                value={accountCode}
                onChange={(e) => {
                  setAccountCode(e.target.value.trim());
                  setPage(1);
                }}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeChildren}
                onChange={(e) => {
                  setIncludeChildren(e.target.checked);
                  setPage(1);
                }}
              />
              含下级科目
            </label>
          </>
        ) : null}

        {tab === 'aux' ? (
          <div className="flex items-center gap-2">
            <Label htmlFor="ledgers-dimension" className="text-xs text-muted-foreground">
              辅助维度
            </Label>
            <Select value={dimension} onValueChange={setDimension}>
              <SelectTrigger id="ledgers-dimension" className="w-[200px]">
                <SelectValue placeholder="选择维度" />
              </SelectTrigger>
              <SelectContent>
                {(dimensions.data ?? [])
                  .filter((item) => item.enabled)
                  .map((item) => (
                    <SelectItem key={item.id} value={item.code}>
                      {item.name}（{item.code}）
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}

        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={reloadActive}
          disabled={
            balance.loading || general.loading || detail.loading || aux.loading
          }
        >
          <RefreshCw
            className={cn(
              'size-4',
              (balance.loading || general.loading || detail.loading || aux.loading) &&
                'animate-spin',
            )}
          />
          刷新
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={exportCurrent}>
          <Download className="size-4" />
          导出当前筛选结果
        </Button>
      </FilterBar>

      {dimensions.error ? (
        <p className="text-sm text-destructive">
          辅助维度加载失败：{dimensions.error}（辅助余额表不可用）
        </p>
      ) : null}

      <Tabs value={tab} onValueChange={(value) => setTab(value as LedgerTab)}>
        <TabsList>
          <TabsTrigger value="balance">科目余额表</TabsTrigger>
          <TabsTrigger value="general">总账</TabsTrigger>
          <TabsTrigger value="detail">明细账</TabsTrigger>
          <TabsTrigger value="aux">辅助余额表</TabsTrigger>
          {/* D-03：多维度组合账 / 跨维度结构对比 / 成本分摊试算 */}
          <TabsTrigger value="aux-combination">组合与分摊</TabsTrigger>
        </TabsList>
        <TabsContent value="balance" className="flex flex-col gap-4">
          {renderBalance()}
        </TabsContent>
        <TabsContent value="general" className="flex flex-col gap-4">
          {renderGeneral()}
        </TabsContent>
        <TabsContent value="detail" className="flex flex-col gap-4">
          {renderDetail()}
        </TabsContent>
        <TabsContent value="aux" className="flex flex-col gap-4">
          {renderAux()}
        </TabsContent>
        <TabsContent value="aux-combination" className="flex flex-col gap-4">
          <AuxCombinationPanel period={period} />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
};

export default LedgersPage;
