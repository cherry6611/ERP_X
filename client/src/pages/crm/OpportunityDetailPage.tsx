import React, { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { ArrowLeft, Plus, Star } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import { DataState } from '@client/src/components/DataState';
import PageShell from '@client/src/components/PageShell';
import { usePageEntityName } from '@client/src/components/page-meta';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
import AttachmentHint from '@client/src/components/attachments/AttachmentHint';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { Button } from '@client/src/components/ui/button';
import { Card, CardContent, CardHeader } from '@client/src/components/ui/card';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { Input } from '@client/src/components/ui/input';
import { crmApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { OPP_STAGE_LABELS, QUOTATION_STATUS_LABELS } from '@client/src/utils/biz-labels';
import { formatMoney, formatPercent } from '@client/src/utils/format';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import type {
  OpportunityDetail,
  OpportunityQuotationSummary,
  OpportunityStage,
  UpdateOpportunityDto,
} from '@shared/api.interface';

const STAGE_ORDER = Object.keys(OPP_STAGE_LABELS);

const OpportunityDetailPage: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [savingStage, setSavingStage] = useState(false);
  const [stage, setStage] = useState<string>('');
  const [amount, setAmount] = useState('');
  const [winRate, setWinRate] = useState('');

  const { data, loading, error, reload } = useAsyncData<OpportunityDetail>(
    () => crmApi.getOpportunity(id ?? ''),
    [id],
  );

  usePageEntityName(data ? `${data.code} ${data.title}` : null);

  React.useEffect(() => {
    if (!data) return;
    setStage(data.stage);
    setAmount(String(data.amount));
    setWinRate(String(data.winRate));
  }, [data]);

  const saveAdvance = async () => {
    if (!id) return;
    setSavingStage(true);
    try {
      const dto: UpdateOpportunityDto = {
        stage: stage as OpportunityStage,
        amount: Number(amount) || 0,
        winRate: Number(winRate) || 0,
      };
      await crmApi.updateOpportunity(id, dto);
      toast.success('商机已更新');
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '更新失败'));
    } finally {
      setSavingStage(false);
    }
  };

  const setWon = async (quoteId: string) => {
    if (!id) return;
    const ok = await confirmDanger('确认将该轮报价设为最终成交报价？', {
      title: '选定最终成交报价',
      confirmLabel: '确认选定',
    });
    if (!ok) return;
    try {
      await crmApi.updateOpportunity(id, { wonQuotationId: quoteId });
      toast.success('已设为最终成交报价');
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '设置失败'));
    }
  };

  const voidQuote = async (quoteId: string, code: string) => {
    const ok = await confirmDanger(
      `确认作废报价单 ${code}？此操作不可恢复。`,
      { title: '确认作废', confirmLabel: '确认作废' },
    );
    if (!ok) return;
    try {
      await crmApi.voidQuotation(quoteId);
      toast.success('报价单已作废');
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '作废失败'));
    }
  };

  const convert = async () => {
    if (!data) return;
    const ok = await confirmDanger(
      `确认将商机 ${data.code} 转为合同草稿？将优先使用最终成交报价金额。`,
      { title: '确认转合同', confirmLabel: '确认转换' },
    );
    if (!ok) return;
    try {
      const contract = await crmApi.convertOpportunity(data.id);
      toast.success(`已生成合同草稿 ${contract.code}`);
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '转合同失败'));
    }
  };

  const columns: TableColumnsType<OpportunityQuotationSummary> = [
    {
      title: '轮次',
      dataIndex: 'roundNo',
      width: 70,
      render: (v: number | null, row) =>
        row.isWon ? (
          <span className="inline-flex items-center gap-1 text-amber-700">
            <Star className="h-3.5 w-3.5 fill-current" />第 {v ?? '-'} 轮
          </span>
        ) : (
          `第 ${v ?? '-'} 轮`
        ),
    },
    {
      title: '编号',
      dataIndex: 'code',
      width: 130,
      render: (v: string, row) => (
        <Link
          to={`/crm/quotations/${row.id}`}
          className="text-primary underline-offset-2 hover:underline"
        >
          {v}
        </Link>
      ),
    },
    { title: '标题', dataIndex: 'title', width: 200 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (s: string) => (
        <StatusBadge status={s} labels={QUOTATION_STATUS_LABELS} />
      ),
    },
    {
      title: '报价金额',
      dataIndex: 'totalAmount',
      width: 120,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '毛利率',
      dataIndex: 'marginPct',
      width: 90,
      render: (v: number) => formatPercent(v),
    },
    {
      title: '报价日期',
      dataIndex: 'quoteDate',
      width: 110,
      render: (v) => v ?? '-',
    },
    {
      title: '备注',
      dataIndex: 'remark',
      width: 160,
      ellipsis: true,
      render: (v) => v ?? '-',
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 280,
      render: (_, row) => (
        <div className="flex flex-wrap gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/crm/quotations/${row.id}`)}
          >
            查看
          </Button>
          {row.status === 'draft' || row.status === 'pending_approval' ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                navigate(`/crm/quotations/${row.id}/edit`, {
                  state: { opportunityId: id },
                })
              }
            >
              编辑
            </Button>
          ) : null}
          <CanCapabilityWrite capability="crm_write">
            {!row.isWon && row.status !== 'void' ? (
              <Button variant="ghost" size="sm" onClick={() => void setWon(row.id)}>
                设为成交
              </Button>
            ) : null}
            {row.status !== 'void' && row.status !== 'converted' ? (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => void voidQuote(row.id, row.code)}
              >
                作废
              </Button>
            ) : null}
          </CanCapabilityWrite>
        </div>
      ),
    },
  ];

  return (
    <PageShell
      title={data ? `商机详情 · ${data.title}` : '商机详情'}
      description="多轮报价管理、项目资料与需求书附件"
      actions={
        <Button variant="outline" onClick={() => navigate('/crm?tab=opportunities')}>
          <ArrowLeft className="h-4 w-4" />
          返回列表
        </Button>
      }
    >
      <DataState
        loading={loading}
        error={error}
        onRetry={() => void reload()}
        skeleton="default"
      >
        {data ? (
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <SectionTitle description={`客户：${data.customerName}`}>
                  {`${data.code} · ${data.title}`}
                </SectionTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm md:grid-cols-3">
                  <div>
                    <span className="text-muted-foreground">阶段：</span>
                    <StatusBadge status={data.stage} labels={OPP_STAGE_LABELS} />
                  </div>
                  <div>
                    <span className="text-muted-foreground">预计金额：</span>
                    {formatMoney(data.amount)}
                  </div>
                  <div>
                    <span className="text-muted-foreground">赢单率：</span>
                    {formatPercent(data.winRate)}
                  </div>
                  <div>
                    <span className="text-muted-foreground">负责人：</span>
                    {data.owner ?? '-'}
                  </div>
                  <div>
                    <span className="text-muted-foreground">预计成交：</span>
                    {data.expectedDate ?? '-'}
                  </div>
                  <div>
                    <span className="text-muted-foreground">报价轮次：</span>
                    {data.quotationCount} 轮
                  </div>
                  <div className="col-span-2 md:col-span-3">
                    <span className="text-muted-foreground">最终成交报价：</span>
                    {data.wonQuotationId ? (
                      <Link
                        to={`/crm/quotations/${data.wonQuotationId}`}
                        className="text-primary underline-offset-2 hover:underline"
                      >
                        {data.wonQuotationCode} · {data.wonQuotationTitle}
                      </Link>
                    ) : (
                      '尚未选定'
                    )}
                  </div>
                  <div className="col-span-2 md:col-span-3">
                    <span className="text-muted-foreground">备注：</span>
                    {data.remark ?? '-'}
                  </div>
                </div>

                <CanCapabilityWrite capability="crm_write">
                  <div className="rounded-md border bg-muted/30 p-4">
                    <SectionTitle description="更新商机阶段、金额与赢单率">
                      阶段推进
                    </SectionTitle>
                    <div className="mt-3 flex flex-wrap items-end gap-3">
                      <div className="space-y-1">
                        <Label>阶段</Label>
                        <Select value={stage} onValueChange={setStage}>
                          <SelectTrigger className="w-36">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {STAGE_ORDER.map((s) => (
                              <SelectItem key={s} value={s}>
                                {OPP_STAGE_LABELS[s]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="opp-amount">预计金额</Label>
                        <Input
                          id="opp-amount"
                          type="number"
                          min={0}
                          className="w-36"
                          value={amount}
                          onChange={(e) => setAmount(e.target.value)}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="opp-win">赢单率 %</Label>
                        <Input
                          id="opp-win"
                          type="number"
                          min={0}
                          max={100}
                          className="w-28"
                          value={winRate}
                          onChange={(e) => setWinRate(e.target.value)}
                        />
                      </div>
                      <Button disabled={savingStage} onClick={() => void saveAdvance()}>
                        保存推进
                      </Button>
                      {data.stage === 'won' && !data.contractId ? (
                        <Button variant="secondary" onClick={() => void convert()}>
                          转合同
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </CanCapabilityWrite>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0">
                <SectionTitle description="每个商机可维护多轮报价历史，并选定最终成交轮次">
                  多轮报价
                </SectionTitle>
                <Button
                  onClick={() =>
                    navigate(`/crm/opportunities/${data.id}/quotations/new`)
                  }
                >
                  <Plus className="h-4 w-4" />
                  新增一轮报价
                </Button>
              </CardHeader>
              <CardContent>
                <Table
                  columns={columns}
                  dataSource={data.quotations}
                  rowKey="id"
                  scroll={{ x: 1100 }}
                  pagination={false}
                  locale={{ emptyText: '暂无报价，点击右上角新增第一轮报价' }}
                  rowClassName={(row) => (row.isWon ? 'bg-amber-50/60' : '')}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <SectionTitle description="上传并查看本商机相关附件（需求书、方案、往来资料等）">
                  项目资料与需求书
                </SectionTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <AttachmentHint text="支持上传文件或粘贴飞书云文档链接" />
                <AttachmentField
                  resourceType="crm_opportunity"
                  resourceId={data.id}
                  usageHint="需求书、项目资料、往来邮件导出等"
                />
              </CardContent>
            </Card>
          </div>
        ) : null}
      </DataState>
    </PageShell>
  );
};

export default OpportunityDetailPage;
