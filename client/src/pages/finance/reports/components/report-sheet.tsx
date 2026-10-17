/**
 * 财务报表的**展示组件**（§5.9 / F8）
 *
 * 从 `ReportsPage.tsx` 整块搬出（原文件 82–307 行）：
 *   · `COLUMN_WIDTHS` —— 三列宽度的唯一来源（行次 / 项目 / 金额）；
 *   · `AmountColumnMeta` + `amountColumns` —— 资产负债表与利润表/现金流量表的
 *     表头口径不同（期末余额 vs 本期金额），由 `reportCode` 决定；
 *     父组件也要用（导出表头），故 `export`；
 *   · `CheckCard` —— 单张校验卡（借贷平衡等），通过/不通过用 Badge 语义色；
 *   · `ReportRowItem` —— 单行，可下钻时用 `Collapsible` 展开明细；
 *   · `ReportSheetView` —— 整张报表：校验卡区 + 分组标题 + 行 + 合计。
 *
 * ## 为什么搬出来
 *
 * 主文件原先 505 非空行（审计门槛 500）。这一块是**纯展示**、与页面取数无关
 * （只吃 `sheet`/`reportCode`/`sections` 三个 props），且 `ReportRowItem`
 * 自持 `open` 状态 —— 正是"区块组件"的判据。搬出后主文件只剩
 * 筛选区 + Tab 切换 + 取数 + 导出，符合 §5.9 的 4 条拆分判据。
 *
 * ⚠️ **行号为原文件行号、逐字搬移**，唯一改动是三处 `export` 前缀与整体
 * 缩进（本块原本就在模块顶层，缩进未变）。没有改动任何 JSX、类名或文案。
 */
import React, { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Badge } from '@client/src/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@client/src/components/ui/collapsible';
import { cn } from '@client/src/lib/utils';
import { formatMoney } from '@client/src/utils/format';
import type {
  ReportCheck,
  ReportCode,
  ReportRow,
  ReportSheet,
} from '@shared/api.interface';

/**
 * section 是模板里的分组码，用于给行插分组小标题（取值来自报表模板种子数据）。
 *
 * 随 `ReportSheetView` 一起从 `ReportsPage.tsx` 搬来：父组件对它**零引用**，
 * 唯一消费者是 `groupBySection`（本文件内），所以留在父文件只会变成死代码。
 */
const SECTION_LABELS: Record<string, string> = {
  assets: '资产',
  liabilities: '负债',
  equity: '所有者权益',
  revenue: '收入',
  cost: '成本费用',
  profit: '利润',
  operating: '经营活动',
  investing: '投资活动',
  financing: '筹资活动',
  summary: '净增加额',
  cash: '现金余额',
  default: '',
};

const COLUMN_WIDTHS = {
  no: 'w-[72px]',
  name: 'min-w-[280px] flex-1',
  amount: 'w-[150px]',
} as const;

export interface AmountColumnMeta {
  /** 资产负债表为期末余额，利润表/现金流量表为本期金额 */
  thirdLabel: string;
  fourthLabel: string;
  fifthLabel: string;
}

export function amountColumns(reportCode: ReportCode): AmountColumnMeta {
  if (reportCode === 'balance_sheet') {
    return {
      thirdLabel: '期末余额',
      fourthLabel: '年初余额',
      fifthLabel: '年初余额',
    };
  }
  return {
    thirdLabel: '本期金额',
    fourthLabel: '本年累计',
    fifthLabel: '上期金额',
  };
}

const CheckCard: React.FC<{ check: ReportCheck }> = ({ check }) => (
  <div
    className={cn(
      'flex flex-col gap-2 rounded-xl border bg-card p-4',
      check.passed ? 'border-success/30' : 'border-destructive/40',
    )}
  >
    <div className="flex items-start justify-between gap-2">
      <p className="text-xs text-muted-foreground">{check.label}</p>
      <Badge variant={check.passed ? 'success' : 'destructive'}>
        {check.passed ? '通过' : '不通过'}
      </Badge>
    </div>
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-muted-foreground">
      <span>
        左值 <span className="tabular-nums text-foreground">{formatMoney(check.left)}</span>
      </span>
      <span>
        右值 <span className="tabular-nums text-foreground">{formatMoney(check.right)}</span>
      </span>
      <span>
        差额{' '}
        <span
          className={cn(
            'tabular-nums',
            check.difference === 0 ? 'text-foreground' : 'text-destructive',
          )}
        >
          {formatMoney(check.difference)}
        </span>
      </span>
    </div>
  </div>
);

const ReportRowItem: React.FC<{ row: ReportRow; meta: AmountColumnMeta }> = ({
  row,
  meta,
}) => {
  const [open, setOpen] = useState(false);
  const hasDetails = (row.details ?? []).length > 0;
  const indent = Math.max(0, Number(row.indent ?? 0));

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="border-b last:border-b-0">
        <CollapsibleTrigger
          type="button"
          disabled={!hasDetails}
          className={cn(
            'flex w-full items-center text-left text-sm transition-colors',
            hasDetails ? 'cursor-pointer hover:bg-muted/50' : 'cursor-default',
            row.bold && 'font-semibold',
          )}
        >
          <span className={cn('px-2 py-2 text-muted-foreground', COLUMN_WIDTHS.no)}>
            {row.rowNo}
          </span>
          <span className={cn('px-2 py-2', COLUMN_WIDTHS.name)}>
            <span style={{ paddingLeft: `${indent * 16}px` }}>{row.rowName}</span>
            {hasDetails ? (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {open ? '收起明细' : `取数明细 ${(row.details ?? []).length}`}
              </span>
            ) : null}
          </span>
          <span className={cn('px-2 py-2 text-right tabular-nums', COLUMN_WIDTHS.amount)}>
            {formatMoney(row.amount)}
          </span>
          <span className={cn('px-2 py-2 text-right tabular-nums', COLUMN_WIDTHS.amount)}>
            {formatMoney(row.ytdAmount)}
          </span>
          <span className={cn('px-2 py-2 text-right tabular-nums', COLUMN_WIDTHS.amount)}>
            {formatMoney(row.previousAmount)}
          </span>
        </CollapsibleTrigger>
        {hasDetails ? (
          <CollapsibleContent>
            <div className="bg-muted/30 px-4 py-2">
              <p className="mb-1 text-xs text-muted-foreground">
                行次 {row.rowNo} 取数明细（公式：{row.formula || '-'}）
              </p>
              <div className="flex flex-col">
                {(row.details ?? []).map((detail) => (
                  <div
                    key={`${detail.accountCode}-${detail.accountName}`}
                    className="flex items-center gap-4 border-b border-dashed py-1 text-xs last:border-b-0"
                  >
                    <span className="w-[120px] tabular-nums text-muted-foreground">
                      {detail.accountCode}
                    </span>
                    <span className="min-w-[200px] flex-1">{detail.accountName}</span>
                    <span className="w-[150px] text-right tabular-nums">
                      {formatMoney(detail.amount)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </CollapsibleContent>
        ) : null}
      </div>
    </Collapsible>
  );
};

/** 把连续同 section 的行聚成块，用于插分组小标题行 */
function groupBySection(
  rows: ReportRow[],
  sections: Map<string, string>,
): Array<{ section: string; rows: ReportRow[] }> {
  const groups: Array<{ section: string; rows: ReportRow[] }> = [];
  for (const row of rows) {
    const section = sections.get(row.rowNo) ?? '';
    const last = groups[groups.length - 1];
    if (last && last.section === section) last.rows.push(row);
    else groups.push({ section, rows: [row] });
  }
  return groups;
}

interface ReportSheetViewProps {
  sheet: ReportSheet;
  reportCode: ReportCode;
  /** rowNo → section（来自报表模板接口，用于分组小标题） */
  sections: Map<string, string>;
}

export const ReportSheetView: React.FC<ReportSheetViewProps> = ({
  sheet,
  reportCode,
  sections,
}) => {
  const meta = amountColumns(reportCode);
  const rows = sheet.rows ?? [];
  const groups = groupBySection(rows, sections);

  return (
    <div className="flex flex-col gap-4">
      {!sheet.balanced ? (
        <div
          role="alert"
          className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
        >
          <AlertTriangle className="size-4 shrink-0" />
          报表未通过会计恒等式校验，请检查凭证
        </div>
      ) : null}

      {(sheet.checks ?? []).length > 0 ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {sheet.checks.map((check) => (
            <CheckCard key={check.code} check={check} />
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">该报表本次未返回校验项。</p>
      )}

      <div className="rounded-lg border bg-card">
        <div className="flex items-center text-xs font-medium text-muted-foreground">
          <span className={cn('px-2 py-2', COLUMN_WIDTHS.no)}>行次</span>
          <span className={cn('px-2 py-2', COLUMN_WIDTHS.name)}>项目</span>
          <span className={cn('px-2 py-2 text-right', COLUMN_WIDTHS.amount)}>
            {meta.thirdLabel}
          </span>
          <span className={cn('px-2 py-2 text-right', COLUMN_WIDTHS.amount)}>
            {meta.fourthLabel}
          </span>
          <span className={cn('px-2 py-2 text-right', COLUMN_WIDTHS.amount)}>
            {meta.fifthLabel}
          </span>
        </div>
        {groups.map((group) => {
          const label = SECTION_LABELS[group.section] ?? group.section;
          return (
            <div key={group.section || 'default'}>
              {label ? (
                <div className="border-y bg-muted/40 px-2 py-1 text-xs font-semibold">
                  {label}
                </div>
              ) : null}
              {group.rows.map((row) => (
                <ReportRowItem key={row.rowNo} row={row} meta={meta} />
              ))}
            </div>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        报表生成时间：
        {sheet.generatedAt ? new Date(sheet.generatedAt).toLocaleString('zh-CN') : '-'}
        ；纳税主体：{sheet.taxEntityName ?? '全部（未指定主体）'}
      </p>
    </div>
  );
};
