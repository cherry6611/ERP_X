import React, { useState } from 'react';
import { toast } from 'sonner';
import { Calculator } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import { Button } from '@client/src/components/ui/button';
import { Badge } from '@client/src/components/ui/badge';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import { assetApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { currentPeriod, formatMoney } from '@client/src/utils/format';
import type { AssetDepreciationItem } from '@shared/api.interface';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const PAGE_SIZE = 20;

const AssetDepreciationPanel: React.FC = () => {
  const [page, setPage] = useState<number>(1);
  const [periodFilter, setPeriodFilter] = useState<string>('');
  const [depreciatePeriod, setDepreciatePeriod] = useState<string>(
    currentPeriod(),
  );
  const [operating, setOperating] = useState(false);

  const { data, loading, error, reload } = useAsyncData(
    () =>
      assetApi.listDepreciations({
        page,
        pageSize: PAGE_SIZE,
        period:
          periodFilter && PERIOD_PATTERN.test(periodFilter)
            ? periodFilter
            : undefined,
      }),
    [page, periodFilter],
  );

  const onDepreciate = async () => {
    if (!PERIOD_PATTERN.test(depreciatePeriod)) {
      toast.error('请输入正确的期间格式（YYYY-MM）');
      return;
    }
    setOperating(true);
    try {
      const result = await assetApi.depreciate({ period: depreciatePeriod });
      if (result.assetCount > 0) {
        toast.success(
          `${result.period} 已计提 ${result.assetCount} 项资产，合计 ${formatMoney(result.totalAmount)}`,
        );
      } else {
        toast.success(
          `${result.period} 无需计提的资产（已计提、净值不足或已报废）`,
        );
      }
      setPage(1);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '折旧计提失败');
    } finally {
      setOperating(false);
    }
  };

  const items: AssetDepreciationItem[] = data?.items ?? [];

  const columns: TableColumnsType<AssetDepreciationItem> = [
    { title: '资产编号', dataIndex: 'assetCode', fixed: 'left', width: 140 },
    { title: '资产名称', dataIndex: 'assetName', width: 180 },
    { title: '期间', dataIndex: 'period', width: 100 },
    {
      title: '折旧金额',
      dataIndex: 'amount',
      width: 120,
      render: (v: number) => (
        <span className="font-medium">{formatMoney(v)}</span>
      ),
    },
    {
      title: '成本联动',
      dataIndex: 'costGenerated',
      width: 110,
      render: (v: boolean) =>
        v ? (
          <Badge variant="default">已生成</Badge>
        ) : (
          <Badge variant="secondary">无</Badge>
        ),
    },
    {
      title: '备注',
      dataIndex: 'remark',
      width: 240,
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '计提时间',
      dataIndex: 'createdAt',
      width: 180,
      render: (v: string) =>
        v ? new Date(v).toLocaleString('zh-CN') : '-',
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Label htmlFor="asset-depreciation-period-filter">期间筛选</Label>
          <Input
            id="asset-depreciation-period-filter"
            aria-label="按期间筛选折旧记录，格式 YYYY-MM"
            placeholder="YYYY-MM"
            className="w-32"
            value={periodFilter}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              setPeriodFilter(e.target.value.trim());
              setPage(1);
            }}
          />
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="asset-depreciate-period">计提期间</Label>
          <Input
            id="asset-depreciate-period"
            aria-label="输入计提期间，格式 YYYY-MM"
            placeholder="YYYY-MM"
            className="w-32"
            value={depreciatePeriod}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setDepreciatePeriod(e.target.value.trim())
            }
          />
          <CanRole roles={['admin']}>
            <Button
              onClick={() => void onDepreciate()}
              disabled={operating}
              data-ai-section-type="button"
            >
              <Calculator className="mr-1 h-4 w-4" />
              按月计提折旧
            </Button>
          </CanRole>
        </div>
      </div>

      {error ? (
        <p className="text-sm text-destructive">
          {error}
          <Button
            variant="ghost"
            size="sm"
            className="ml-2"
            onClick={() => void reload()}
          >
            重试
          </Button>
        </p>
      ) : null}

      <Table
        columns={columns}
        dataSource={items}
        loading={loading}
        rowKey="id"
        scroll={{ x: 1100, y: 500 }}
        locale={{ emptyText: '暂无折旧记录，请在右上角按月计提折旧' }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: data?.total ?? 0,
          onChange: (p: number) => setPage(p),
        }}
      />
    </div>
  );
};

export default AssetDepreciationPanel;
