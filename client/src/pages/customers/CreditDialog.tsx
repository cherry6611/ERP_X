import React from 'react';
import { DataState } from '@client/src/components/DataState';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { Badge } from '@client/src/components/ui/badge';
import { masterDataApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import type { Customer } from '@shared/api.interface';

interface CreditDialogProps {
  customer: Customer | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const CreditDialog: React.FC<CreditDialogProps> = ({ customer, open, onOpenChange }) => {
  const { data, loading, error } = useAsyncData(
    () => (customer ? masterDataApi.getCredit(customer.id) : Promise.resolve(null)),
    [customer?.id],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>客户信用 - {customer?.name}</DialogTitle>
        </DialogHeader>
        <DataState loading={loading} error={error}>
          {data ? (
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">信用额度</span>
                <span>{formatMoney(data.creditLimit)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">账期内应收占用</span>
                <span>{formatMoney(data.openArAmount)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">逾期金额</span>
                <span className={data.overdueAmount > 0 ? 'text-destructive' : ''}>
                  {formatMoney(data.overdueAmount)}
                </span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">额度状态</span>
                {data.exceedLimit ? (
                  <Badge variant="destructive">已超额度</Badge>
                ) : (
                  <Badge variant="default">额度内</Badge>
                )}
              </div>
              <div className="flex justify-between items-center">
                <span className="text-muted-foreground">逾期状态</span>
                {data.hasOverdue ? (
                  <Badge variant="destructive">存在逾期</Badge>
                ) : (
                  <Badge variant="default">无逾期</Badge>
                )}
              </div>
            </div>
          ) : null}
        </DataState>
      </DialogContent>
    </Dialog>
  );
};

export default CreditDialog;
