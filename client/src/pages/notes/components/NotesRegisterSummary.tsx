/**
 * 票据概览：四张指标卡 + 到期预警条（§5.9 / F8）。
 *
 * 从 `NotesPage.tsx` 抽出的**第一段 JSX**（原第 256–309 行）—— 页面里位置最高的
 * 一块，也是"打开票据页第一眼看到的东西"。
 *
 * ⚠️ **行为零变更**：JSX 与原块**逐字相同**，只做了三件事：
 *   ① 整体去一层缩进（原块在页面 `<div className="flex flex-col gap-6">` 内，缩进 8；
 *      这里在 fragment 内，缩进 6）；
 *   ② `register` / `alertRows` 由父组件经 props 传入 —— `register` 直接同名传入，
 *      原先的 `const alertRows = alerts ?? [];` **原样搬进来**（它是本块私有的派生值，
 *      父组件在别处不再用它）；
 *   ③ 外层包一个 fragment：原块是**两个并列的条件块**，且它们在页面里位于
 *      "指标卡在上、表格在下"的中间位置 —— 合成一个 DOM 容器会多一层节点、
 *      改变布局（`gap-6` 会作用到错误的层级），fragment 不产生节点。
 *
 * 保持**无条件挂载**：数据未到时 `register` 为 `null`、`alerts` 为 `null`，
 * 两个条件块都不渲染，与拆分前一致。
 */
import React from 'react';
import StatCard from '@client/src/components/erp/StatCard';
import { cn } from '@client/src/lib/utils';
import { money } from '../note-format';
import type { NoteDueAlert, NoteRegisterResult } from '@shared/api.interface';

interface NotesRegisterSummaryProps {
  /** 备查簿汇总（`GET /api/notes/register`）；未取到时为 `null` */
  register: NoteRegisterResult | null;
  /** 到期预警（`GET /api/notes/due-alerts`）；未取到时为 `null` */
  alerts: NoteDueAlert[] | null;
}

const NotesRegisterSummary: React.FC<NotesRegisterSummaryProps> = ({
  register,
  alerts,
}) => {
  const alertRows = alerts ?? [];

  return (
    <>
      {register && (
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard
            label="票据总额"
            value={money(register.totalAmount)}
          />
          <StatCard
            label="未结清金额"
            value={money(register.outstandingAmount)}
            tone="warning"
          />
          <StatCard
            label="临期/逾期"
            value={String(alertRows.length)}
            tone={alertRows.some((a) => a.level === 'overdue') ? 'warning' : 'info'}
          />
          <StatCard
            label="票面张数"
            value={String(
              register.byStatus.reduce((sum, item) => sum + item.count, 0),
            )}
          />
        </div>
      )}

      {alertRows.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <h3 className="text-sm font-semibold text-amber-900">
            到期预警（{alertRows.length} 张）
          </h3>
          <div className="flex flex-wrap gap-2">
            {alertRows.map((alert) => (
              <span
                key={alert.code}
                className={cn(
                  'rounded px-2 py-1 text-xs',
                  alert.level === 'overdue'
                    ? 'bg-rose-100 text-rose-800'
                    : alert.level === 'urgent'
                      ? 'bg-orange-100 text-orange-800'
                      : 'bg-amber-100 text-amber-800',
                )}
              >
                {alert.noteNo} · {money(alert.amount)} ·{' '}
                {alert.daysLeft < 0
                  ? `已逾期 ${-alert.daysLeft} 天`
                  : alert.daysLeft === 0
                    ? '今日到期'
                    : `${alert.daysLeft} 天后到期`}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
};

export default NotesRegisterSummary;
