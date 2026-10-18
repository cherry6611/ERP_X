import React from 'react';
import { useNavigate } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { Button } from '@client/src/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@client/src/components/ui/sheet';
import { formatMoney } from '@client/src/utils/format';
import {
  DIRECTION_LABELS,
  INVOICE_STATUS_LABELS,
  INVOICE_TYPE_LABELS,
} from '../invoice-schemas';
import type { InvoiceItem } from '@shared/api.interface';

interface InvoiceQuickViewDrawerProps {
  invoice: InvoiceItem | null;
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

/** 发票列表快速查看；开票、作废等写操作仍在完整详情/行内动作。 */
const InvoiceQuickViewDrawer: React.FC<InvoiceQuickViewDrawerProps> = ({
  invoice,
  onOpenChange,
}) => {
  const navigate = useNavigate();

  return (
    <Sheet open={invoice !== null} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[560px] gap-0 bg-card p-0 sm:max-w-[560px]"
      >
        <SheetHeader className="h-14 flex-row items-center border-b border-border/80 px-5 py-0">
          <SheetTitle className="text-[14px]">发票快速查看</SheetTitle>
        </SheetHeader>
        {invoice ? (
          <div className="flex-1 space-y-5 overflow-y-auto p-5">
            <div>
              <p className="text-[11px] text-muted-foreground">{invoice.code}</p>
              <h2 className="mt-1 text-[18px] font-semibold leading-6">
                {invoice.invoiceNo ?? '未填写发票号'}
              </h2>
              <div className="mt-2 flex items-center gap-2">
                <StatusBadge
                  status={invoice.status}
                  labels={INVOICE_STATUS_LABELS}
                />
                <span className="text-[11px] text-muted-foreground">
                  {DIRECTION_LABELS[invoice.direction]} ·{' '}
                  {INVOICE_TYPE_LABELS[invoice.invoiceType] ?? invoice.invoiceType}
                </span>
              </div>
            </div>
            <div className="grid grid-cols-[88px_1fr] gap-x-3 gap-y-3 text-[12px]">
              <Row label="客户/供应商">
                {invoice.customerName || invoice.supplierName || '-'}
              </Row>
              <Row label="关联合同">{invoice.contractName || '-'}</Row>
              <Row label="关联项目">{invoice.projectName || '-'}</Row>
              <Row label="金额">
                <span className="tabular-nums">{formatMoney(invoice.amount)}</span>
              </Row>
              <Row label="税率">{invoice.taxRate}%</Row>
              <Row label="税额">
                <span className="tabular-nums">{formatMoney(invoice.taxAmount)}</span>
              </Row>
              <Row label="开票日期">{invoice.invoiceDate ?? '-'}</Row>
              <Row label="关联应收">{invoice.arCode ?? '-'}</Row>
              <Row label="查验状态">
                {invoice.verifyStatus === 'verified'
                  ? '已查验'
                  : invoice.verifyStatus === 'failed'
                    ? '查验失败'
                    : '未查验'}
              </Row>
              <Row label="认证状态">
                {invoice.certificationPeriod
                  ? `${invoice.certificationPeriod}`
                  : '未认证'}
              </Row>
            </div>
          </div>
        ) : null}
        <div className="flex items-center justify-between border-t border-border/80 px-5 py-3">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          <Button
            onClick={() => {
              if (invoice) navigate(`/finance/invoices/${invoice.id}`);
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

export default InvoiceQuickViewDrawer;
