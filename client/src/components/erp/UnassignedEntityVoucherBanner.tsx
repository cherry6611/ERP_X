import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';
import { Button } from '@client/src/components/ui/button';
import { Table, type TableColumnsType } from 'antd';
import { checkUnassignedEntity } from '@client/src/api/voucher';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import { VOUCHER_SOURCE_LABELS } from '@client/src/pages/voucher/components/VoucherBadges';

/**
 * B-1 / REQ-BE-01：未归属纳税主体的凭证提示（账簿 / 报表页顶部）。
 *
 * 为什么必须挂在界面上：未归属主体的凭证 `fin_voucher.tax_entity_id IS NULL`，
 * **不会出现在任何主体的账簿与报表里**。此前只有数据库视图和集成测试能看到这件事，
 * 对使用者而言等同于「凭证静默消失」——总账少了 37 张凭证而界面上没有任何异样。
 *
 * 三条刻意选择：
 *  1. **加载失败不静默**：自检本身失败会渲染红色提示而不是隐藏（隐藏 = 又回到"看不到"）；
 *  2. **缺口为 0 时不渲染**：这是常态，不该常驻占位；
 *  3. **明细可下钻到凭证详情**：视图只给聚合数字，无法定位到具体凭证，故后端同时返回逐张明细。
 */
/** 明细行形状：与 `checkUnassignedEntity()` 返回的 `vouchers` 元素一致 */
type UnassignedVoucherRow = Awaited<
  ReturnType<typeof checkUnassignedEntity>
>['vouchers'][number];
const UnassignedEntityVoucherBanner: React.FC<{ period?: string }> = ({
  period,
}) => {
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(false);
  const { data, error } = useAsyncData(
    () => checkUnassignedEntity(period ? { period } : {}),
    [period ?? ''],
  );

  /*
   * §5.5（F4）：列定义。
   *
   * `useMemo` 稳定引用是必需的（antd 收到新 columns 会重建表头），
   * 依赖里列 `navigate` —— 它是 react-router 的稳定函数，但显式列出
   * 让 lint 能验证，也避免将来换成 unstable 版本时静默失效。
   */
  const bannerColumns = useMemo<TableColumnsType<UnassignedVoucherRow>>(
    () => [
      { title: '期间', dataIndex: 'period', width: 80 },
      { title: '凭证号', dataIndex: 'code', width: 150 },
      {
        title: '来源',
        dataIndex: 'sourceType',
        width: 120,
        render: (value: string) => VOUCHER_SOURCE_LABELS[value] ?? value,
        filters: [
          { text: '手工', value: 'manual' },
          { text: '系统生成', value: 'auto' },
        ],
        onFilter: (value, record) => record.sourceType === value,
      },
      {
        title: '摘要',
        dataIndex: 'summary',
        ellipsis: true,
        render: (value: string | null) => (
          <span className="text-muted-foreground">{value || '-'}</span>
        ),
      },
      {
        title: '借方合计',
        dataIndex: 'totalDebit',
        width: 130,
        align: 'right',
        render: (value: number) => (
          <span className="tabular-nums">{formatMoney(value)}</span>
        ),
        sorter: (a, b) => Number(a.totalDebit ?? 0) - Number(b.totalDebit ?? 0),
      },
      {
        title: '操作',
        key: 'action',
        width: 90,
        fixed: 'right',
        render: (_value, record) => (
          <Button
            variant="link"
            size="sm"
            onClick={() => navigate(`/voucher/${record.id}`)}
          >
            查看
          </Button>
        ),
      },
    ],
    [navigate],
  );
  if (error) {
    return (
      <div
        className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        role="alert"
      >
        凭证主体归属自检加载失败：{error}
      </div>
    );
  }

  if (!data || data.consistent) return null;

  const scope = data.period ? `${data.period} 期间` : '全部期间';

  return (
    <div
      className="rounded-md border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
      role="status"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>
            {scope}存在 <strong>{data.voucherCount}</strong> 张未归属纳税主体的凭证
            （借方合计 {formatMoney(data.totalDebit)}）。
            这些凭证<strong>不会出现在任何主体的账簿与报表中</strong>
            ，需补录主体或确认是否应归属默认主体。
          </span>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronUp className="h-4 w-4" />
          ) : (
            <ChevronDown className="h-4 w-4" />
          )}
          {expanded ? '收起明细' : '查看明细'}
        </Button>
      </div>

      {expanded ? (
        <div className="mt-3 rounded-md bg-background">
          {/*
            §5.5（F4）：明细表改 antd `<Table>`。
            原先用 shadcn `Table`：无分页、无排序、无 `ellipsis`、无空态钩子。
            这些凭证数量可能上百（视图按期间聚合），无分页会在这个**折叠面板内**
            撑出很长的滚动区，把下方的账簿主体推得很远。
          */}
          <Table<UnassignedVoucherRow>
            columns={bannerColumns}
            dataSource={data.vouchers}
            rowKey="id"
            size="small"
            scroll={{ x: 800 }}
            pagination={{
              pageSize: 20,
              showSizeChanger: false,
              showTotal: (total: number) => `共 ${total} 张`,
            }}
            locale={{ emptyText: '无线索明细' }}
          />
        </div>
      ) : null}
    </div>
  );
};

export default UnassignedEntityVoucherBanner;
