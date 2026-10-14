import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CalendarCheck,
  CheckCircle2,
  History,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  XCircle,
} from 'lucide-react';
import PageShell from '@client/src/components/PageShell';
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
import { Input } from '@client/src/components/ui/input';
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
  TableHead,
  TableHeader,
  TableRow,
} from '@client/src/components/ui/table';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { CanCapability } from '@client/src/platform/auth';
import * as financeReportsApi from '@client/src/api/finance-reports';
import * as masterDataApi from '@client/src/api/master-data';
import { cn } from '@client/src/lib/utils';
import { currentPeriod, formatMoney, formatNumber } from '@client/src/utils/format';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import type {
  PeriodCarryForwardPreview,
  TaxEntity,
  YearEndLogItem,
  YearEndStatusItem,
} from '@shared/api.interface';

const ALL_ENTITIES = '__all__';
const MIN_REASON_LENGTH = 4;

const ACTION_LABELS: Record<string, string> = {
  carry_forward: '执行年结结转',
  reverse: '反年结',
  reopen: '反年结',
  close: '年结',
};

const YearEndPage: React.FC = () => {
  const navigate = useNavigate();
  const [period, setPeriod] = useState<string>(currentPeriod());
  const [taxEntityId, setTaxEntityId] = useState<string>(ALL_ENTITIES);
  const [carrying, setCarrying] = useState(false);
  const [reverseTarget, setReverseTarget] = useState<YearEndLogItem | null>(
    null,
  );

  const entityArg = taxEntityId === ALL_ENTITIES ? undefined : taxEntityId;

  const entities = useAsyncData<TaxEntity[]>(() => masterDataApi.listTaxEntities(), []);

  const preview = useAsyncData<PeriodCarryForwardPreview>(
    () => financeReportsApi.previewCarryForward({ period, taxEntityId: entityArg }),
    [period, entityArg],
  );

  const status = useAsyncData<YearEndStatusItem[]>(
    () => financeReportsApi.listYearEndStatus(entityArg),
    [entityArg],
  );

  const log = useAsyncData<YearEndLogItem[]>(
    () => financeReportsApi.listYearEndLog(),
    [],
  );

  const data = preview.data;
  const items = data?.items ?? [];
  const checks = data?.checks ?? [];

  const reloadAll = async () => {
    await Promise.all([preview.reload(), status.reload(), log.reload()]);
  };

  const handleCarryForward = async () => {
    if (!data) return;
    const ok = await confirmDanger(
      `确认对期间 ${period} 执行年结结转？系统将按预览明细生成结转损益凭证，结转后该年度期间不可再新增凭证。`,
      { title: '执行年结结转', confirmLabel: '确认结转' },
    );
    if (!ok) return;
    setCarrying(true);
    try {
      const result = await financeReportsApi.carryForward({
        period,
        taxEntityId: entityArg,
      });
      toast.success(result.message || `期间 ${period} 年结结转完成`);
      await reloadAll();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '年结结转失败'));
    } finally {
      setCarrying(false);
    }
  };

  /* ========== 反年结弹窗（原因 + 审批确认） ========== */
  const [reason, setReason] = useState('');
  const [approved, setApproved] = useState(false);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [reversing, setReversing] = useState(false);

  const openReverse = (item: YearEndLogItem) => {
    setReverseTarget(item);
    setReason('');
    setApproved(false);
    setReasonError(null);
  };

  const handleReverse = async () => {
    if (!reverseTarget) return;
    const trimmed = reason.trim();
    if (trimmed.length < MIN_REASON_LENGTH) {
      setReasonError(`原因至少 ${MIN_REASON_LENGTH} 个字`);
      return;
    }
    if (!approved) {
      setReasonError('请先勾选「已获审批确认」');
      return;
    }
    setReversing(true);
    try {
      const result = await financeReportsApi.reverseYearEnd({
        fiscalYear: reverseTarget.fiscalYear,
        reason: trimmed,
        approved: true,
        taxEntityId: entityArg,
      });
      toast.success(result.message || `${reverseTarget.fiscalYear} 年度已反年结`);
      setReverseTarget(null);
      await reloadAll();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '反年结失败'));
    } finally {
      setReversing(false);
    }
  };

  const entityName =
    entities.data?.find((item) => item.id === taxEntityId)?.name ??
    (taxEntityId === ALL_ENTITIES ? '全部主体' : '-');

  return (
    <PageShell
      title="期末年结"
      description="结转损益预览、年结执行与反年结留痕（结转凭证由后端事务生成）"
    >
      <FilterBar>
        <div className="flex items-center gap-2">
          <Label htmlFor="yearend-period" className="text-xs text-muted-foreground">
            期间
          </Label>
          <PeriodSelect id="yearend-period" value={period} onChange={setPeriod} />
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="yearend-entity" className="text-xs text-muted-foreground">
            纳税主体
          </Label>
          <Select value={taxEntityId} onValueChange={setTaxEntityId}>
            <SelectTrigger id="yearend-entity" className="w-[220px]">
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
          onClick={() => void reloadAll()}
          disabled={preview.loading}
        >
          <RefreshCw className={cn('size-4', preview.loading && 'animate-spin')} />
          刷新预览
        </Button>
        <CanCapability capability="finance_write">
          <Button
            type="button"
            size="sm"
            onClick={() => void handleCarryForward()}
            disabled={!data || !data.canCarry || carrying || data.alreadyCarried}
          >
            <PlayCircle className="size-4" />
            {carrying ? '结转中…' : '执行年结结转'}
          </Button>
        </CanCapability>
        <span className="ml-auto text-xs text-muted-foreground">
          当前口径：{period} · {entityName}
        </span>
      </FilterBar>

      {data?.alreadyCarried ? (
        <div className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/5 px-4 py-2 text-sm text-success">
          <CheckCircle2 className="size-4" />
          期间 {period} 已完成结转损益（如需调整请先反年结）。
        </div>
      ) : null}

      <DataBoundary
        loading={preview.loading}
        error={preview.error}
        empty={false}
        onRetry={() => void preview.reload()}
      >
        {data ? (
          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
              <StatCard
                label="收入合计"
                value={formatMoney(data.totalRevenue)}
                icon={CalendarCheck}
                tone="primary"
                hint="损益类收入科目本期发生额"
              />
              <StatCard
                label="费用合计"
                value={formatMoney(data.totalExpense)}
                icon={CalendarCheck}
                tone="warning"
                hint="成本费用科目本期发生额"
              />
              <StatCard
                label="净利润"
                value={formatMoney(data.netProfit)}
                icon={CalendarCheck}
                tone={data.netProfit >= 0 ? 'success' : 'warning'}
                hint="收入 − 费用（结转至本年利润）"
              />
              <StatCard
                label="可结转状态"
                value={data.canCarry ? '可结转' : '不可结转'}
                icon={data.canCarry ? CheckCircle2 : XCircle}
                tone={data.canCarry ? 'success' : 'neutral'}
                hint={
                  data.canCarry
                    ? '前置校验全部通过'
                    : `存在 ${checks.filter((check) => !check.passed).length} 项前置校验未通过`
                }
              />
            </div>

            <div className="flex flex-col gap-3">
              <SectionTitle>前置校验清单</SectionTitle>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                {checks.length === 0 ? (
                  <p className="text-sm text-muted-foreground">本次未返回前置校验项。</p>
                ) : (
                  checks.map((check) => (
                    <div
                      key={check.code}
                      className={cn(
                        'flex flex-col gap-2 rounded-xl border bg-card p-4',
                        check.passed ? 'border-success/30' : 'border-destructive/40',
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium">{check.label}</p>
                        <Badge variant={check.passed ? 'success' : 'destructive'}>
                          {check.passed ? '通过' : '不通过'}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground">{check.message}</p>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="flex flex-col gap-3">
              <SectionTitle>待结转损益科目明细</SectionTitle>
              {items.length === 0 ? (
                <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
                  期间 {period} 无需要结转的损益类科目发生额（收入与费用科目本期均为 0）。
                </p>
              ) : (
                <div className="rounded-lg border bg-card">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-[140px]">科目编码</TableHead>
                        <TableHead>科目名称</TableHead>
                        <TableHead className="w-[110px]">科目类型</TableHead>
                        <TableHead className="w-[90px]">方向</TableHead>
                        <TableHead className="w-[140px] text-right">本期发生借</TableHead>
                        <TableHead className="w-[140px] text-right">本期发生贷</TableHead>
                        <TableHead className="w-[140px] text-right">结转金额</TableHead>
                        <TableHead className="w-[110px]">结转方向</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((item) => (
                        <TableRow key={item.accountCode}>
                          <TableCell className="tabular-nums">{item.accountCode}</TableCell>
                          <TableCell>{item.accountName}</TableCell>
                          <TableCell>{item.accountType}</TableCell>
                          <TableCell className="text-center">-</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatMoney(item.debitOccur)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatMoney(item.creditOccur)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatMoney(item.carryAmount)}
                          </TableCell>
                          <TableCell>
                            <Badge variant={item.carryDirection === 'debit' ? 'info' : 'warning'}>
                              {item.carryDirection === 'debit' ? '借' : '贷'}
                            </Badge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </DataBoundary>

      <div className="flex flex-col gap-3">
        <SectionTitle>年结状态</SectionTitle>
        <DataBoundary
          loading={status.loading}
          error={status.error}
          empty={!status.loading && !status.error && (status.data ?? []).length === 0}
          emptyText="暂无年结记录：执行年结结转后这里会出现对应年度的状态"
          onRetry={() => void status.reload()}
        >
          <div className="rounded-lg border bg-card">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[100px]">年度</TableHead>
                  <TableHead className="w-[110px]">期间</TableHead>
                  <TableHead className="w-[100px]">状态</TableHead>
                  <TableHead className="w-[140px] text-right">净利润</TableHead>
                  <TableHead className="w-[170px]">结转凭证号</TableHead>
                  <TableHead className="w-[180px]">结账人 / 时间</TableHead>
                  <TableHead className="min-w-[180px]">最近反结账</TableHead>
                  <TableHead className="w-[140px]">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(status.data ?? []).map((row) => (
                  <TableRow key={`${row.fiscalYear}-${row.taxEntityId ?? 'all'}`}>
                    <TableCell className="tabular-nums">{row.fiscalYear}</TableCell>
                    <TableCell className="tabular-nums">{row.period}</TableCell>
                    <TableCell>
                      <Badge variant={row.status === 'closed' ? 'success' : 'secondary'}>
                        {row.status === 'closed' ? '已年结' : '未年结'}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatMoney(row.profitAmount)}
                    </TableCell>
                    <TableCell>
                      {row.carryVoucherCode ? (
                        <button
                          type="button"
                          className="text-primary underline-offset-2 hover:underline"
                          onClick={() => navigate(`/voucher/${row.carryVoucherId}`)}
                        >
                          {row.carryVoucherCode}
                        </button>
                      ) : (
                        '-'
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.closedBy ?? '-'}
                      <br />
                      {row.closedAt ? new Date(row.closedAt).toLocaleString('zh-CN') : '-'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {row.reopenedAt
                        ? `${row.reopenedBy ?? '-'} · ${new Date(row.reopenedAt).toLocaleString('zh-CN')}`
                        : '-'}
                    </TableCell>
                    <TableCell>
                      {row.status === 'closed' ? (
                        <CanCapability capability="finance_write">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() =>
                              openReverse({
                                id: `status-${row.fiscalYear}`,
                                fiscalYear: row.fiscalYear,
                                action: 'reverse',
                                actorUserId: null,
                                reason: null,
                                createdAt: row.closedAt ?? '',
                              })
                            }
                          >
                            <RotateCcw className="size-3" />
                            反年结
                          </Button>
                        </CanCapability>
                      ) : (
                        <span className="text-xs text-muted-foreground">-</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </DataBoundary>
      </div>

      <div className="flex flex-col gap-3">
        <SectionTitle>年结留痕</SectionTitle>
        <DataBoundary
          loading={log.loading}
          error={log.error}
          empty={!log.loading && !log.error && (log.data ?? []).length === 0}
          emptyText="暂无年结操作留痕"
          onRetry={() => void log.reload()}
        >
          <div className="flex flex-col gap-3">
            {(log.data ?? []).map((row) => (
              <div
                key={row.id}
                className="flex items-start gap-3 rounded-lg border bg-card px-4 py-3"
              >
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <History className="size-4" />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">
                      {ACTION_LABELS[row.action] ?? row.action}
                    </span>
                    <Badge variant="outline">{row.fiscalYear} 年度</Badge>
                    <span className="text-xs text-muted-foreground">
                      {row.createdAt
                        ? new Date(row.createdAt).toLocaleString('zh-CN')
                        : '-'}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    操作人：{row.actorUserId ?? '-'}
                    {row.reason ? ` · 原因：${row.reason}` : ''}
                  </p>
                </div>
                <CanCapability capability="finance_write">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={row.action === 'reverse'}
                    onClick={() =>
                      openReverse(row)
                    }
                  >
                    反年结
                  </Button>
                </CanCapability>
              </div>
            ))}
          </div>
        </DataBoundary>
      </div>

      <Dialog
        open={reverseTarget !== null}
        onOpenChange={(open) => {
          if (!open) setReverseTarget(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>反年结</DialogTitle>
            <DialogDescription>
              将对 {reverseTarget?.fiscalYear ?? '-'} 年度执行反年结（期间{' '}
              {reverseTarget?.fiscalYear ?? '-'} 全年）。该操作会红冲结转凭证并解锁期间，需填写原因并确认已获审批。
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="reverse-reason">
                反年结原因（至少 {MIN_REASON_LENGTH} 个字）
              </Label>
              <Input
                id="reverse-reason"
                value={reason}
                placeholder="例如：年末结转科目口径有误，经财务负责人审批后重新结转"
                onChange={(e) => {
                  setReason(e.target.value);
                  setReasonError(null);
                }}
              />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={approved}
                onChange={(e) => {
                  setApproved(e.target.checked);
                  setReasonError(null);
                }}
              />
              已获审批确认（后端将记录 approved=true）
            </label>
            {reasonError ? <p className="text-xs text-destructive">{reasonError}</p> : null}
            {!approved ? (
              <p className="flex items-center gap-1 text-xs text-warning">
                <AlertTriangle className="size-3" />
                未勾选审批确认时无法提交。
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setReverseTarget(null)}
              disabled={reversing}
            >
              取消
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void handleReverse()}
              disabled={reversing || !approved || reason.trim().length < MIN_REASON_LENGTH}
            >
              {reversing ? '提交中…' : '确认反年结'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <p className="text-xs text-muted-foreground">
        留痕共 {formatNumber((log.data ?? []).length)} 条；年结留痕由后端写入 fin_year_end_log，不可删除。
      </p>
    </PageShell>
  );
};

export default YearEndPage;
