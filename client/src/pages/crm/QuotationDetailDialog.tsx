import React, { useMemo } from 'react';
import { toast } from 'sonner';
import { CanCapability } from '@client/src/platform/auth';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { Button } from '@client/src/components/ui/button';
import { crmApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { QUOTATION_STATUS_LABELS } from '@client/src/utils/biz-labels';
import { formatMoney, formatPercent } from '@client/src/utils/format';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import type { Opportunity, Quotation, QuotationItem } from '@shared/api.interface';

interface QuotationDetailDialogProps {
  quotation: Quotation | null;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}

type QuotationAction = 'submit' | 'approve' | 'reject' | 'void' | 'convert';

const QuotationDetailDialog: React.FC<QuotationDetailDialogProps> = ({
  quotation,
  onOpenChange,
  onChanged,
}) => {
  const { data: opportunities } = useAsyncData<Opportunity[]>(
    () => crmApi.listOpportunities(),
    [],
  );

  const oppTitleMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const opp of opportunities ?? []) {
      map.set(opp.id, opp.title);
    }
    return map;
  }, [opportunities]);

  const runAction = async (action: QuotationAction) => {
    if (!quotation) return;
    if (action === 'void') {
      const ok = await confirmDanger(
        `确认作废报价单 ${quotation.code}？此操作不可恢复。`,
        { title: '确认作废' },
      );
      if (!ok) return;
    }
    try {
      if (action === 'convert') {
        const contract = await crmApi.convertQuotation(quotation.id);
        toast.success(`已生成合同草稿 ${contract.code}`);
      } else if (action === 'submit') {
        await crmApi.submitQuotation(quotation.id);
        toast.success('报价单已提交审批');
      } else if (action === 'approve') {
        await crmApi.approveQuotation(quotation.id);
        toast.success('报价单已通过');
      } else if (action === 'reject') {
        await crmApi.rejectQuotation(quotation.id);
        toast.success('报价单已驳回');
      } else {
        await crmApi.voidQuotation(quotation.id);
        toast.success('报价单已作废');
      }
      onOpenChange(false);
      onChanged();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '操作失败'));
    }
  };

  return (
    <Dialog
      open={quotation !== null}
      onOpenChange={(open: boolean) => {
        if (!open) onOpenChange(false);
      }}
    >
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        {quotation ? (
          <>
            <DialogHeader>
              <DialogTitle>报价单详情 - {quotation.code}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div>
              <span className="text-muted-foreground">客户：</span>
              {quotation.customerName}
            </div>
            <div>
              <span className="text-muted-foreground">状态：</span>
              <StatusBadge
                status={quotation.status}
                labels={QUOTATION_STATUS_LABELS}
              />
            </div>
            <div>
              <span className="text-muted-foreground">标题：</span>
              {quotation.title}
            </div>
            <div>
              <span className="text-muted-foreground">关联商机：</span>
              {quotation.opportunityId
                ? (oppTitleMap.get(quotation.opportunityId) ?? '-')
                : '-'}
            </div>
            <div>
              <span className="text-muted-foreground">报价日期：</span>
              {quotation.quoteDate ?? '-'}
            </div>
            <div>
              <span className="text-muted-foreground">有效期至：</span>
              {quotation.validUntil ?? '-'}
            </div>
            <div>
              <span className="text-muted-foreground">整单折扣：</span>
              {formatPercent(quotation.discountPct)}
            </div>
            <div>
              <span className="text-muted-foreground">报价总额：</span>
              {formatMoney(quotation.totalAmount)}
            </div>
            <div>
              <span className="text-muted-foreground">预估成本：</span>
              {formatMoney(quotation.estimatedCost)}
            </div>
            <div>
              <span className="text-muted-foreground">毛利率：</span>
              <span
                className={quotation.marginPct < 20 ? 'text-destructive' : ''}
              >
                {formatPercent(quotation.marginPct)}
              </span>
            </div>
            <div className="col-span-2">
              <span className="text-muted-foreground">备注：</span>
              {quotation.remark ?? '-'}
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1 pr-2 font-medium">服务项</th>
                  <th className="py-1 pr-2 font-medium">数量单位</th>
                  <th className="py-1 pr-2 font-medium">单价</th>
                  <th className="py-1 pr-2 font-medium">行折扣</th>
                  <th className="py-1 pr-2 font-medium">行金额</th>
                  <th className="py-1 font-medium">预估单位成本</th>
                </tr>
              </thead>
              <tbody>
                {[...quotation.items]
                  .sort((a: QuotationItem, b: QuotationItem) => a.seq - b.seq)
                  .map((item: QuotationItem) => (
                    <tr key={item.id} className="border-b">
                      <td className="py-1 pr-2">{item.itemName}</td>
                      <td className="py-1 pr-2">
                        {item.quantity} {item.unit}
                      </td>
                      <td className="py-1 pr-2">{formatMoney(item.unitPrice)}</td>
                      <td className="py-1 pr-2">{formatPercent(item.discountPct)}</td>
                      <td className="py-1 pr-2">{formatMoney(item.lineAmount)}</td>
                      <td className="py-1">{formatMoney(item.estUnitCost)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

            <div className="border-t pt-4">
            <AttachmentField
              resourceType="crm_quotation"
              resourceId={quotation.id}
              usageHint="报价方案书、比价云文档链接"
            />
          </div>
        </div>
        <DialogFooter>
          <CanCapability capability="crm_write">
            {quotation.status === 'draft' ? (
              <>
                <Button onClick={() => void runAction('submit')}>提交审批</Button>
                <Button variant="outline" onClick={() => void runAction('void')}>
                  作废
                </Button>
              </>
            ) : null}
            {quotation.status === 'pending_approval' ? (
              <>
                <Button onClick={() => void runAction('approve')}>通过</Button>
                <Button variant="outline" onClick={() => void runAction('reject')}>
                  驳回
                </Button>
              </>
            ) : null}
            {quotation.status === 'approved' ? (
              <>
                <Button onClick={() => void runAction('convert')}>转合同</Button>
                <Button variant="outline" onClick={() => void runAction('void')}>
                  作废
                </Button>
              </>
            ) : null}
          </CanCapability>
        </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};

export default QuotationDetailDialog;
