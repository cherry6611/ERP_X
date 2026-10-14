import React from 'react';
import {
  ArrowRight,
  CheckCircle2,
  CircleDollarSign,
  ClipboardList,
  PackageCheck,
  ReceiptText,
} from 'lucide-react';
import { DataState } from '@client/src/components/DataState';
import { Button } from '@client/src/components/ui/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@client/src/components/ui/card';
import { purApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import type { PurChainSummary } from '@shared/api.interface';

const PurChainPanel: React.FC = () => {
  const { data, loading, error, reload } = useAsyncData<PurChainSummary>(
    () => purApi.getChainSummary(),
    [],
  );

  const summary: PurChainSummary = data ?? {
    pendingRequestCount: 0,
    openOrderCount: 0,
    acceptedOrderCount: 0,
    openApAmount: 0,
    paidAmount: 0,
  };

  const stats = [
    {
      key: 'pendingRequestCount',
      label: '待审批申请',
      value: String(summary.pendingRequestCount),
      icon: <ClipboardList className="h-4 w-4 text-muted-foreground" />,
    },
    {
      key: 'openOrderCount',
      label: '待验收订单',
      value: String(summary.openOrderCount),
      icon: <ReceiptText className="h-4 w-4 text-muted-foreground" />,
    },
    {
      key: 'acceptedOrderCount',
      label: '已验收订单',
      value: String(summary.acceptedOrderCount),
      icon: <PackageCheck className="h-4 w-4 text-muted-foreground" />,
    },
    {
      key: 'openApAmount',
      label: '未付应付余额',
      value: formatMoney(summary.openApAmount),
      icon: <CircleDollarSign className="h-4 w-4 text-muted-foreground" />,
    },
    {
      key: 'paidAmount',
      label: '已付金额',
      value: formatMoney(summary.paidAmount),
      icon: <CheckCircle2 className="h-4 w-4 text-muted-foreground" />,
    },
  ];

  const chainSteps = [
    { key: 'request', label: '采购申请', detail: `${summary.pendingRequestCount} 条待审批` },
    { key: 'order', label: '采购订单', detail: `${summary.openOrderCount} 条待验收` },
    { key: 'accept', label: '订单验收', detail: `${summary.acceptedOrderCount} 条已验收` },
    { key: 'ap', label: '应付账款', detail: `未付 ${formatMoney(summary.openApAmount)}` },
    { key: 'pay', label: '付款核销', detail: `已付 ${formatMoney(summary.paidAmount)}` },
  ];

  return (
    <div className="flex flex-col gap-6">
      <DataState loading={loading} skeleton="card">
        <div
          className="grid grid-cols-5 gap-4"
          data-ai-section-type="card-stat"
        >
          {stats.map((item) => (
            <Card key={item.key}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-sm font-medium text-muted-foreground">
                  {item.label}
                  {item.icon}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-semibold">{item.value}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      </DataState>

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-semibold">采购全链路状态</CardTitle>
        </CardHeader>
        <CardContent>
          {error ? (
            <div className="flex items-center gap-2 text-sm text-destructive">
              <span>{error}</span>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() => void reload()}
              >
                重试
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {chainSteps.map((step, index) => (
                <React.Fragment key={step.key}>
                  <div className="flex min-w-40 flex-col gap-1 rounded-md border bg-card px-4 py-3">
                    <span className="text-sm font-medium">{step.label}</span>
                    <span className="text-sm text-muted-foreground">{step.detail}</span>
                  </div>
                  {index < chainSteps.length - 1 ? (
                    <ArrowRight className="h-4 w-4 text-muted-foreground" aria-label="流转至下一环节" />
                  ) : null}
                </React.Fragment>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default PurChainPanel;
