import React, { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { Download, RefreshCw, Search } from 'lucide-react';
import PageShell from '@client/src/components/PageShell';
import FilterBar from '@client/src/components/erp/FilterBar';
import PeriodSelect from '@client/src/components/erp/PeriodSelect';
import UnassignedEntityVoucherBanner from '@client/src/components/erp/UnassignedEntityVoucherBanner';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
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
import AuxCombinationPanel from './AuxCombinationPanel';
import AuxTab from './components/AuxTab';
import BalanceTab from './components/BalanceTab';
import DetailTab from './components/DetailTab';
import GeneralTab from './components/GeneralTab';
import {
  exportAux as exportAuxXlsx,
  exportBalance as exportBalanceXlsx,
  exportDetail as exportDetailXlsx,
  exportGeneral as exportGeneralXlsx,

} from './ledger-exports';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import * as financeReportsApi from '@client/src/api/finance-reports';
import * as masterDataApi from '@client/src/api/master-data';
import { cn } from '@client/src/lib/utils';
import { currentPeriod } from '@client/src/utils/format';
import type {
  AccountBalanceSheet,
  AuxBalanceSheet,
  AuxDimensionItem,
  DetailLedgerResult,
  GeneralLedgerSheet,
  TaxEntity,
} from '@shared/api.interface';

/* §5.9（F8）：`DIRECTION_LABELS` / `voucherDate` 已随导出列定义移到
 * `./ledger-exports` —— 它们同时被导出与页面表格使用，放共享模块可避免
 * 两处各写一份（两处各写一份正是「导出内容与界面显示不一致」的成因）。 */
const ALL_ENTITIES = '__all__';
const PAGE_SIZE = 50;

type LedgerTab = 'balance' | 'general' | 'detail' | 'aux' | 'aux-combination';
const LedgersPage: React.FC = () => {
  const [tab, setTab] = useState<LedgerTab>('balance');
  const [period, setPeriod] = useState<string>(currentPeriod());
  const [taxEntityId, setTaxEntityId] = useState<string>(ALL_ENTITIES);
  const [level, setLevel] = useState<number>(6);
  const [keyword, setKeyword] = useState('');
  const [accountCode, setAccountCode] = useState<string>('');
  const [page, setPage] = useState<number>(1);
  const [includeChildren, setIncludeChildren] = useState(false);
  const [dimension, setDimension] = useState<string>('');
  // P0-2：默认只取已过账凭证；打开后按「含草稿预览」口径取数
  const [includeDraft, setIncludeDraft] = useState(false);

  const args = useMemo(
    () => ({
      period,
      taxEntityId: taxEntityId === ALL_ENTITIES ? undefined : taxEntityId,
      includeDraft,
    }),
    [period, taxEntityId, includeDraft],
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
            includeDraft,
          })
        : Promise.resolve(null),
    [accountCode, period, page, includeChildren, includeDraft, args, tab],
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

  /*
   * ── 导出的数据来源 ────────────────────────────────────────────────────
   *
   * 导出的行数据来自各 Tab 的查询结果。四个 Tab 组件已各自持有这些派生值，
   * 但**导出按钮在主文件**（跨 Tab 共用），因此主文件需要同一份数据。
   *
   * 这里只取 `?? []` 而不做筛选/小计等 Tab 专属的展示加工：
   *   · 余额表导出会带上筛选（\`filteredBalanceRows\`），故单独算一次；
   *   · 其余三个 Tab 的导出就是"当前查询结果"，无额外加工。
   *
   * ⚠️ 不复用 Tab 组件内部的派生值，是为了让 Tab 保持自洽（数据自取、自渲染），
   * 代价是主文件多算一次余额表的筛选 —— 这是 3 行纯计算，量级可忽略，
   * 换来的是"Tab 组件的 props 就是它需要的全部"，没有隐式耦合。
   */
  const balanceRows = useMemo(() => balance.data?.items ?? [], [balance.data]);
  const filteredBalanceRows = useMemo(() => {
    const key = keyword.trim().toLowerCase();
    if (!key) return balanceRows;
    return balanceRows.filter(
      (row) =>
        row.accountCode.toLowerCase().includes(key) ||
        row.accountName.toLowerCase().includes(key),
    );
  }, [balanceRows, keyword]);
  const generalRows = useMemo(() => general.data?.items ?? [], [general.data]);
  const detailRows = useMemo(() => detail.data?.items ?? [], [detail.data]);
  const auxRows = useMemo(() => aux.data?.items ?? [], [aux.data]);

  const guardExport = (ok: boolean, emptyMessage: string) => {
    if (!ok) toast.error(emptyMessage);
    return ok;
  };

  const exportBalance = () =>
    guardExport(
      exportBalanceXlsx(period, filteredBalanceRows),
      '当前筛选结果为空，无可导出数据',
    );

  const exportGeneral = () =>
    guardExport(exportGeneralXlsx(period, generalRows), '总账暂无数据');

  const exportDetail = () =>
    guardExport(
      exportDetailXlsx(
        period,
        accountCode,
        `${detail.data?.accountCode ?? ''} ${detail.data?.accountName ?? ''}`.trim(),
        detailRows,
      ),
      '明细账本页无数据',
    );

  const exportAux = () =>
    guardExport(
      exportAuxXlsx(
        period,
        dimension,
        aux.data?.dimensionName ?? dimension,
        auxRows,
      ),
      '辅助余额表暂无数据',
    );

  /* ========== 导出当前 Tab ========== */

  const exportCurrent = () => {
    if (tab === 'balance') exportBalance();
    else if (tab === 'general') exportGeneral();
    else if (tab === 'detail') exportDetail();
    else exportAux();
  };

  return (
    <PageShell
      title="会计账簿"
      description={`科目余额表、总账、明细账与辅助余额表；总账 → 明细账 → 凭证三级下钻（取数来源：${includeDraft ? '已过账 + 草稿预览' : '已过账凭证'}）`}
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
              {/* 同 ReportsPage：此处并非"不过滤"，而是只统计未归属主体的凭证 */}
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
            id="ledgers-include-draft"
            checked={includeDraft}
            onCheckedChange={(next) => {
              setIncludeDraft(next);
              setPage(1);
            }}
          />
          <Label
            htmlFor="ledgers-include-draft"
            className="text-xs text-muted-foreground"
          >
            含草稿预览
          </Label>
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

      {/* B-1 / REQ-BE-01：未归属主体的凭证不会进任何主体的账簿，必须在账簿页显著提示 */}
      <UnassignedEntityVoucherBanner period={period} />

      {dimensions.error ? (
        <p className="text-sm text-destructive">
          辅助维度加载失败：{dimensions.error}（辅助余额表不可用）
        </p>
      ) : null}

      {includeDraft ? (
        <p
          role="status"
          className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-4 py-2 text-sm text-amber-700 dark:text-amber-400"
        >
          当前为「含草稿预览」口径：已包含未过账草稿凭证，不得作为正式账簿对外报送。
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
          <BalanceTab
            period={period}
            keyword={keyword}
            data={balance.data}
            loading={balance.loading}
            error={balance.error}
            reload={balance.reload}
          />
        </TabsContent>
        <TabsContent value="general" className="flex flex-col gap-4">
          <GeneralTab
            period={period}
            data={general.data}
            loading={general.loading}
            error={general.error}
            reload={general.reload}
            onDrillDown={openDetailLedger}
          />
        </TabsContent>
        <TabsContent value="detail" className="flex flex-col gap-4">
          <DetailTab
            period={period}
            accountCode={accountCode}
            page={page}
            data={detail.data}
            loading={detail.loading}
            error={detail.error}
            reload={detail.reload}
            onPageChange={setPage}
          />
        </TabsContent>
        <TabsContent value="aux" className="flex flex-col gap-4">
          <AuxTab
            period={period}
            dimension={dimension}
            data={aux.data}
            loading={aux.loading}
            error={aux.error}
            reload={aux.reload}
          />
        </TabsContent>
        <TabsContent value="aux-combination" className="flex flex-col gap-4">
          <AuxCombinationPanel period={period} />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
};

export default LedgersPage;