/**
 * 「年结留痕」区块：按时间倒序列出 `fin_year_end_log` 的操作记录。
 *
 * §5.9（F8）：从 `YearEndPage.tsx` 的 return 中**整段搬出**（缩进未动），
 * 同时把只被本块使用的 `ACTION_LABELS` 一并带过来。文案、`DataBoundary` 参数、
 * 按钮的 `variant` / `size` / `disabled` 条件逐字未动。
 *
 * ## ⚠️ 本块内的已知问题（**代码逐字保留、未改动**，仅在此记录，勿误读为已修）
 *
 * 留痕行上「反年结」按钮的 `disabled={row.action === 'reverse'}` 是**永不成立**的
 * 条件 —— `year-end.service.ts` 只有两个写入点：`carryForward` 写 `action: 'close'`、
 * `reverseYearEnd` 写 `action: 'reopen'`，从来不写 `reverse`。于是留痕里每一行
 * 都可点，包括该年度当前已是 `open`（已反年结）的行 —— 那种行提交后必被服务端
 * 以「会计年度 X 当前状态为 open，不可反年结」拒绝（400），使用者却要先填原因、
 * 勾审批确认才看到失败。
 *
 * **没有在这里顺手改的原因**：改成 `=== 'reopen'` 会误伤合法操作 —— 一个年度可以
 * 「年结 → 反年结 → 再年结」，此时旧 `reopen` 行对应的年度又已是 `closed`，
 * 按动作名禁用会把合法的反年结挡掉。正确做法是按年结状态判断
 * （同页 `YearEndStatusSection` 收到的 `status.data` 才有 `closed` 状态），
 * 属行为变更，不在本次拆分范围内 —— 已上报，未改。
 */
import React from 'react';
import { History } from 'lucide-react';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import type { YearEndLogItem } from '@shared/api.interface';

/**
 * 留痕动作 → 展示文案。
 *
 * 实际上只有两个动作会被写进 `fin_year_end_log`：`close`（执行年结结转）与
 * `reopen`（反年结）—— 见 `server/modules/finance-reports/year-end.service.ts`
 * 的两处 insert。`carry_forward` / `reverse` 是历史命名，保留作兜底。
 */
const ACTION_LABELS: Record<string, string> = {
  carry_forward: '执行年结结转',
  reverse: '反年结',
  reopen: '反年结',
  close: '年结',
};

interface YearEndLogSectionProps {
  data: YearEndLogItem[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  /** 打开「反年结」确认弹窗（父组件的 `useCallback`） */
  openReverse: (fiscalYear: number) => void;
}

const YearEndLogSection: React.FC<YearEndLogSectionProps> = ({
  data,
  loading,
  error,
  onRetry,
  openReverse,
}) => {
  return (
    <div className="flex flex-col gap-3">
      <SectionTitle>年结留痕</SectionTitle>
      <DataBoundary
        loading={loading}
        error={error}
        empty={!loading && !error && (data ?? []).length === 0}
        emptyText="暂无年结操作留痕"
        onRetry={onRetry}
      >
        <div className="flex flex-col gap-3">
          {(data ?? []).map((row) => (
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
              <CanCapabilityWrite capability="finance_write">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={row.action === 'reverse'}
                  onClick={() =>
                    openReverse(row.fiscalYear)
                  }
                >
                  反年结
                </Button>
              </CanCapabilityWrite>
            </div>
          ))}
        </div>
      </DataBoundary>
    </div>
  );
};

export default YearEndLogSection;
