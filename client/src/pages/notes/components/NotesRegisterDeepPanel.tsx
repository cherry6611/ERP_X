/**
 * 备查簿深化（D-02）：票号连续性 / 到期结构 / 贴现成本 / 需关注清单（§5.9 / F8）。
 *
 * 从 `NotesPage.tsx` 抽出的**第四段 JSX**（原第 520–706 行，187 行 ——
 * 单块占页面体量最大的一块）。
 *
 * ⚠️ **行为零变更**：JSX 与原块**逐字相同**，只做了两件事：
 *   ① 整体去一层缩进（8 → 6）；
 *   ② `deep` 由父组件经 props 传入（原为页面级 `const { data: deep }`）。
 *
 * 本块里的四个子区块全部只读 `deep`（服务端算好的到期结构 / 贴现成本 / 年化率），
 * 页面不做任何二次计算 —— 拆出来后同样不引入任何计算，避免"客户端算一遍、
 * 服务端算一遍"的口径分裂。
 *
 * 条件 `{deep && (...)}` 原样保留：本组件**无条件挂载**，数据未到时
 * `deep` 为 `null`，渲染结果与拆分前完全一致（不产生任何 DOM）。
 */
import React from 'react';
import StatCard from '@client/src/components/erp/StatCard';
import { cn } from '@client/src/lib/utils';
import { TYPE_LABELS, money } from '../note-format';
import type { NoteRegisterDeepResult } from '@shared/api.interface';

interface NotesRegisterDeepPanelProps {
  /** 备查簿深化汇总（`GET /api/notes/register-deep`）；未取到时为 `null` */
  deep: NoteRegisterDeepResult | null;
}

const NotesRegisterDeepPanel: React.FC<NotesRegisterDeepPanelProps> = ({
  deep,
}) => {
  return (
    <>
      {/* D-02：备查簿深化 —— 到期结构 / 票号连续性 / 贴现成本 */}
      {deep && (
        <div className="flex flex-col gap-4">
          <h3 className="text-base font-semibold">
            备查簿深化（D-02）
          </h3>

          {/* 票号连续性：《票据管理实施办法》要求备查簿连续登记 */}
          <div
            className={cn(
              'rounded-md border p-3',
              deep.numbering.hasIssues
                ? 'border-amber-300 bg-amber-50'
                : 'border-border bg-muted/30',
            )}
          >
            <p
              className={cn(
                'text-sm font-medium',
                deep.numbering.hasIssues ? 'text-amber-900' : 'text-foreground',
              )}
            >
              票号连续性：{deep.numbering.message}
            </p>
            {deep.numbering.duplicates.length > 0 && (
              <div className="mt-2 flex flex-col gap-1">
                {deep.numbering.duplicates.map((item) => (
                  <p key={item.noteNo} className="text-xs text-amber-800">
                    · 票号 {item.noteNo} 重复登记 {item.codes.length} 次
                    （{item.codes.join('、')}），合计 {money(item.amount)}
                    {item.allVoided ? '（全部已作废，可能是作废后重开）' : '（含未作废票据，需核查是否重复入账）'}
                  </p>
                ))}
              </div>
            )}
            {deep.numbering.gaps.length > 0 && (
              <div className="mt-2 flex flex-col gap-1">
                {deep.numbering.gaps.map((gap) => (
                  <p
                    key={`${gap.before}-${gap.after}`}
                    className="text-xs text-amber-800"
                  >
                    · 票号缺口：{gap.before} → {gap.after}，缺 {gap.missing} 个
                  </p>
                ))}
              </div>
            )}
          </div>

          {/* 到期结构 */}
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50">
                <tr className="text-left">
                  <th className="p-2 font-medium">到期区间</th>
                  <th className="p-2 text-right font-medium">张数</th>
                  <th className="p-2 text-right font-medium">金额</th>
                  <th className="p-2 text-right font-medium">占未结清</th>
                </tr>
              </thead>
              <tbody>
                {deep.dueStructure.buckets.map((bucket) => (
                  <tr key={bucket.bucket} className="border-t">
                    <td className="p-2">
                      {bucket.label}
                      {bucket.bucket === 'overdue' && bucket.count > 0 && (
                        <span className="ml-2 text-xs text-destructive">
                          需立即处理
                        </span>
                      )}
                    </td>
                    <td className="p-2 text-right tabular-nums">{bucket.count}</td>
                    <td className="p-2 text-right tabular-nums">
                      {money(bucket.amount)}
                    </td>
                    <td className="p-2 text-right tabular-nums">
                      {bucket.share.toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 贴现成本 */}
          {deep.discountCost.count > 0 && (
            <div className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <StatCard
                  label="已贴现张数"
                  value={String(deep.discountCost.count)}
                />
                <StatCard
                  label="贴现金额"
                  value={money(deep.discountCost.amount)}
                />
                <StatCard
                  label="贴现息合计"
                  value={money(deep.discountCost.interest)}
                  tone="warning"
                />
                <StatCard
                  label={`综合成本率 / 年化 ${deep.discountCost.annualizedRate.toFixed(2)}%`}
                  value={`${deep.discountCost.weightedRate.toFixed(2)}%`}
                />
              </div>
              <div className="overflow-x-auto rounded-md border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr className="text-left">
                      <th className="p-2 font-medium">票据类型</th>
                      <th className="p-2 text-right font-medium">张数</th>
                      <th className="p-2 text-right font-medium">金额</th>
                      <th className="p-2 text-right font-medium">贴现息</th>
                      <th className="p-2 text-right font-medium">成本率</th>
                    </tr>
                  </thead>
                  <tbody>
                    {deep.discountCost.byType.map((item) => (
                      <tr key={item.noteType} className="border-t">
                        <td className="p-2">
                          {TYPE_LABELS[
                            item.noteType as keyof typeof TYPE_LABELS
                          ] ?? item.noteType}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {item.count}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {money(item.amount)}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {money(item.interest)}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {item.weightedRate.toFixed(2)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {deep.discountCost.incompleteCodes.length > 0 && (
                <p className="text-xs text-amber-700">
                  以下票据缺贴现息或计息天数，未计入年化率（需补录）：
                  {deep.discountCost.incompleteCodes.join('、')}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                综合成本率是**加权**的（息合计 / 金额合计），不是各张票贴现率的
                算术平均 —— 后者会被一张小额高息票严重扭曲。
              </p>
            </div>
          )}

          {/* 需关注清单 */}
          {deep.attention.length > 0 && (
            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-semibold">
                需关注票据（逾期或 15 天内到期，{deep.attention.length} 张）
              </h4>
              <div className="flex flex-wrap gap-2">
                {deep.attention.map((item) => (
                  <span
                    key={item.code}
                    className={cn(
                      'rounded px-2 py-1 text-xs',
                      item.daysLeft < 0
                        ? 'bg-rose-100 text-rose-800'
                        : item.daysLeft <= 3
                          ? 'bg-orange-100 text-orange-800'
                          : 'bg-amber-100 text-amber-800',
                    )}
                  >
                    {item.noteNo} · {money(item.amount)} ·{' '}
                    {item.daysLeft < 0
                      ? `已逾期 ${-item.daysLeft} 天`
                      : item.daysLeft === 0
                        ? '今日到期'
                        : `${item.daysLeft} 天后到期`}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
};

export default NotesRegisterDeepPanel;
