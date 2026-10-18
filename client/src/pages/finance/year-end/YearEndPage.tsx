import React, { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, PlayCircle, RefreshCw } from 'lucide-react';
import PageShell from '@client/src/components/PageShell';
import FilterBar from '@client/src/components/erp/FilterBar';
import ActionHelp from '@client/src/components/erp/ActionHelp';
import ActionGroup from '@client/src/components/erp/ActionGroup';
import PeriodSelect from '@client/src/components/erp/PeriodSelect';
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
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import * as financeReportsApi from '@client/src/api/finance-reports';
import * as masterDataApi from '@client/src/api/master-data';
import { cn } from '@client/src/lib/utils';
import { currentPeriod, formatNumber } from '@client/src/utils/format';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import CarryForwardPreviewSection from './components/CarryForwardPreviewSection';
import YearEndStatusSection from './components/YearEndStatusSection';
import YearEndLogSection from './components/YearEndLogSection';
import type {
  PeriodCarryForwardPreview,
  TaxEntity,
  YearEndLogItem,
  YearEndStatusItem,
} from '@shared/api.interface';

const ALL_ENTITIES = '__all__';
const MIN_REASON_LENGTH = 4;

/*
 * §5.9（F8）：本文件已收敛为「布局编排 + 筛选区 + 两个写操作 + 反年结确认弹窗」，
 * 四块内容分到 `./components/`：
 *   · `year-end-columns.tsx` —— 两张表的列定义工厂（调用方各自 `useMemo`，见下）；
 *   · `CarryForwardPreviewSection.tsx` —— 结转损益预览（指标卡 / 前置校验 / 明细表）；
 *   · `YearEndStatusSection.tsx` —— 年结状态表（`closed` 行可发起反年结）；
 *   · `YearEndLogSection.tsx` —— 年结留痕列表。
 *
 * ⚠️ **反年结确认弹窗刻意留在主文件**：它的「打开即重置」发生在
 * `openReverse` 内部（与点击**同一个同步流程**，见下），若把 `reason` /
 * `approved` / `reasonError` 搬进子组件，就只能用 `useEffect` 去还原"打开时清空"
 * 这一时机 —— 那会改变重置的触发点（effect 在渲染后执行，且首次挂载也会跑）。
 * 因此四个 state、`openReverse`、`handleReverse` 与弹窗 JSX 全部留在原处。
 */

const YearEndPage: React.FC = () => {
  const [period, setPeriod] = useState<string>(currentPeriod());
  const [taxEntityId, setTaxEntityId] = useState<string>(ALL_ENTITIES);
  const [carrying, setCarrying] = useState(false);
  /*
   * 反年结的「目标年度」。
   *
   * 原实现把整个 `YearEndLogItem` 存进 state，但年结记录表（status 表）的按钮
   * 其实是**凭年度**发起反年结的（`handleReverse` 里只读 `reverseTarget.fiscalYear`）。
   * 于是原代码在 status 表里手写了一个「假」对象，含 `id` / `action` / `actorUserId`
   * 三个字段 —— 它们**都不是 `YearEndLogItem` 的字段**，能通过编译只是因为
   * 对象字面量被赋给了 `setState` 的宽类型。
   *
   * 这类「为了骗过类型而编字段」的写法比类型错误更危险：下一个读代码的人会以为
   * 那些字段有业务含义（例如以为 `action: reverse` 会影响后端行为）。
   *
   * 现在只存真正被用到的那个数：年度。
   */
  const [reverseYear, setReverseYear] = useState<number | null>(
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

  /*
   * `useCallback` 是必需的：它是 `statusColumns`（useMemo）的依赖，
   * 每次渲染新建的闭包会让 useMemo 每次失效 → antd 表头重建。
   */
  const openReverse = useCallback((fiscalYear: number) => {
    setReverseYear(fiscalYear);
    setReason('');
    setApproved(false);
    setReasonError(null);
  }, []);

  const handleReverse = async () => {
    if (reverseYear === null) return;
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
        fiscalYear: reverseYear,
        reason: trimmed,
        approved: true,
        taxEntityId: entityArg,
      });
      toast.success(result.message || `${reverseYear} 年度已反年结`);
      setReverseYear(null);
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
      actions={
        /*
         * 「执行年结结转」是**改变账务的主动作**，按规范落在页头 `PageShell.actions`。
         * 原实现把它挤在筛选区里（与期间/主体/刷新并列），既不符规范，
         * 也让"筛选区里混着一个会改账的按钮"这件事变得不显眼 —— 年结是不可逆操作，
         * 它应当与其余筛选控件分开、位置固定、更醒目。
         */
        <CanCapabilityWrite capability="finance_write">
          <ActionGroup
            help={
              <ActionHelp title="执行年结结转">
                结转损益并关闭当前年度，执行后账务期间会锁定；反年结需要单独发起并填写原因。
              </ActionHelp>
            }
          >
            <Button
              type="button"
              onClick={() => void handleCarryForward()}
              disabled={!data || !data.canCarry || carrying || data.alreadyCarried}
            >
              <PlayCircle className="size-4" />
              {carrying ? '结转中…' : '执行年结结转'}
            </Button>
          </ActionGroup>
        </CanCapabilityWrite>
      }
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
        <span className="ml-auto text-xs text-muted-foreground">
          当前口径：{period} · {entityName}
        </span>
      </FilterBar>

      <CarryForwardPreviewSection
        period={period}
        data={data}
        loading={preview.loading}
        error={preview.error}
        onRetry={() => void preview.reload()}
      />

      <YearEndStatusSection
        data={status.data}
        loading={status.loading}
        error={status.error}
        onRetry={() => void status.reload()}
        openReverse={openReverse}
      />

      <YearEndLogSection
        data={log.data}
        loading={log.loading}
        error={log.error}
        onRetry={() => void log.reload()}
        openReverse={openReverse}
      />

      <Dialog
        open={reverseYear !== null}
        onOpenChange={(open) => {
          if (!open) setReverseYear(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>反年结</DialogTitle>
            <DialogDescription>
              将对 {reverseYear ?? '-'} 年度执行反年结（期间{' '}
              {reverseYear ?? '-'} 全年）。该操作会红冲结转凭证并解锁期间，需填写原因并确认已获审批。
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
              onClick={() => setReverseYear(null)}
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


