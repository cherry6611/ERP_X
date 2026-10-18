import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { contractsApi } from '@client/src/api';
import { DataState } from '@client/src/components/DataState';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@client/src/components/ui/sheet';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { BILLING_MODEL_LABELS, CONTRACT_STATUS_LABELS } from '@client/src/utils/biz-labels';
import { formatMoney } from '@client/src/utils/format';
import { formatTaxSplitLine } from '@client/src/utils/tax-display';

interface ContractQuickViewDrawerProps {
  contractId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const Row: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <>
    <span className="text-muted-foreground">{label}</span>
    <span className="min-w-0 break-words">{children}</span>
  </>
);

/** 合同列表的快速查看抽屉；完整操作仍进入合同详情页。 */
const ContractQuickViewDrawer: React.FC<ContractQuickViewDrawerProps> = ({
  contractId,
  open,
  onOpenChange,
}) => {
  const navigate = useNavigate();
  const { data, loading, error } = useAsyncData(
    () => (contractId ? contractsApi.getContract(contractId) : Promise.resolve(null)),
    [contractId],
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[560px] gap-0 bg-card p-0 sm:max-w-[560px]"
      >
        <SheetHeader className="h-14 flex-row items-center border-b border-border/80 px-5 py-0">
          <SheetTitle className="text-[14px]">合同快速查看</SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-5">
          <DataState loading={loading} error={error} empty={!data && !loading}>
            {data ? (
              <div className="space-y-5">
                <div>
                  <p className="text-[11px] text-muted-foreground">{data.code}</p>
                  <h2 className="mt-1 text-[18px] font-semibold leading-6">
                    {data.name}
                  </h2>
                  <div className="mt-2">
                    <StatusBadge
                      status={data.status}
                      labels={CONTRACT_STATUS_LABELS}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-3 text-[12px]">
                  <Row label="客户">{data.customerName}</Row>
                  <Row label="计费模式">
                    <Badge variant="secondary">
                      {BILLING_MODEL_LABELS[data.billingModel] ?? data.billingModel}
                    </Badge>
                  </Row>
                  <Row label="合同金额">
                    <span className="tabular-nums">{formatMoney(data.amount)}</span>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {formatTaxSplitLine(data.amount, data.taxRate)}
                    </p>
                  </Row>
                  <Row label="税率">{data.taxRate}%</Row>
                  <Row label="负责人">{data.owner ?? '-'}</Row>
                  <Row label="签订日期">{data.signDate ?? '-'}</Row>
                  <Row label="履约周期">
                    {data.startDate ?? '-'} ~ {data.endDate ?? '-'}
                  </Row>
                  <Row label="付款条款">{data.paymentTerms ?? '-'}</Row>
                  <Row label="可开票金额">
                    <span className="tabular-nums">
                      {formatMoney(data.billable.billableAmount)}
                    </span>
                  </Row>
                </div>
              </div>
            ) : null}
          </DataState>
        </div>
        <div className="flex items-center justify-between border-t border-border/80 px-5 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button
            onClick={() => {
              if (contractId) navigate(`/contracts/${contractId}`);
            }}
          >
            <ExternalLink className="mr-1.5 size-4" />
            打开完整详情
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
};

export default ContractQuickViewDrawer;
