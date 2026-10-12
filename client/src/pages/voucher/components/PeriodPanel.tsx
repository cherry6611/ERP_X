import React, { useState } from 'react';
import { toast } from 'sonner';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { voucherApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import type { PeriodStatus } from '@shared/api.interface';

const PAGE_SIZE = 20;

const getCloseDisabledReason = (p: PeriodStatus): string | null => {
  if (p.closed) return null;
  if (!p.balanced && p.draftCount > 0) {
    return `借贷不平衡且存在 ${p.draftCount} 张草稿凭证`;
  }
  if (!p.balanced) return '借贷不平衡';
  if (p.draftCount > 0) return `存在 ${p.draftCount} 张草稿凭证`;
  return null;
};

const PeriodPanel: React.FC = () => {
  const [closeTarget, setCloseTarget] = useState<PeriodStatus | null>(null);
  const [operating, setOperating] = useState(false);

  const { data, loading, error, reload } = useAsyncData<PeriodStatus[]>(
    () => voucherApi.listPeriods(),
    [],
  );

  const onConfirmClose = async () => {
    if (!closeTarget) return;
    setOperating(true);
    try {
      await voucherApi.closePeriod(closeTarget.period);
      toast.success(`期间 ${closeTarget.period} 已结账`);
      setCloseTarget(null);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '结账失败');
    } finally {
      setOperating(false);
    }
  };

  const columns: TableColumnsType<PeriodStatus> = [
    { title: '期间', dataIndex: 'period', fixed: 'left', width: 120 },
    { title: '凭证数', dataIndex: 'voucherCount', width: 100 },
    { title: '草稿数', dataIndex: 'draftCount', width: 100 },
    {
      title: '借方合计',
      dataIndex: 'totalDebit',
      width: 140,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '贷方合计',
      dataIndex: 'totalCredit',
      width: 140,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '试算平衡',
      dataIndex: 'balanced',
      width: 110,
      render: (v: boolean) =>
        v ? <Badge variant="default">平衡</Badge> : <Badge variant="destructive">不平衡</Badge>,
    },
    {
      title: '结账状态',
      dataIndex: 'closed',
      width: 110,
      render: (v: boolean) =>
        v ? <Badge variant="secondary">已结账</Badge> : <Badge variant="outline">未结账</Badge>,
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 260,
      render: (_: unknown, record: PeriodStatus) => {
        if (record.closed) return <span className="text-sm text-muted-foreground">—</span>;
        const reason = getCloseDisabledReason(record);
        return (
          <div className="flex items-center gap-2">
            {reason ? (
              <span className="text-xs text-muted-foreground">{reason}，无法结账</span>
            ) : null}
            <CanRole roles={['admin']}>
              <Button
                size="sm"
                variant="outline"
                disabled={reason !== null || operating}
                onClick={() => setCloseTarget(record)}
              >
                结账
              </Button>
            </CanRole>
          </div>
        );
      },
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {error ? (
        <p className="text-sm text-destructive">
          {error}
          <Button variant="ghost" size="sm" className="ml-2" onClick={() => void reload()}>
            重试
          </Button>
        </p>
      ) : null}
      <Table
        columns={columns}
        dataSource={data ?? []}
        loading={loading}
        rowKey="period"
        scroll={{ x: 1000, y: 480 }}
        pagination={{ pageSize: PAGE_SIZE }}
        locale={{ emptyText: '暂无期间数据，凭证生成后将自动汇总各期试算状态' }}
      />

      <Dialog
        open={closeTarget !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setCloseTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>确认结账</DialogTitle>
            {closeTarget ? (
              <DialogDescription>
                期间 {closeTarget.period}：凭证 {closeTarget.voucherCount} 张，借方合计{' '}
                {formatMoney(closeTarget.totalDebit)}，贷方合计{' '}
                {formatMoney(closeTarget.totalCredit)}。结账后该期间账簿将锁定，确认继续吗？
              </DialogDescription>
            ) : null}
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCloseTarget(null)} disabled={operating}>
              取消
            </Button>
            <Button disabled={operating} onClick={() => void onConfirmClose()}>
              确认结账
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default PeriodPanel;
