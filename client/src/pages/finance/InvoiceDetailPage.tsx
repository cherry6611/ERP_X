import React, { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { DataState } from '@client/src/components/DataState';
import PageShell from '@client/src/components/PageShell';
import { usePageEntityName } from '@client/src/components/page-meta';
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { Button } from '@client/src/components/ui/button';
import { Card, CardContent, CardHeader } from '@client/src/components/ui/card';
import { financeApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney, formatPercent } from '@client/src/utils/format';
import { formatTaxSplitLine } from '@client/src/utils/tax-display';
import type { InvoiceDirection, InvoiceItem } from '@shared/api.interface';

const INVOICE_TYPE_LABELS: Record<string, string> = {
  vat_special: '增值税专用发票',
  vat_normal: '增值税普通发票',
  electronic: '电子发票',
};

const INVOICE_STATUS_LABELS: Record<string, string> = {
  issued: '已开票',
  voided: '已作废',
};

const DIRECTION_LABELS: Record<InvoiceDirection, string> = {
  sales: '销项',
  purchase: '进项',
};

const InvoiceDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data, loading, error } = useAsyncData<InvoiceItem | null>(async () => {
    if (!id) return null;
    const list = await financeApi.listInvoices();
    return list.find((item) => item.id === id) ?? null;
  }, [id]);

  usePageEntityName(data ? `${data.code}` : null);

  const detailRows = useMemo(() => {
    if (!data) return [];
    return [
      { label: '申请编号', value: data.code },
      { label: '发票号码', value: data.invoiceNo ?? '-' },
      { label: '方向', value: DIRECTION_LABELS[data.direction] ?? data.direction },
      {
        label: '发票类型',
        value: INVOICE_TYPE_LABELS[data.invoiceType] ?? data.invoiceType,
      },
      { label: '开票金额（含税）', value: formatMoney(data.amount) },
      {
        label: '价税拆分',
        value: formatTaxSplitLine(data.amount, data.taxRate),
      },
      { label: '税率', value: formatPercent(data.taxRate) },
      { label: '税额', value: formatMoney(data.taxAmount) },
      { label: '客户', value: data.customerName ?? '-' },
      { label: '供应商', value: data.supplierName ?? '-' },
      { label: '合同', value: data.contractName ?? '-' },
      { label: '项目', value: data.projectName ?? '-' },
      { label: '关联应收', value: data.arCode ?? '-' },
      { label: '状态', value: INVOICE_STATUS_LABELS[data.status] ?? data.status },
      { label: '开票日期', value: data.invoiceDate ?? '-' },
      { label: '备注', value: data.remark ?? '-' },
      { label: '创建时间', value: data.createdAt },
    ];
  }, [data]);

  return (
    <PageShell
      title={data ? `发票详情 · ${data.code}` : '发票详情'}
      description="发票台账字段与附件"
      actions={
        <Button variant="outline" onClick={() => navigate('/finance?tab=invoices')}>
          <ArrowLeft className="h-4 w-4" />
          返回列表
        </Button>
      }
    >
      <DataState
        loading={loading}
        error={error}
        empty={!loading && !data}
        emptyText="发票不存在或已删除"
        skeleton="default"
      >
        {data ? (
          <div className="mx-auto max-w-4xl space-y-6">
            <Card>
              <CardHeader>
                <SectionTitle>基本信息</SectionTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                  {detailRows.map((row) => (
                    <div key={row.label} className="flex items-baseline gap-2 text-sm">
                      <span className="w-28 shrink-0 text-muted-foreground">{row.label}</span>
                      <span className="min-w-0 break-words">{row.value}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <SectionTitle description="发票扫描件、电子发票 PDF 等">附件</SectionTitle>
              </CardHeader>
              <CardContent>
                <AttachmentField
                  resourceType="erp_invoice"
                  resourceId={data.id}
                  usageHint="发票扫描件、电子发票 PDF 等"
                />
              </CardContent>
            </Card>
          </div>
        ) : null}
      </DataState>
    </PageShell>
  );
};

export default InvoiceDetailPage;
