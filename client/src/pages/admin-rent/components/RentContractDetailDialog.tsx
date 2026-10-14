import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { formatMoney, formatNumber } from '@client/src/utils/format';
import RentStatusBadge from './RentStatusBadge';
import type {
  AdminPaymentCycle,
  AdminRentContractItem,
} from '@shared/api.interface';

const PAYMENT_CYCLE_LABELS: Record<AdminPaymentCycle, string> = {
  monthly: '月付',
  quarterly: '季付',
  half_yearly: '半年付',
  yearly: '年付',
};

interface RentContractDetailDialogProps {
  contract: AdminRentContractItem | null;
  onOpenChange: (open: boolean) => void;
}

const DetailRow: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div className="flex gap-2 text-sm">
    <span className="w-20 shrink-0 text-muted-foreground">{label}</span>
    <span className="min-w-0 flex-1 break-words">{children}</span>
  </div>
);

const RentContractDetailDialog: React.FC<RentContractDetailDialogProps> = ({
  contract,
  onOpenChange,
}) => (
  <Dialog open={contract !== null} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>
          {contract ? `${contract.name}（${contract.code}）` : ''}
        </DialogTitle>
      </DialogHeader>
      {contract ? (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2 rounded-md border p-3">
            <DetailRow label="状态">
              <RentStatusBadge status={contract.status} />
            </DetailRow>
            <DetailRow label="房产地址">{contract.propertyAddress}</DetailRow>
            <DetailRow label="出租方">{contract.lessor}</DetailRow>
            <DetailRow label="月租金">{formatMoney(contract.monthlyRent)}</DetailRow>
            <DetailRow label="押金">
              {contract.deposit == null ? '-' : formatMoney(contract.deposit)}
            </DetailRow>
            <DetailRow label="面积">
              {contract.area == null
                ? '-'
                : `${formatNumber(contract.area)} ㎡`}
            </DetailRow>
            <DetailRow label="租期">
              {contract.startDate} ~ {contract.endDate}
            </DetailRow>
            <DetailRow label="付款方式">
              {PAYMENT_CYCLE_LABELS[contract.paymentCycle] ?? contract.paymentCycle}
            </DetailRow>
            <DetailRow label="备注">{contract.remark ?? '-'}</DetailRow>
          </div>
          <div>
            <SectionTitle className="mb-2">附件</SectionTitle>
            <AttachmentField
              resourceType="admin_rent_contract"
              resourceId={contract.id}
              usageHint="租赁合同扫描件等"
            />
          </div>
        </div>
      ) : null}
    </DialogContent>
  </Dialog>
);

export default RentContractDetailDialog;
