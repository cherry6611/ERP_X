import React, { useCallback } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import { DataState } from '@client/src/components/DataState';
import PageShell from '@client/src/components/PageShell';
import { usePageEntityName } from '@client/src/components/page-meta';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { Button } from '@client/src/components/ui/button';
import { Card, CardContent, CardHeader } from '@client/src/components/ui/card';
import { PrintButton } from '@client/src/components/print';
import type { PrintPackSeed } from '@client/src/components/print';
import { cellText, compactFields, metaField } from '@client/src/components/print';
import { crmApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { QUOTATION_STATUS_LABELS } from '@client/src/utils/biz-labels';
import { formatMoney, formatPercent } from '@client/src/utils/format';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import type { BrandConfig, Quotation, QuotationItem } from '@shared/api.interface';

type QuotationAction = 'submit' | 'approve' | 'reject' | 'void' | 'convert' | 'setWon';

const QuotationDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, loading, error, reload } = useAsyncData<Quotation>(
    () => crmApi.getQuotation(id ?? ''),
    [id],
  );

  usePageEntityName(data ? `${data.code} ${data.title}` : null);

  /** C-06：报价单打印件组包 */
  const buildPrintPackSeed = useCallback(
    (_brand: BrandConfig | null): PrintPackSeed | null => {
      if (!data) return null;
      return {
        kind: 'quotation',
        code: data.code,
        title: '报价单',
        subtitle: `报价单编号：${data.code}`,
        meta: compactFields([
          metaField('客户', data.customerName),
          metaField('报价标题', data.title),
          metaField('关联商机', data.opportunityTitle),
          metaField('报价日期', data.quoteDate),
          metaField('有效期至', data.validUntil),
          metaField('整单折扣', formatPercent(data.discountPct)),
          metaField(
            '状态',
            QUOTATION_STATUS_LABELS[data.status] ?? data.status,
          ),
          metaField('轮次', data.roundNo ? `第 ${data.roundNo} 轮` : null),
        ]),
        tableTitle: '报价明细',
        columns: [
          { key: 'seq', label: '序号', widthMm: 12, align: 'center' },
          { key: 'itemName', label: '服务项' },
          { key: 'unit', label: '单位', widthMm: 16, align: 'center' },
          { key: 'quantity', label: '数量', widthMm: 18, align: 'right' },
          { key: 'unitPrice', label: '单价', widthMm: 24, align: 'right' },
          { key: 'discountPct', label: '行折扣', widthMm: 18, align: 'right' },
          { key: 'lineAmount', label: '行金额', widthMm: 26, align: 'right' },
        ],
        rows: [...data.items]
          .sort((a: QuotationItem, b: QuotationItem) => a.seq - b.seq)
          .map((item) => ({
            cells: {
              seq: String(item.seq),
              itemName: item.itemName,
              unit: item.unit,
              quantity: cellText(item.quantity),
              unitPrice: cellText(item.unitPrice),
              discountPct: formatPercent(item.discountPct),
              lineAmount: cellText(item.lineAmount),
            },
          })),
        totals: [
          { label: '报价总额', amount: data.totalAmount, inWords: true, emphasize: true },
          // 成本与毛利属内部数据，标出来避免误发给客户
          { label: '预估成本（内部）', amount: data.estimatedCost },
        ],
        clauses: [
          data.validUntil ? `报价有效期至 ${data.validUntil}，逾期请重新询价。` : '',
          data.remark ? `备注：${data.remark}` : '',
        ].filter(Boolean),
        sourceNote: '数据来源：CRM 报价单模块；标注「内部」的行请勿对外提供',
      };
    },
    [data],
  );

  const backTo = data?.opportunityId
    ? `/crm/opportunities/${data.opportunityId}`
    : '/crm?tab=opportunities';

  const runAction = async (action: QuotationAction) => {
    if (!data) return;
    if (action === 'void') {
      const ok = await confirmDanger(
        `确认作废报价单 ${data.code}？此操作不可恢复。`,
        { title: '确认作废' },
      );
      if (!ok) return;
    }
    try {
      if (action === 'setWon') {
        if (!data.opportunityId) {
          toast.error('该报价未关联商机，无法设为成交');
          return;
        }
        await crmApi.updateOpportunity(data.opportunityId, {
          wonQuotationId: data.id,
        });
        toast.success('已设为最终成交报价');
      } else if (action === 'convert') {
        const contract = await crmApi.convertQuotation(data.id);
        toast.success(`已生成合同草稿 ${contract.code}`);
      } else if (action === 'submit') {
        await crmApi.submitQuotation(data.id);
        toast.success('报价单已提交审批');
      } else if (action === 'approve') {
        await crmApi.approveQuotation(data.id);
        toast.success('报价单已通过');
      } else if (action === 'reject') {
        await crmApi.rejectQuotation(data.id);
        toast.success('报价单已驳回');
      } else {
        await crmApi.voidQuotation(data.id);
        toast.success('报价单已作废');
      }
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '操作失败'));
    }
  };

  return (
    <PageShell
      title={data ? `报价单 · ${data.code}` : '报价单详情'}
      description={data?.title}
      actions={
        <>
          <PrintButton build={buildPrintPackSeed} disabled={!data} label="打印报价单" />
          <Button variant="outline" onClick={() => navigate(backTo)}>
            <ArrowLeft className="h-4 w-4" />
            返回商机
          </Button>
        </>
      }
    >
      <DataState loading={loading} error={error} onRetry={() => void reload()}>
        {data ? (
          <div className="mx-auto max-w-4xl space-y-6">
            <Card>
              <CardHeader>
                <SectionTitle
                  description={data.isWon ? '当前为最终成交报价' : data.title}
                >
                  {`${data.code}${data.roundNo ? ` · 第 ${data.roundNo} 轮` : ''}`}
                </SectionTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">客户：</span>
                    {data.customerName}
                  </div>
                  <div>
                    <span className="text-muted-foreground">状态：</span>
                    <StatusBadge
                      status={data.status}
                      labels={QUOTATION_STATUS_LABELS}
                    />
                  </div>
                  <div>
                    <span className="text-muted-foreground">标题：</span>
                    {data.title}
                  </div>
                  <div>
                    <span className="text-muted-foreground">关联商机：</span>
                    {data.opportunityId ? (
                      <Link
                        to={`/crm/opportunities/${data.opportunityId}`}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        {data.opportunityTitle ?? data.opportunityId}
                      </Link>
                    ) : (
                      '-'
                    )}
                  </div>
                  <div>
                    <span className="text-muted-foreground">报价日期：</span>
                    {data.quoteDate ?? '-'}
                  </div>
                  <div>
                    <span className="text-muted-foreground">有效期至：</span>
                    {data.validUntil ?? '-'}
                  </div>
                  <div>
                    <span className="text-muted-foreground">整单折扣：</span>
                    {formatPercent(data.discountPct)}
                  </div>
                  <div>
                    <span className="text-muted-foreground">报价总额：</span>
                    {formatMoney(data.totalAmount)}
                  </div>
                  <div>
                    <span className="text-muted-foreground">预估成本：</span>
                    {formatMoney(data.estimatedCost)}
                  </div>
                  <div>
                    <span className="text-muted-foreground">毛利率：</span>
                    <span className={data.marginPct < 20 ? 'text-destructive' : ''}>
                      {formatPercent(data.marginPct)}
                    </span>
                  </div>
                  <div className="col-span-2">
                    <span className="text-muted-foreground">备注：</span>
                    {data.remark ?? '-'}
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
                      {[...data.items]
                        .sort((a: QuotationItem, b: QuotationItem) => a.seq - b.seq)
                        .map((item) => (
                          <tr key={item.id} className="border-b">
                            <td className="py-1 pr-2">{item.itemName}</td>
                            <td className="py-1 pr-2">
                              {item.quantity} {item.unit}
                            </td>
                            <td className="py-1 pr-2">
                              {formatMoney(item.unitPrice)}
                            </td>
                            <td className="py-1 pr-2">
                              {formatPercent(item.discountPct)}
                            </td>
                            <td className="py-1 pr-2">
                              {formatMoney(item.lineAmount)}
                            </td>
                            <td className="py-1">
                              {formatMoney(item.estUnitCost)}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex flex-wrap gap-2 border-t pt-4">
                  {(data.status === 'draft' ||
                    data.status === 'pending_approval') && (
                    <Button
                      variant="outline"
                      onClick={() => navigate(`/crm/quotations/${data.id}/edit`)}
                    >
                      编辑
                    </Button>
                  )}
                  <CanCapabilityWrite capability="crm_write">
                    {data.status === 'draft' ? (
                      <>
                        <Button onClick={() => void runAction('submit')}>
                          提交审批
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => void runAction('void')}
                        >
                          作废
                        </Button>
                      </>
                    ) : null}
                    {data.status === 'pending_approval' ? (
                      <>
                        <Button onClick={() => void runAction('approve')}>
                          通过
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => void runAction('reject')}
                        >
                          驳回
                        </Button>
                      </>
                    ) : null}
                    {data.status === 'approved' ? (
                      <>
                        <Button onClick={() => void runAction('convert')}>
                          转合同
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => void runAction('void')}
                        >
                          作废
                        </Button>
                      </>
                    ) : null}
                    {!data.isWon && data.status !== 'void' && data.opportunityId ? (
                      <Button
                        variant="secondary"
                        onClick={() => void runAction('setWon')}
                      >
                        设为最终成交
                      </Button>
                    ) : null}
                  </CanCapabilityWrite>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <SectionTitle description="方案书、比价文档等">报价附件</SectionTitle>
              </CardHeader>
              <CardContent>
                <AttachmentField
                  resourceType="crm_quotation"
                  resourceId={data.id}
                  usageHint="报价方案书、比价云文档链接"
                />
              </CardContent>
            </Card>
          </div>
        ) : null}
      </DataState>
    </PageShell>
  );
};

export default QuotationDetailPage;
