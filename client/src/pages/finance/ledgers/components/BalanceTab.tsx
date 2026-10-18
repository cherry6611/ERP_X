/**
 * 科目余额表 Tab
 *
 * §5.9（F8）：从 `LedgersPage.tsx` 抽出的独立 Tab 组件。
 *
 * 抽出的理由与收益（同 `AGENTS.md` 的拆分判据 3）：
 *   · 原先每个 Tab 的「数据查询 / 列定义 / 渲染」分散在文件的三处不相邻块里，
 *     改一个表要在 1000+ 行里跳三次；抽出后三者同处一文件，就近可读。
 *   · 主文件只剩筛选区与 Tab 编排，骨架一眼可见。
 *
 * ⚠️ **行为零变更**：本组件是原渲染体的逐字搬运，只做了两件事 ——
 *   ① 把外部变量改为 props（`data` / `loading` / `error` / `reload` 等）；
 *   ② 去掉一层多余缩进。列定义、文案、条件分支、摘要行全部未动。
 */

import { useMemo } from 'react';
import { Table, type TableColumnsType } from 'antd';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import { Badge } from '@client/src/components/ui/badge';
import { amount, buildLeafSubtotals, sumRows } from '../ledger-format';
import { DIRECTION_LABELS } from '../ledger-export-columns';
import type {
  AccountBalanceSheet,
  AccountBalanceRow,
} from '@shared/api.interface';

/*
 * 科目余额表的两类行（判别联合）。
 *
 * antd 的 `dataSource` 是一维数组，无法在一次 `map` 里额外输出一行小计，
 * 因此把「下级末级科目小计」提升为独立行类型，用 `kind` 区分。
 * 判别联合让列渲染的 `record.kind === 'main'` 分支被 TypeScript **穷尽检查**：
 * 漏处理小计行时会在编译期报错，而不是运行时读到 undefined 显示空白。
 */
type BalanceTableRow =
  | { kind: 'main'; rowKey: string; row: AccountBalanceRow }
  | {
      kind: 'subtotal';
      rowKey: string;
      accountCode: string;
      count: number;
      sum: ReturnType<typeof sumRows>;
    };

interface BalanceTabProps {
  period: string;
  keyword: string;
  data: AccountBalanceSheet | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const BalanceTab: React.FC<BalanceTabProps> = ({
  period,
  keyword,
  data,
  loading,
  error,
  reload,
}) => {

  /*
   * 依赖内容 → 派生值。原实现在主文件里，拆 Tab 后必须在本组件内重建 ——
   * 「筛选关键词」与「小计分组」都是**本 Tab 专属**的展示逻辑，
   * 留在主文件反而会让主文件知道 BalanceTab 的内部细节。
   *
   * ⚠️ 两处 `useMemo` 的依赖只列真正会变的输入：`data` 与 `keyword`。
   * 少了 memo，`filteredBalanceRows` 每次渲染都是新数组 →
   * 下游 `balanceTableRows`（dataSource）跟着变 → antd Table 重置分页与排序。
   */
  const balanceRows = useMemo(() => data?.items ?? [], [data]);
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

  const balanceTableRows = useMemo<BalanceTableRow[]>(() => {
  const rows: BalanceTableRow[] = [];
  for (const row of filteredBalanceRows) {
    rows.push({ kind: 'main', rowKey: row.accountCode, row });
    const subtotalRows = leafSubtotals.get(row.accountCode) ?? [];
    if (subtotalRows.length > 0) {
      rows.push({
        kind: 'subtotal',
        rowKey: `${row.accountCode}__subtotal`,
        accountCode: row.accountCode,
        count: subtotalRows.length,
        sum: sumRows(subtotalRows),
      });
    }
  }
  return rows;
}, [filteredBalanceRows, leafSubtotals]);


const balanceColumns = useMemo<TableColumnsType<BalanceTableRow>>(
  () => [
    {
      title: '科目编码',
      dataIndex: ['row', 'accountCode'],
      width: 110,
      fixed: 'left',
      // 小计行以父科目编码开头，便于单独出现在分页首行时仍可归属
      render: (_value, record) =>
        record.kind === 'main' ? (
          <span className="tabular-nums">{record.row.accountCode}</span>
        ) : (
          <span className="tabular-nums text-xs text-muted-foreground">
            {record.accountCode}
          </span>
        ),
      sorter: (a, b) => {
        const left = a.kind === 'main' ? a.row.accountCode : a.accountCode;
        const right = b.kind === 'main' ? b.row.accountCode : b.accountCode;
        return left.localeCompare(right);
      },
    },
    {
      title: '科目名称',
      dataIndex: ['row', 'accountName'],
      width: 260,
      render: (_value, record) => {
        if (record.kind === 'subtotal') {
          return (
            <span className="text-xs text-muted-foreground">
              其中：下级末级科目小计（{record.count} 个）
            </span>
          );
        }
        return (
          <span>
            <span
              style={{ paddingLeft: `${Math.max(0, record.row.level - 1) * 12}px` }}
            >
              {record.row.accountName}
            </span>
            {!record.row.isLeaf ? (
              <Badge variant="outline" className="ml-2">
                汇总
              </Badge>
            ) : null}
          </span>
        );
      },
      sorter: (a, b) => {
        const left = a.kind === 'main' ? a.row.accountName : '';
        const right = b.kind === 'main' ? b.row.accountName : '';
        return left.localeCompare(right, 'zh-Hans-CN');
      },
    },
    {
      title: '级次',
      width: 70,
      align: 'center',
      responsive: ['xxl'],
      render: (_value, record) =>
        record.kind === 'main' ? record.row.level : '—',
    },
    {
      title: '方向',
      width: 70,
      align: 'center',
      responsive: ['xxl'],
      render: (_value, record) =>
        record.kind === 'main'
          ? (DIRECTION_LABELS[record.row.direction] ?? record.row.direction)
          : '—',
    },
    ...(
      [
        ['期初借', 'openingDebit'],
        ['期初贷', 'openingCredit'],
        ['本期借', 'debitOccur'],
        ['本期贷', 'creditOccur'],
        ['期末借', 'closingDebit'],
        ['期末贷', 'closingCredit'],
      ] as const
    ).map(([title, field]) => ({
      title,
      width: 110,
      align: 'right' as const,
      render: (_value: unknown, record: BalanceTableRow) => {
        const source =
          record.kind === 'main' ? record.row : record.sum;
        return (
          <span className="tabular-nums">{amount(source[field])}</span>
        );
      },
      sorter: (a: BalanceTableRow, b: BalanceTableRow) => {
        const left = a.kind === 'main' ? a.row[field] : a.sum[field];
        const right = b.kind === 'main' ? b.row[field] : b.sum[field];
        return Number(left ?? 0) - Number(right ?? 0);
      },
    })),
  ],
  // `amount` / `DIRECTION_LABELS` 都是模块级常量，无需进依赖
    [],
);


return (
    <DataBoundary
      loading={loading}
      error={error}
      empty={!loading && !error && filteredBalanceRows.length === 0}
      emptyText={
        keyword
          ? `没有匹配「${keyword}」的科目，请调整关键字`
          : `期间 ${period} 无科目余额数据，请确认该期间凭证已过账`
      }
      onRetry={() => void reload()}
    >
      {data && !data.balanced ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2 text-sm text-destructive"
        >
          科目余额表借贷不平衡（期末借方合计 ≠ 期末贷方合计），请检查该期间凭证
        </p>
      ) : null}
      <div className="rounded-lg border bg-card">
        {/*
          §5.5（F4）：由 shadcn `<Table>` 改为 antd `<Table>`。

          ## 为什么这一处必须换（不是风格问题）

          shadcn 的 `Table` 是**纯样式表格**：没有分页、没有排序、没有固定列、
          没有 `scroll` 横向容器、没有空态钩子。科目余额表在本仓可达成千行，
          原先**全量渲染** —— 打开账簿页即渲染数千个 `<tr>`，且科目编码列
          在横向滚动时不会固定。

          ## 小计行怎么处理（关键设计）

          原实现用 `React.Fragment` 在一次 `map` 里输出「主行 + 小计行」两行，
          这在 JSX 手写表里可行，但 antd 的 `dataSource` 是**一维数组**，
          无法这样塞入额外行。

          因此把小计**提升为数据源里的独立行**（`kind: 'subtotal'`），
          用判别联合类型区分。这样：
            · 分页与排序对两类行一视同仁（antd 自己处理）；
            · 不需要 `rowRender` hack；
            · `rowClassName` 按 `kind` 上色，与原实现的 `bg-muted/30` 等价。

          ⚠️ 副作用（有意接受）：分页边界可能把小计行与其主行拆到两页。
          对本场景可接受 —— 小计行自带「其中：下级末级科目小计」文案与父科目编码，
          单独出现时仍可读。若将来要求两者必须同页，应改用 antd 的
          `expandable`（把小计放进展开区）而不是取消分页。
        */}
        <Table<BalanceTableRow>
          columns={balanceColumns}
          dataSource={balanceTableRows}
          loading={loading}
          rowKey="rowKey"
          size="small"
          /*
           * `scroll.x` 是必需的：9 个金额列在 1280px 下必然溢出，
           * 没有它 antd 会把列压扁到不可读（shadcn 版靠外层 overflow-x-auto
           * 横滚，代价是科目编码列跟着滚走）。
           */
          scroll={{ x: 1120 }}
          pagination={{
            pageSize: 100,
            showSizeChanger: true,
            pageSizeOptions: ['50', '100', '200', '500'],
            showTotal: (total: number) => `共 ${total} 行`,
          }}
          locale={{ emptyText: '当前筛选条件下无科目余额数据' }}
        />
      </div>
    </DataBoundary>
  );
};

export default BalanceTab;


