/**
 * 对账单结果区（§5.9 / F8）—— 从 `StatementTab.tsx` 抽出的展示组件。
 *
 * 抽出的这一块原先嵌在父组件的 `<DataState>` 里（`{statement ? … : null}`），
 * 是本文件体量最大的单块 JSX：抬头卡 + 三张 StatCard + 作废剔除提示 +
 * 余额走势图 + 明细表（含 `Table.Summary` 合计行）+ 期初构成表 + 口径说明。
 *
 * 为什么按"整块结果区"抽，而不是只拆表格：
 *   · 这块**没有任何 state、没有副作用、没有 handler** —— 它是纯展示，
 *     全部输入都是父组件已经算好的数据（`statement` / `lines` / `chartData` /
 *     `option` / `columns` / `summary` / `excludedCount` / `direction` / `loading`）；
 *   · 反过来，图表 `option` 与表格 `columns` 的 `useMemo` 刻意留在父组件：
 *     两者的依赖（`chartData` / `STATUS_CLASS` / `DOC_TYPE_LABELS`）原本就在那里，
 *     搬走只会把 memo 依赖链拉长，或需要多传一层 props。
 *
 * ⚠️ **行为零变更**（搬迁时逐条核对）：
 *   · 原块的 175 行（`{statement ? (` 到 `) : null}`，父组件 374–548 行）**逐字搬运**；
 *   · 子组件内只做两处允许的改动：① 整体去掉一层 10 空格缩进（脚本机械完成）；
 *     ② 删掉原块自带的条件包装两行 —— 因为「`statement` 非空才渲染」由**父组件
 *     同一处**的 `{statement ? <StatementReport …/> : null}` 承担（`DataState` 的
 *     `empty` 分支**不会**拦截 children，`DataState.tsx` 末尾是 `return <>{children}</>`，
 *     所以这层守卫必须留在父组件，且位置与原来完全相同）；
 *   · 本块原本就没有 `useState`/`useEffect`/`useForm`，所以不存在
 *     "打开即重置"这类触发点 —— 搬迁不引入任何重置；
 *   · 判据：`statement` 为 null 时的渲染结果与改动前一致（父组件条件为假 → 不渲染）。
 *
 * 打印件不受影响：`buildPack`（含 7 列明细与期初/本期/期末三段合计）仍留在
 * 父组件 —— `PrintButton` 挂在父组件的 `FilterBar` 里，本组件只负责屏幕展示。
 * 文案字典同理留在父组件：本块只用到 `DOC_TYPE_LABELS`，由 props 传入以与打印包
 * **共用同一张表**（不复制第二份定义）。
 */
import React from 'react';
import type { EChartsOption } from 'echarts';
import { Table, TableColumnsType } from 'antd';
import { AlertTriangle, Scale } from 'lucide-react';
import { EChart } from '@client/src/components/EChart';
import { SectionTitle } from '@client/src/components/SectionTitle';
import StatCard from '@client/src/components/erp/StatCard';
import { cellText } from '@client/src/components/print';
import { formatMoney } from '@client/src/utils/format';
import type {
  StatementDirection,
  StatementLineItem,
  StatementResult,
} from '@shared/api.interface';

/*
 * 单据类型文案**只有父组件这一张表**（`DOC_TYPE_LABELS`），本组件通过 props 取用 ——
 * 原块里 `DOC_TYPE_LABELS` 是父组件的模块级常量，两处 JSX（明细表列渲染与
 * 期初构成表）都用它。若在本文件里复制一份，两处文案就会各自演化（同一
 * `docType` 在屏幕与打印件上不一致）；而 `STATUS_LABELS` 原块根本没用到
 * （它只服务父组件打印包与 `columns`），因此**不**作为 props 传入。
 */
type DocTypeLabels = Record<StatementLineItem['docType'], string>;

interface StatementReportProps {
  /** 对账方向：决定抬头与期末余额的措辞 */
  direction: StatementDirection;
  /** 服务端对账单结果（父组件已判非空才渲染本组件） */
  statement: StatementResult;
  /** 本期明细行（父组件 memo 过，与 `statement.lines` 同源） */
  lines: StatementLineItem[];
  /** 有运行余额的行（图表数据源） */
  chartData: StatementLineItem[];
  /** 余额走势图 option（父组件 memo） */
  option: EChartsOption;
  /** 明细表列定义（父组件 memo） */
  columns: TableColumnsType<StatementLineItem>;
  /** 本期核对进度 */
  summary: StatementResult['reconSummary'] | undefined;
  /** 本期被整单剔除的作废单据数 */
  excludedCount: number;
  /** 明细表 loading（与父组件结果查询共用） */
  loading: boolean;
  /** 文案字典：与父组件打印包用的是同一张表 */
  docTypeLabels: DocTypeLabels;
}

const StatementReport: React.FC<StatementReportProps> = ({
  direction,
  statement,
  lines,
  chartData,
  option,
  columns,
  summary,
  excludedCount,
  loading,
  docTypeLabels: DOC_TYPE_LABELS,
}) => {
  return (
  <div className="flex flex-col gap-4">
    <div className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <p className="text-base font-semibold">
            {direction === 'customer' ? '客户对账单' : '供应商对账单'}：
            {statement.counterparty.name}
          </p>
          <p className="text-sm text-muted-foreground">
            期间 {statement.period}（{statement.periodRange.start} 至{' '}
            {statement.periodRange.monthEnd}） · 单据编号{' '}
            {statement.counterparty.code} · 我方抬头{' '}
            {statement.org.companyName ?? '未配置纳税主体'}
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          生成时间{' '}
          {new Date(statement.generatedAt).toLocaleString('zh-CN')}
        </p>
      </div>
    </div>

    <div className="grid grid-cols-3 gap-4">
      <StatCard
        label="期初余额"
        value={formatMoney(statement.openingBalance)}
        icon={Scale}
        tone="neutral"
        hint={`${statement.periodRange.start} 之前的累计发生额净额`}
      />
      <StatCard
        label="本期增加 / 减少"
        value={`${formatMoney(statement.periodDebit)} / ${formatMoney(statement.periodCredit)}`}
        icon={Scale}
        tone="info"
        hint={`本期发生 ${lines.length} 笔`}
      />
      <StatCard
        label={direction === 'customer' ? '期末应收余额' : '期末应付余额'}
        value={formatMoney(statement.closingBalance)}
        icon={Scale}
        tone={statement.closingBalance > 0 ? 'warning' : 'success'}
        hint={`大写：${statement.closingBalanceInWords}`}
      />
    </div>

    {excludedCount > 0 ? (
      <div className="flex items-start gap-2 rounded-md border border-dashed px-3 py-2 text-sm">
        <AlertTriangle
          className="mt-0.5 size-4 shrink-0 text-warning"
          aria-hidden="true"
        />
        <span>
          本期有 <strong>{excludedCount}</strong> 张已作废单据已被整单剔除（不参与余额）：
          {statement.excludedLines
            .map((line) => line.docCode)
            .join('、')}
        </span>
      </div>
    ) : null}

    <div className="rounded-lg border bg-card p-4">
      <SectionTitle>余额走势（含期初）</SectionTitle>
      {chartData.length > 0 ? (
        <div role="img" aria-label="对账单运行余额走势图">
          <EChart option={option} className="h-[260px] w-full" />
        </div>
      ) : (
        <p className="py-8 text-center text-sm text-muted-foreground">
          本期无余额类发生额，仅有期初余额 {formatMoney(statement.openingBalance)}
        </p>
      )}
    </div>

    <Table
      columns={columns}
      dataSource={lines}
      loading={loading}
      rowKey={(row: StatementLineItem) =>
        `${row.date}-${row.docType}-${row.docCode}`
      }
      rowClassName={(row: StatementLineItem) =>
        row.affectsBalance ? '' : 'text-muted-foreground'
      }
      scroll={{ x: 1100, y: 420 }}
      pagination={{
        pageSize: 50,
        showTotal: (t: number) => `共 ${t} 条`,
      }}
      locale={{
        emptyText:
          '本期无发生额；如期末余额≠0，说明余额全部来自期初结转。',
      }}
      summary={() => (
        <Table.Summary fixed>
          <Table.Summary.Row>
            <Table.Summary.Cell index={0} colSpan={3}>
              <span className="font-medium">
                期初 {formatMoney(statement.openingBalance)} · 本期增加{' '}
                {formatMoney(statement.periodDebit)} · 本期减少{' '}
                {formatMoney(statement.periodCredit)}
              </span>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={3} align="right">
              {cellText(statement.periodDebit)}
            </Table.Summary.Cell>
            <Table.Summary.Cell index={4} align="right">
              {cellText(statement.periodCredit)}
            </Table.Summary.Cell>
            <Table.Summary.Cell index={5} align="right">
              <span className="font-semibold">
                {cellText(statement.closingBalance)}
              </span>
            </Table.Summary.Cell>
            <Table.Summary.Cell index={6} colSpan={2}>
              <span className="text-muted-foreground">
                已核销 {summary?.reconciled ?? 0} / 部分 {summary?.partial ?? 0} /
                未核销 {summary?.open ?? 0}
              </span>
            </Table.Summary.Cell>
          </Table.Summary.Row>
        </Table.Summary>
      )}
    />

    {statement.openingLines.length > 0 ? (
      <div className="rounded-lg border bg-card p-4">
        <SectionTitle>
          期初构成（{statement.openingLines.length} 笔，
          {statement.periodRange.start} 之前）
        </SectionTitle>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left">
              <tr>
                <th className="p-2">日期</th>
                <th className="p-2">单据类型</th>
                <th className="p-2">单据编号</th>
                <th className="p-2 text-right">增加</th>
                <th className="p-2 text-right">减少</th>
              </tr>
            </thead>
            <tbody>
              {statement.openingLines.map((line) => (
                <tr
                  key={`${line.date}-${line.docType}-${line.docCode}`}
                  className="border-t"
                >
                  <td className="p-2">{line.date || '—'}</td>
                  <td className="p-2">{DOC_TYPE_LABELS[line.docType]}</td>
                  <td className="p-2 font-mono text-xs">{line.docCode}</td>
                  <td className="p-2 text-right">
                    {line.affectsBalance ? cellText(line.debit) : '—'}
                  </td>
                  <td className="p-2 text-right">
                    {line.affectsBalance ? cellText(line.credit) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    ) : null}

    <p className="text-sm text-muted-foreground">
      口径说明（**需财务确认**）：① 期初余额 =
      期间开始日之前的累计发生额净额（系统无期末余额快照，期末由发生额推导）；
      ② 期间边界左闭右开，期间开始日当天计入本期、次月 1 日计入下期；
      ③ 作废的收付款/发票整单剔除；④ 发票行仅为备查，不重复计入余额；
      ⑤ 未核销回款按实收计入（减少余额），核对状态显示为未核销/部分核销。
    </p>
  </div>
  );
};

export default StatementReport;
