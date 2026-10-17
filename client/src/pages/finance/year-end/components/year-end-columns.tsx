/**
 * 期末年结页两张表（待结转损益科目明细 / 年结状态）的列定义工厂。
 *
 * §5.9（F8）：从 `YearEndPage.tsx` 搬出。搬出的理由见 `AGENTS.md` 拆分判据 2 ——
 * 列定义「漏一列 / 列序错 / `dataIndex` 取错字段」在界面上**完全看不出来**
 * （表格照样渲染，只是数字落在错的列里），必须能单独读、单独核对契约字段。
 *
 * ⚠️ **搬迁时唯一的改动是「数组体整体左移 2 空格」**（原先嵌在 `useMemo` 里，
 * 现改为函数体的 `return [`）：列头文案、`width` / `fixed` / `align` / `filters`、
 * `dataIndex`、`render` / `sorter` / `onFilter` 全部逐字未动。
 *
 * ⚠️ **调用方必须把它放进 `useMemo`**（见 `CarryForwardPreviewSection` /
 * `YearEndStatusSection`），依赖与拆分前一致（结转明细为 `[]`，年结状态为
 * `[navigate, openReverse]`）。直接在渲染里调用工厂会让 antd 每次渲染拿到新的
 * 列数组 → 表头重建、排序/筛选状态被重置。
 */
import type { NavigateFunction } from 'react-router-dom';
import type { TableColumnsType } from 'antd';
import { RotateCcw } from 'lucide-react';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import { formatMoney } from '@client/src/utils/format';
import type {
  PeriodCarryForwardPreview,
  YearEndStatusItem,
} from '@shared/api.interface';

/** 损益结转明细行（取自 `PeriodCarryForwardPreview['items']`） */
export type YearEndCarryItem = PeriodCarryForwardPreview['items'][number];

interface YearEndStatusColumnsArgs {
  /** 行内跳转（父组件传入的就是 `useNavigate()`） */
  navigate: NavigateFunction;
  /** 打开「反年结」确认弹窗（父组件的 `useCallback`，**保持引用稳定**，
   *  否则本列定义每次渲染失效 → antd 表头重建） */
  openReverse: (fiscalYear: number) => void;
}

/** §5.5（F4）：年度结转明细列定义 */
export function buildCarryColumns(): TableColumnsType<YearEndCarryItem> {
  return [
    {
      title: '科目编码',
      dataIndex: 'accountCode',
      width: 140,
      fixed: 'left',
      render: (value: string) => <span className="tabular-nums">{value}</span>,
      sorter: (a, b) => a.accountCode.localeCompare(b.accountCode),
    },
    {
      title: '科目名称',
      dataIndex: 'accountName',
      width: 240,
      fixed: 'left',
      sorter: (a, b) => a.accountName.localeCompare(b.accountName, 'zh-Hans-CN'),
    },
    { title: '科目类型', dataIndex: 'accountType', width: 110 },
    {
      title: '方向',
      width: 90,
      align: 'center',
      // 该字段服务端未返回，原实现硬编码 '-'；保留同一语义而不是删列
      // （删列会改变表格宽度预期，且使用者已习惯看到这一列）
      render: () => '-',
    },
    ...[
      ['本期发生借', 'debitOccur'],
      ['本期发生贷', 'creditOccur'],
    ].map(([title, field]) => ({
      title,
      width: 140,
      align: 'right' as const,
      render: (_value: unknown, record: YearEndCarryItem) => (
        <span className="tabular-nums">
          {formatMoney(record[field as 'debitOccur' | 'creditOccur'])}
        </span>
      ),
      sorter: (a: YearEndCarryItem, b: YearEndCarryItem) =>
        Number(a[field as 'debitOccur' | 'creditOccur'] ?? 0) -
        Number(b[field as 'debitOccur' | 'creditOccur'] ?? 0),
    })),
    {
      title: '结转金额',
      dataIndex: 'carryAmount',
      width: 140,
      align: 'right',
      render: (value: number) => (
        <span className="tabular-nums">{formatMoney(value)}</span>
      ),
      sorter: (a, b) => Number(a.carryAmount ?? 0) - Number(b.carryAmount ?? 0),
    },
    {
      title: '结转方向',
      dataIndex: 'carryDirection',
      width: 110,
      filters: [
        { text: '借', value: 'debit' },
        { text: '贷', value: 'credit' },
      ],
      onFilter: (value, record) => record.carryDirection === value,
      render: (value: string) => (
        <Badge variant={value === 'debit' ? 'info' : 'warning'}>
          {value === 'debit' ? '借' : '贷'}
        </Badge>
      ),
    },
  ];
}

/** §5.5（F4）：年结记录列定义 */
export function buildStatusColumns({
  navigate,
  openReverse,
}: YearEndStatusColumnsArgs): TableColumnsType<YearEndStatusItem> {
  return [
    {
      title: '年度',
      dataIndex: 'fiscalYear',
      width: 100,
      fixed: 'left',
      render: (value: number) => <span className="tabular-nums">{value}</span>,
      sorter: (a, b) => Number(a.fiscalYear) - Number(b.fiscalYear),
    },
    {
      title: '期间',
      dataIndex: 'period',
      width: 110,
      render: (value: string) => <span className="tabular-nums">{value}</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      filters: [
        { text: '已年结', value: 'closed' },
        { text: '未年结', value: 'open' },
      ],
      onFilter: (value, record) => record.status === value,
      render: (value: string) => (
        <Badge variant={value === 'closed' ? 'success' : 'secondary'}>
          {value === 'closed' ? '已年结' : '未年结'}
        </Badge>
      ),
    },
    {
      title: '净利润',
      dataIndex: 'profitAmount',
      width: 140,
      align: 'right',
      render: (value: number) => (
        <span className="tabular-nums">{formatMoney(value)}</span>
      ),
      sorter: (a, b) => Number(a.profitAmount ?? 0) - Number(b.profitAmount ?? 0),
    },
    {
      title: '结转凭证号',
      dataIndex: 'carryVoucherCode',
      width: 170,
      render: (value: string | null, record: YearEndStatusItem) =>
        value ? (
          <Button
            variant="link"
            className="h-auto px-0"
            onClick={() => navigate(`/voucher/${record.carryVoucherId}`)}
          >
            {value}
          </Button>
        ) : (
          '-'
        ),
    },
    {
      title: '结账人 / 时间',
      width: 180,
      render: (_value, record) => (
        <span className="text-xs text-muted-foreground">
          {record.closedBy ?? '-'}
          <br />
          {record.closedAt
            ? new Date(record.closedAt).toLocaleString('zh-CN')
            : '-'}
        </span>
      ),
    },
    {
      title: '最近反结账',
      width: 200,
      render: (_value, record) => (
        <span className="text-xs text-muted-foreground">
          {record.reopenedAt
            ? `${record.reopenedBy ?? '-'} · ${new Date(record.reopenedAt).toLocaleString('zh-CN')}`
            : '-'}
        </span>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 140,
      fixed: 'right',
      render: (_value, record) =>
        record.status === 'closed' ? (
          <CanCapabilityWrite capability="finance_write">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                openReverse(record.fiscalYear)
              }
            >
              <RotateCcw className="size-3" />
              反年结
            </Button>
          </CanCapabilityWrite>
        ) : (
          <span className="text-xs text-muted-foreground">-</span>
        ),
    },
  ];
}
