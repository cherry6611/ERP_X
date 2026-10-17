/**
 * 辅助余额表 Tab
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
import { sideAmount } from '../ledger-format';
import { formatMoney } from '@client/src/utils/format';
import type {
  AuxBalanceSheet,
  AuxBalanceRow,
} from '@shared/api.interface';

interface AuxTabProps {
  period: string;
  dimension: string;
  data: AuxBalanceSheet | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

const AuxTab: React.FC<AuxTabProps> = ({
  period,
  dimension,
  data,
  loading,
  error,
  reload,
}) => {
const auxRows = useMemo(() => data?.items ?? [], [data]);

  const auxColumns = useMemo<TableColumnsType<AuxBalanceRow>>(
  () => [
    {
      title: '维度值',
      dataIndex: 'dimensionValue',
      width: 160,
      render: (value: string | null) => value ?? '(未指定)',
      sorter: (a, b) =>
        (a.dimensionValue ?? '').localeCompare(b.dimensionValue ?? '', 'zh-Hans-CN'),
    },
    {
      title: '科目编码',
      dataIndex: 'accountCode',
      width: 140,
      render: (value: string) => <span className="tabular-nums">{value}</span>,
      sorter: (a, b) => a.accountCode.localeCompare(b.accountCode),
    },
    {
      title: '科目名称',
      dataIndex: 'accountName',
      width: 220,
      sorter: (a, b) => a.accountName.localeCompare(b.accountName, 'zh-Hans-CN'),
    },
    ...[
      ['期初余额', 'openingDebit'],
      ['本期发生', 'debitOccur'],
    ].map(([title, field]) => ({
      title,
      width: 160,
      align: 'right' as const,
      render: (_value: unknown, record: AuxBalanceRow) => {
        if (field === 'debitOccur') {
          return (
            <span className="tabular-nums">
              {formatMoney(record.debitOccur)} / {formatMoney(record.creditOccur)}
            </span>
          );
        }
        return (
          <span className="tabular-nums">
            {sideAmount(
              record.openingDebit - record.openingCredit,
              record.openingDebit - record.openingCredit >= 0 ? 'debit' : 'credit',
            )}
          </span>
        );
      },
    })),
    {
      title: '期末余额',
      width: 160,
      align: 'right',
      render: (_value, record: AuxBalanceRow) => (
        <span className="tabular-nums">
          {sideAmount(record.closingNet, record.closingSide)}
        </span>
      ),
    },
  ],
    [],
);

if (!dimension) {
    return (
      <div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
        请先选择辅助核算维度（来自 /api/finance/ledgers/aux-dimensions 的启用维度）。
      </div>
    );
  }
  return (
    <DataBoundary
      loading={loading}
      error={error}
      empty={!loading && !error && auxRows.length === 0}
      emptyText={`维度「${data?.dimensionName ?? dimension}」在期间 ${period} 无发生额`}
      onRetry={() => void reload()}
    >
      {data && !data.balanced ? (
        <p
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-2 text-sm text-destructive"
        >
          辅助余额表借贷不平衡，请检查辅助核算凭证
        </p>
      ) : null}
      <div className="rounded-lg border bg-card">
        {/*
          §5.5（F4）：辅助余额表改 antd Table，与余额表/总账/明细账同轨。
          合计行同样用 `Table.Summary`（antd 的原生聚合行入口）。
        */}
        <Table<AuxBalanceRow>
          columns={auxColumns}
          dataSource={auxRows}
          loading={loading}
          rowKey={(row) => `${row.dimensionId ?? 'null'}-${row.accountCode}`}
          size="small"
          scroll={{ x: 900 }}
          pagination={{
            pageSize: 100,
            showSizeChanger: true,
            pageSizeOptions: ['50', '100', '200', '500'],
            showTotal: (total: number) => `共 ${total} 行`,
          }}
          locale={{
            emptyText: `维度「${data?.dimensionName ?? dimension}」在期间 ${period} 无发生额`,
          }}
          summary={() =>
            data ? (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={3}>
                  合计
                </Table.Summary.Cell>
                <Table.Summary.Cell index={3} align="right">
                  <span className="tabular-nums">
                    {sideAmount(
                      data.totals.closingDebit - data.totals.closingCredit,
                      data.totals.closingDebit - data.totals.closingCredit >= 0
                        ? 'debit'
                        : 'credit',
                    )}
                  </span>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={4} align="right">
                  <span className="tabular-nums">
                    {formatMoney(data.totals.debitOccur)} /{' '}
                    {formatMoney(data.totals.creditOccur)}
                  </span>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={5} align="right">
                  <span className="tabular-nums">
                    {sideAmount(
                      data.totals.closingDebit - data.totals.closingCredit,
                      data.totals.closingDebit - data.totals.closingCredit >= 0
                        ? 'debit'
                        : 'credit',
                    )}
                  </span>
                </Table.Summary.Cell>
              </Table.Summary.Row>
            ) : null
          }
        />
      </div>
    </DataBoundary>
  );
};

export default AuxTab;
