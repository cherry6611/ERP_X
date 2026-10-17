/**
 * 明细账 Tab
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
import { useNavigate } from 'react-router-dom';
import { Table, type TableColumnsType } from 'antd';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import { Button } from '@client/src/components/ui/button';
import { PAGE_SIZE, amount, sideAmount } from '../ledger-format';
import { DIRECTION_LABELS, voucherDate } from '../ledger-export-columns';
import { formatMoney } from '@client/src/utils/format';
import type {
  DetailLedgerResult,
  DetailLedgerLine,
} from '@shared/api.interface';

interface DetailTabProps {
  period: string;
  accountCode: string;
  page: number;
  data: DetailLedgerResult | null;
  loading: boolean;
  error: string | null;
  reload: () => void;
  onPageChange: (page: number) => void;
}

const DetailTab: React.FC<DetailTabProps> = ({
  period,
  accountCode,
  page,
  data,
  loading,
  error,
  reload,
  onPageChange,
}) => {
/*
   * 明细账当前页行。`useMemo` 是必需的：新数组会重置 antd Table 的分页状态。
   */
  const detailRows = useMemo(() => data?.items ?? [], [data]);

  const navigate = useNavigate();

  const detailColumns = useMemo<TableColumnsType<DetailLedgerLine>>(
  () => [
    {
      title: '日期',
      dataIndex: 'voucherDate',
      width: 110,
      render: (value: string | null) => (
        <span className="tabular-nums">{voucherDate(value)}</span>
      ),
    },
    {
      title: '凭证号',
      dataIndex: 'voucherCode',
      width: 150,
      render: (value: string, record: DetailLedgerLine) => (
        /*
         * 用项目自己的 shadcn `<Button variant="link">` 而不是 antd `Button`：
         * 本页此前只 import 了 antd 的 `Table`，混用两套 Button 会让
         * 同一行里出现两种 focus ring / hover 表现。`variant="link"` 是本仓
         * 既有的链接样式按钮写法（多处使用）。
         */
        <Button
          variant="link"
          className="h-auto px-0"
          onClick={() => navigate(`/voucher/${record.voucherId}`)}
        >
          {value}
        </Button>
      ),
    },
    {
      title: '摘要',
      dataIndex: 'summary',
      width: 260,
      ellipsis: true,
      render: (value: string | null) => value ?? '-',
    },
    {
      title: '对方科目',
      dataIndex: 'counterpartAccounts',
      width: 220,
      ellipsis: true,
      render: (value: string[]) =>
        value.length > 0 ? value.join('、') : '-',
    },
    ...[
      ['借方', 'debit'],
      ['贷方', 'credit'],
    ].map(([title, field]) => ({
      title,
      width: 130,
      align: 'right' as const,
      render: (_value: unknown, record: DetailLedgerLine) => (
        <span className="tabular-nums">
          {amount(record[field as 'debit' | 'credit'])}
        </span>
      ),
    })),
    {
      title: '余额',
      width: 150,
      align: 'right',
      render: (_value, record: DetailLedgerLine) => (
        <span className="tabular-nums">
          {sideAmount(record.balance, record.balanceSide)}
        </span>
      ),
    },
    {
      title: '方向',
      dataIndex: 'balanceSide',
      width: 70,
      render: (value: string) => DIRECTION_LABELS[value] ?? value,
    },
    {
      title: '辅助核算',
      dataIndex: 'aux',
      width: 180,
      ellipsis: true,
      render: (value: DetailLedgerLine['aux']) =>
        value.length > 0
          ? value
              .map((item) => `${item.dimensionCode}:${item.dimensionValue ?? '-'}`)
              .join('；')
          : '-',
    },
  ],
    [navigate],
);

if (!accountCode) {
    return (
      <div className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
        请先在「总账」中点击科目行选择科目，或在上方筛选区输入科目编码后查询。
      </div>
    );
  }
  return (
    <DataBoundary
      loading={loading}
      error={error}
      empty={!loading && !error && detailRows.length === 0}
      emptyText={`科目 ${accountCode} 在期间 ${period} 无明细发生额`}
      onRetry={() => void reload()}
    >
      {data ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div className="rounded-lg border bg-card p-3">
            <p className="text-xs text-muted-foreground">科目</p>
            <p className="text-sm font-medium">
              {data.accountCode} {data.accountName}
            </p>
          </div>
          <div className="rounded-lg border bg-card p-3">
            <p className="text-xs text-muted-foreground">期初余额</p>
            <p className="text-sm font-medium tabular-nums">
              {sideAmount(
                data.openingBalance,
                data.openingBalance >= 0 ? 'debit' : 'credit',
              )}
            </p>
          </div>
          <div className="rounded-lg border bg-card p-3">
            <p className="text-xs text-muted-foreground">本期借贷发生</p>
            <p className="text-sm font-medium tabular-nums">
              {formatMoney(data.periodDebit)} / {formatMoney(data.periodCredit)}
            </p>
          </div>
          <div className="rounded-lg border bg-card p-3">
            <p className="text-xs text-muted-foreground">期末余额</p>
            <p className="text-sm font-medium tabular-nums">
              {sideAmount(
                data.closingBalance,
                data.closingBalance >= 0 ? 'debit' : 'credit',
              )}
            </p>
          </div>
        </div>
      ) : null}
      <div className="rounded-lg border bg-card">
        {/*
          §5.5（F4）：明细账改 antd Table。
          · 分页由 antd 原生承担（`total` + `current` + `onChange`），
            因此**移除了原来手写的 `<Pagination>`**（在下方）——
            两套分页控件并存会让使用者不知道该点哪个；
          · 交互从手写 `<button>` 改为 `render` 里的 `Button type="link"`，
            保留"点凭证号进凭证详情"的行为。
        */}
        <Table<DetailLedgerLine>
          columns={detailColumns}
          dataSource={detailRows}
          loading={loading}
          rowKey="lineId"
          size="small"
          scroll={{ x: 1400 }}
          pagination={{
            current: page,
            pageSize: data?.pageSize || PAGE_SIZE,
            total: data?.total ?? 0,
            showSizeChanger: false,
            showTotal: (total: number) => `共 ${total} 条`,
            onChange: (next: number) => onPageChange(next),
          }}
          locale={{ emptyText: '该科目在本期间无发生额' }}
          summary={() =>
            data ? (
              <Table.Summary.Row>
                <Table.Summary.Cell index={0} colSpan={4}>
                  本页合计（共 {data.total} 条）
                </Table.Summary.Cell>
                <Table.Summary.Cell index={4} align="right">
                  <span className="tabular-nums">{amount(data.pageDebit)}</span>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={5} align="right">
                  <span className="tabular-nums">{amount(data.pageCredit)}</span>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={6} align="right">
                  <span className="tabular-nums">
                    {sideAmount(
                      data.closingBalance,
                      data.closingBalance >= 0 ? 'debit' : 'credit',
                    )}
                  </span>
                </Table.Summary.Cell>
                <Table.Summary.Cell index={7} colSpan={2}>
                  期末余额
                </Table.Summary.Cell>
              </Table.Summary.Row>
            ) : null
          }
        />
      </div>
    </DataBoundary>
  );
};

export default DetailTab;
