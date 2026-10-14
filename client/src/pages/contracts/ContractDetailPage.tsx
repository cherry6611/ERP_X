import React, { useCallback } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import PageShell from '@client/src/components/PageShell';
import { usePageEntityName } from '@client/src/components/page-meta';
import { Button } from '@client/src/components/ui/button';
import { PrintButton } from '@client/src/components/print';
import type { PrintPackSeed } from '@client/src/components/print';
import { cellText, compactFields, metaField } from '@client/src/components/print';
import { contractsApi } from '@client/src/api';
import type { ContractItem } from '@client/src/api/contracts';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { BILLING_MODEL_LABELS } from '@client/src/utils/biz-labels';
import { formatPercent } from '@client/src/utils/format';
import type { BrandConfig, ContractDetail } from '@shared/api.interface';
import ContractDetailDialog from './ContractDetailDialog';

const ContractDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data } = useAsyncData<{ detail: ContractDetail; items: ContractItem[] } | null>(
    async () => {
      if (!id) return null;
      const [detail, items] = await Promise.all([
        contractsApi.getContract(id),
        contractsApi.listContractItems(id),
      ]);
      return { detail, items };
    },
    [id],
  );
  const detail = data?.detail ?? null;
  const items = data?.items ?? [];

  usePageEntityName(detail ? `${detail.code} ${detail.name}` : null);

  /** C-06：合同打印件组包（抬头由 PrintButton 从 settings 品牌接口注入） */
  const buildPrintPackSeed = useCallback(
    (_brand: BrandConfig | null): PrintPackSeed | null => {
      if (!detail) return null;
      return {
        kind: 'contract',
        code: detail.code,
        title: '销售合同',
        subtitle: `合同编号：${detail.code}`,
        meta: compactFields([
          metaField('客户', detail.customerName),
          metaField(
            '计费模式',
            BILLING_MODEL_LABELS[detail.billingModel] ?? detail.billingModel,
          ),
          metaField('合同金额（含税）', detail.amount),
          metaField('税率', `${detail.taxRate}%`),
          metaField('不含税金额', detail.netAmount ?? 0),
          metaField('税额', detail.taxAmount ?? 0),
          metaField('负责人', detail.owner),
          metaField('签订日期', detail.signDate),
          metaField('履约周期', `${detail.startDate ?? '-'} ~ ${detail.endDate ?? '-'}`),
          metaField('可开票金额', detail.billable.billableAmount),
        ]),
        tableTitle: '合同明细',
        columns: [
          { key: 'seq', label: '序号', widthMm: 12, align: 'center' },
          { key: 'itemName', label: '名称' },
          { key: 'unit', label: '单位', widthMm: 16, align: 'center' },
          { key: 'quantity', label: '数量', widthMm: 18, align: 'right' },
          { key: 'unitPrice', label: '含税单价', widthMm: 24, align: 'right' },
          { key: 'discountPct', label: '折扣', widthMm: 16, align: 'right' },
          { key: 'taxRate', label: '税率', widthMm: 14, align: 'center' },
          { key: 'amount', label: '含税金额', widthMm: 26, align: 'right' },
        ],
        rows: [...items]
          .sort((a, b) => a.seq - b.seq)
          .map((item) => ({
            cells: {
              seq: String(item.seq),
              itemName: item.itemName,
              unit: item.unit,
              quantity: cellText(item.quantity),
              unitPrice: cellText(item.unitPrice),
              discountPct: formatPercent(item.discountPct),
              taxRate: `${item.taxRate}%`,
              amount: cellText(item.amount),
            },
          })),
        totals: [
          { label: '合同金额（含税）', amount: detail.amount, inWords: true, emphasize: true },
          { label: '不含税金额', amount: detail.netAmount ?? 0 },
          { label: '税额', amount: detail.taxAmount ?? 0 },
        ],
        clauses: [
          detail.paymentTerms ? `付款条款：${detail.paymentTerms}` : '',
          detail.remark ? `备注：${detail.remark}` : '',
        ].filter(Boolean),
        sourceNote: '数据来源：合同管理模块',
      };
    },
    [detail, items],
  );

  return (
    <PageShell
      title={detail ? `合同详情 · ${detail.code}` : '合同详情'}
      description={detail?.name}
      actions={
        <>
          <PrintButton build={buildPrintPackSeed} disabled={!detail} />
          <Button variant="outline" onClick={() => navigate('/contracts')}>
            <ArrowLeft className="h-4 w-4" />
            返回列表
          </Button>
        </>
      }
    >
      <ContractDetailDialog asPage contractId={id ?? null} open />
    </PageShell>
  );
};

export default ContractDetailPage;
