import React, { useCallback } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { DataState } from '@client/src/components/DataState';
import PageShell from '@client/src/components/PageShell';
import { usePageEntityName } from '@client/src/components/page-meta';
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { Button } from '@client/src/components/ui/button';
import { Card, CardContent, CardHeader } from '@client/src/components/ui/card';
import { PrintButton } from '@client/src/components/print';
import type { PrintPackSeed } from '@client/src/components/print';
import { compactFields, metaField } from '@client/src/components/print';
import { finExpenseApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import FinStatusBadge, { CLAIM_STATUS_LABELS } from './components/FinStatusBadge';
import type { BrandConfig, ExpenseClaimItem } from '@shared/api.interface';

const ExpenseClaimDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const stateItem = (location.state as { item?: ExpenseClaimItem } | null)?.item;

  const { data, loading, error } = useAsyncData<ExpenseClaimItem | null>(
    async () => {
      if (!id) return null;
      if (stateItem?.id === id) return stateItem;
      const res = await finExpenseApi.listClaims({ page: 1, pageSize: 500 });
      return res.items.find((item) => item.id === id) ?? null;
    },
    [id, stateItem],
  );

  usePageEntityName(data ? data.code : null);

  /** C-06：费用报销单打印件组包（报销单为封面单，明细见所附票据） */
  const buildPrintPackSeed = useCallback(
    (_brand: BrandConfig | null): PrintPackSeed | null => {
      if (!data) return null;
      return {
        kind: 'expense_claim',
        code: data.code,
        title: '费用报销单',
        subtitle: `报销单编号：${data.code}`,
        meta: compactFields([
          metaField('关联申请', data.applyCode),
          metaField('报销人', data.applicant),
          metaField('部门', data.departmentName),
          metaField('项目', data.projectName),
          metaField('费用科目', data.expenseCategory),
          metaField('费用日期', data.expenseDate),
          metaField('状态', CLAIM_STATUS_LABELS[data.status] ?? data.status),
        ]),
        totals: [{ label: '报销金额', amount: data.amount, inWords: true, emphasize: true }],
        clauses: [
          data.remark ? `事由/备注：${data.remark}` : '',
          '所附原始票据张数以附件为准，粘贴后随本单提交。',
        ].filter(Boolean),
        signatures: [
          { slot: 'prepared', label: '报销人', signer: data.applicant ?? null },
          { slot: 'reviewed', label: '部门负责人', signer: null },
          { slot: 'approved', label: '财务审核', signer: null },
          { slot: 'chief_accountant', label: '批准', signer: null },
        ],
        sourceNote: '数据来源：费用报销模块',
      };
    },
    [data],
  );

  return (
    <PageShell
      title={data ? `报销单 · ${data.code}` : '报销单详情'}
      actions={
        <>
          <PrintButton build={buildPrintPackSeed} disabled={!data} label="打印报销单" />
          <Button
            variant="outline"
            onClick={() => navigate('/fin-expense?tab=claims')}
          >
            <ArrowLeft className="h-4 w-4" />
            返回列表
          </Button>
        </>
      }
    >
      <DataState
        loading={loading}
        error={error}
        empty={!loading && !data}
        emptyText="报销单不存在或已删除"
        skeleton="default"
      >
        {data ? (
          <div className="mx-auto max-w-3xl space-y-6">
            <Card>
              <CardHeader>
                <SectionTitle>基本信息</SectionTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <p>
                  <span className="text-muted-foreground">关联申请：</span>
                  {data.applyCode ?? '-'}
                </p>
                <p>
                  <span className="text-muted-foreground">部门：</span>
                  {data.departmentName ?? '-'}
                </p>
                <p>
                  <span className="text-muted-foreground">项目：</span>
                  {data.projectName ?? '-'}
                </p>
                <p>
                  <span className="text-muted-foreground">费用科目：</span>
                  {data.expenseCategory}
                </p>
                <p>
                  <span className="text-muted-foreground">报销金额：</span>
                  {formatMoney(data.amount)}
                </p>
                <p>
                  <span className="text-muted-foreground">费用日期：</span>
                  {data.expenseDate ?? '-'}
                </p>
                <p>
                  <span className="text-muted-foreground">报销人：</span>
                  {data.applicant ?? '-'}
                </p>
                <p className="flex items-center gap-2">
                  <span className="text-muted-foreground">状态：</span>
                  <FinStatusBadge status={data.status} labels={CLAIM_STATUS_LABELS} />
                </p>
                <p className="col-span-2">
                  <span className="text-muted-foreground">备注：</span>
                  {data.remark ?? '-'}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <SectionTitle>附件</SectionTitle>
              </CardHeader>
              <CardContent>
                <AttachmentField
                  resourceType="fin_expense_claim"
                  resourceId={data.id}
                  usageHint="发票、行程单、票据等"
                />
              </CardContent>
            </Card>
          </div>
        ) : null}
      </DataState>
    </PageShell>
  );
};

export default ExpenseClaimDetailPage;
