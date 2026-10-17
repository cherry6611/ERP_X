/**
 * 总账 Tab
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
import { amount, sideAmount } from '../ledger-format';
import { DIRECTION_LABELS } from '../ledger-export-columns';
import type {
  GeneralLedgerSheet,
  GeneralLedgerRow,
} from '@shared/api.interface';

interface GeneralTabProps {
  period: string;
  data: GeneralLedgerSheet | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  onDrillDown: (accountCode: string) => void;
}

const GeneralTab: React.FC<GeneralTabProps> = ({
  period,
  data,
  loading,
  error,
  reload,
  onDrillDown,
}) => {
/*
   * 总账行。原在主文件里派生（`general.data?.rows ?? []`），拆 Tab 后
   * 必须在本组件内重建 —— 且必须 `useMemo`：新数组会让 antd Table 的
   * `dataSource` 每次渲染都变，从而**重置分页与排序状态**。
   */
  const generalRows = useMemo(() => data?.items ?? [], [data]);

  const generalColumns = useMemo<TableColumnsType<GeneralLedgerRow>>(
  () => [
    {
      title: '科目编码',
      dataIndex: 'accountCode',
      width: 110,
      fixed: 'left',
      render: (value: string) => <span className="tabular-nums">{value}</span>,
      sorter: (a, b) => a.accountCode.localeCompare(b.accountCode),
    },
    {
      title: '科目名称',
      dataIndex: 'accountName',
      width: 240,
      sorter: (a, b) => a.accountName.localeCompare(b.accountName, 'zh-Hans-CN'),
    },
    {
      title: '方向',
      dataIndex: 'direction',
      width: 70,
      align: 'center',
      render: (value: string) => DIRECTION_LABELS[value] ?? value,
    },
    ...[
      ['期初借', 'openingDebit'],
      ['期初贷', 'openingCredit'],
      ['本期借', 'debitOccur'],
      ['本期贷', 'creditOccur'],
    ].map(([title, field]) => ({
      title,
      width: 130,
      align: 'right' as const,
      render: (_value: unknown, record: GeneralLedgerRow) => (
        <span className="tabular-nums">
          {amount(record[field as keyof GeneralLedgerRow] as number | null)}
        </span>
      ),
      sorter: (a: GeneralLedgerRow, b: GeneralLedgerRow) =>
        Number(a[field as keyof GeneralLedgerRow] ?? 0) -
        Number(b[field as keyof GeneralLedgerRow] ?? 0),
    })),
    {
      title: '期末余额',
      width: 150,
      align: 'right',
      render: (_value, record) => (
        <span className="tabular-nums">
          {sideAmount(record.closingNet, record.closingSide)}
        </span>
      ),
      sorter: (a, b) => Number(a.closingNet ?? 0) - Number(b.closingNet ?? 0),
    },
    {
      title: '下级科目',
      dataIndex: 'childCount',
      width: 90,
      align: 'right',
      sorter: (a, b) => Number(a.childCount ?? 0) - Number(b.childCount ?? 0),
    },
  ],
    [],
);


return (
  <DataBoundary
    loading={loading}
    error={error}
    empty={!loading && !error && generalRows.length === 0}
    emptyText={`期间 ${period} 无总账数据；总账按一级科目汇总，需先有已过账凭证`}
    onRetry={() => void reload()}
  >
    <p className="text-sm text-muted-foreground">
      点击任一科目行可下钻到该科目的明细账，再点凭证号进入凭证详情。
    </p>
    <div className="rounded-lg border bg-card">
      {/*
        §5.5（F4）：总账改 antd Table。
        · 下钻交互从 `<TableRow onClick>` 改为 `onRow` —— antd 的等价写法；
        · 合计行用 `summary` 而不是 `<TableFooter>`（antd 的原生聚合行入口）；
        · 期末余额列原先是「净额 + 方向」，保留同一渲染，只是移入 `render`。
      */}
      <Table<GeneralLedgerRow>
        columns={generalColumns}
        dataSource={generalRows}
        loading={loading}
        rowKey="accountCode"
        size="small"
        scroll={{ x: 1180 }}
        pagination={{
          pageSize: 100,
          showSizeChanger: true,
          pageSizeOptions: ['50', '100', '200', '500'],
          showTotal: (total: number) => `共 ${total} 个一级科目`,
        }}
        locale={{ emptyText: `期间 ${period} 无总账数据；总账按一级科目汇总，需先有已过账凭证` }}
        onRow={(row) => ({
          onClick: () => onDrillDown(row.accountCode),
          style: { cursor: 'pointer' },
        })}
        summary={() =>
          data?.totals ? (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={5}>
                合计
              </Table.Summary.Cell>
              <Table.Summary.Cell index={5} align="right">
                <span className="tabular-nums">
                  {amount(data.totals.debitOccur)}
                </span>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={6} align="right">
                <span className="tabular-nums">
                  {amount(data.totals.creditOccur)}
                </span>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={7} align="right">
                <span className="tabular-nums">
                  {sideAmount(
                    data.totals.closingDebit -
                      data.totals.closingCredit,
                    data.totals.closingDebit -
                      data.totals.closingCredit >=
                      0
                      ? 'debit'
                      : 'credit',
                  )}
                </span>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={8} />
            </Table.Summary.Row>
          ) : null
        }
      />
    </div>
  </DataBoundary>
  );
};

export default GeneralTab;
