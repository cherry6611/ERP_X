import React, { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@client/src/components/ui/form';
import { Input } from '@client/src/components/ui/input';
import { Textarea } from '@client/src/components/ui/textarea';
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
import { contractsApi } from '@client/src/api';
import { formatMoney } from '@client/src/utils/format';
import { BILLING_MODEL_LABELS, CONTRACT_STATUS_LABELS } from '@client/src/utils/biz-labels';
import type {
  Calloff,
  ContractDetail,
  ContractMilestone,
  ContractStatusAction,
  ContractVersion,
} from '@shared/api.interface';

const STATUS_ACTIONS: Partial<Record<string, { action: ContractStatusAction; label: string }[]>> = {
  draft: [{ action: 'submit', label: '提交审批' }],
  approving: [
    { action: 'approve', label: '审批通过' },
    { action: 'reject', label: '驳回' },
  ],
  active: [{ action: 'start', label: '开始履约' }],
  performing: [{ action: 'complete', label: '履约完成' }],
  completed: [{ action: 'close', label: '关闭合同' }],
};

const milestoneSchema = z.object({
  name: z.string().min(1, '里程碑名称不能为空'),
  amount: z.coerce.number().min(0),
  dueCondition: z.string(),
  dueDate: z.string().optional(),
});

type MilestoneFormData = z.output<typeof milestoneSchema>;
type MilestoneFormInput = z.input<typeof milestoneSchema>;

const calloffSchema = z.object({
  amount: z.coerce.number().min(1, '下单金额必须大于 0'),
  remark: z.string(),
});

type CalloffFormData = z.output<typeof calloffSchema>;
type CalloffFormInput = z.input<typeof calloffSchema>;

const changeSchema = z.object({
  changeLog: z.string().min(1, '请填写变更说明'),
  newAmount: z.coerce.number().min(0),
});

type ChangeFormData = z.output<typeof changeSchema>;
type ChangeFormInput = z.input<typeof changeSchema>;

interface ContractDetailDialogProps {
  contractId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const ContractDetailDialog: React.FC<ContractDetailDialogProps> = ({
  contractId,
  open,
  onOpenChange,
}) => {
  const [detail, setDetail] = useState<ContractDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [milestoneOpen, setMilestoneOpen] = useState(false);
  const [calloffOpen, setCalloffOpen] = useState(false);
  const [changeOpen, setChangeOpen] = useState(false);

  const milestoneForm = useForm<MilestoneFormInput, unknown, MilestoneFormData>({
    resolver: zodResolver(milestoneSchema),
    defaultValues: { name: '', amount: 0, dueCondition: '' },
  });
  const calloffForm = useForm<CalloffFormInput, unknown, CalloffFormData>({
    resolver: zodResolver(calloffSchema),
    defaultValues: { amount: 0, remark: '' },
  });
  const changeForm = useForm<ChangeFormInput, unknown, ChangeFormData>({
    resolver: zodResolver(changeSchema),
    defaultValues: { changeLog: '', newAmount: 0 },
  });

  const load = async () => {
    if (!contractId) return;
    setLoading(true);
    setError(null);
    try {
      setDetail(await contractsApi.getContract(contractId));
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载合同详情失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, contractId]);

  const doAction = async (action: ContractStatusAction) => {
    if (!contractId) return;
    try {
      await contractsApi.changeContractStatus(contractId, action);
      toast.success('状态已更新');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const onAddMilestone = milestoneForm.handleSubmit(async (values) => {
    if (!contractId) return;
    try {
      await contractsApi.addMilestone(contractId, {
        name: values.name,
        amount: values.amount,
        dueCondition: values.dueCondition || undefined,
        dueDate: values.dueDate,
      });
      toast.success('里程碑已添加');
      setMilestoneOpen(false);
      milestoneForm.reset({ name: '', amount: 0, dueCondition: '' });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '添加失败');
    }
  });

  const reachMilestone = async (m: ContractMilestone) => {
    try {
      await contractsApi.updateMilestone(m.id, { status: 'reached' });
      toast.success('里程碑已达成');
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const onAddCalloff = calloffForm.handleSubmit(async (values) => {
    if (!contractId) return;
    try {
      await contractsApi.createCalloff(contractId, {
        amount: values.amount,
        remark: values.remark || undefined,
      });
      toast.success('Call-off 下单成功');
      setCalloffOpen(false);
      calloffForm.reset({ amount: 0, remark: '' });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '下单失败');
    }
  });

  const onCreateChange = changeForm.handleSubmit(async (values) => {
    if (!contractId) return;
    try {
      await contractsApi.createVersion(contractId, {
        changeLog: values.changeLog,
        newAmount: values.newAmount || undefined,
      });
      toast.success('变更已留痕');
      setChangeOpen(false);
      changeForm.reset({ changeLog: '', newAmount: 0 });
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '变更失败');
    }
  });

  const milestoneColumns: TableColumnsType<ContractMilestone> = [
    { title: '名称', dataIndex: 'name', width: 160 },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 120,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    { title: '触发条件', dataIndex: 'dueCondition', width: 160, render: (v) => v ?? '-' },
    { title: '计划日期', dataIndex: 'dueDate', width: 110, render: (v) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => (
        <StatusBadge status={s} labels={{ pending: '未达成', reached: '已达成' }} />
      ),
    },
    { title: '达成日期', dataIndex: 'actualDate', width: 110, render: (v) => v ?? '-' },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 90,
      render: (_, record) =>
        record.status === 'pending' ? (
          <CanRole roles={['admin']}>
            <Button variant="ghost" size="sm" onClick={() => void reachMilestone(record)}>
              达成
            </Button>
          </CanRole>
        ) : null,
    },
  ];

  const calloffColumns: TableColumnsType<Calloff> = [
    { title: '下单编号', dataIndex: 'code', width: 150 },
    { title: '序号', dataIndex: 'seq', width: 70 },
    { title: '关联项目', dataIndex: 'projectName', width: 160, render: (v) => v ?? '-' },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 120,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    { title: '下单日期', dataIndex: 'orderDate', width: 110, render: (v) => v ?? '-' },
    { title: '备注', dataIndex: 'remark', width: 160, render: (v) => v ?? '-' },
  ];

  const versionColumns: TableColumnsType<ContractVersion> = [
    { title: '版本', dataIndex: 'versionNo', width: 70, render: (v: number) => `V${v}` },
    { title: '变更说明', dataIndex: 'changeLog', width: 220 },
    {
      title: '金额变动',
      dataIndex: 'changeAmount',
      width: 120,
      align: 'right',
      render: (v: number) => (
        <span className={v < 0 ? 'text-destructive' : ''}>
          {v > 0 ? `+${formatMoney(v)}` : formatMoney(v)}
        </span>
      ),
    },
    {
      title: '变更时间',
      dataIndex: 'createdAt',
      width: 170,
      render: (v: string) => new Date(v).toLocaleString('zh-CN'),
    },
  ];

  const actions = detail ? (STATUS_ACTIONS[detail.status] ?? []) : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            合同详情 - {detail?.code ?? ''}{' '}
            {detail ? (
              <StatusBadge status={detail.status} labels={CONTRACT_STATUS_LABELS} />
            ) : null}
          </DialogTitle>
        </DialogHeader>
        {loading ? <p className="text-sm text-muted-foreground">加载中...</p> : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {detail ? (
          <div className="flex flex-col gap-6">
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div>
                <p className="text-muted-foreground">客户</p>
                <p>{detail.customerName}</p>
              </div>
              <div>
                <p className="text-muted-foreground">计费模式</p>
                <p>
                  <Badge variant="secondary">
                    {BILLING_MODEL_LABELS[detail.billingModel] ?? detail.billingModel}
                  </Badge>
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">合同金额</p>
                <p>{formatMoney(detail.amount)}</p>
              </div>
              <div>
                <p className="text-muted-foreground">税率</p>
                <p>{detail.taxRate}%</p>
              </div>
              <div>
                <p className="text-muted-foreground">负责人</p>
                <p>{detail.owner ?? '-'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">付款条款</p>
                <p>{detail.paymentTerms ?? '-'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">签订日期</p>
                <p>{detail.signDate ?? '-'}</p>
              </div>
              <div>
                <p className="text-muted-foreground">履约周期</p>
                <p>
                  {detail.startDate ?? '-'} ~ {detail.endDate ?? '-'}
                </p>
              </div>
              <div>
                <p className="text-muted-foreground">可开票金额</p>
                <p>{formatMoney(detail.billable.billableAmount)}</p>
              </div>
            </div>

            <CanRole roles={['admin']}>
              <div className="flex flex-wrap gap-2">
                {actions.map(({ action, label }) => (
                  <Button
                    key={action}
                    size="sm"
                    variant={action === 'reject' ? 'destructive' : 'default'}
                    onClick={() => void doAction(action)}
                  >
                    {label}
                  </Button>
                ))}
                <Button size="sm" variant="outline" onClick={() => setChangeOpen(true)}>
                  登记变更
                </Button>
              </div>
            </CanRole>

            <div className="flex flex-col gap-3">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold">合同里程碑</h3>
                <CanRole roles={['admin']}>
                  <Button size="sm" variant="outline" onClick={() => setMilestoneOpen(true)}>
                    <Plus className="h-4 w-4" />
                    添加里程碑
                  </Button>
                </CanRole>
              </div>
              <Table
                columns={milestoneColumns}
                dataSource={detail.milestones}
                rowKey="id"
                scroll={{ x: 800, y: 240 }}
                pagination={false}
                size="small"
              />
            </div>

            {detail.billingModel === 'framework' ? (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <h3 className="text-base font-semibold">
                    Call-off 下单（累计 {formatMoney(detail.billable.calloffTotal)} / 上限{' '}
                    {formatMoney(detail.amount)}）
                  </h3>
                  <CanRole roles={['admin']}>
                    <Button size="sm" variant="outline" onClick={() => setCalloffOpen(true)}>
                      <Plus className="h-4 w-4" />
                      框架下单
                    </Button>
                  </CanRole>
                </div>
                <Table
                  columns={calloffColumns}
                  dataSource={detail.calloffs}
                  rowKey="id"
                  scroll={{ x: 800, y: 240 }}
                  pagination={false}
                  size="small"
                />
              </div>
            ) : null}

            <div className="flex flex-col gap-3">
              <h3 className="text-base font-semibold">变更版本留痕</h3>
              <Table
                columns={versionColumns}
                dataSource={detail.versions}
                rowKey="id"
                scroll={{ x: 600, y: 240 }}
                pagination={false}
                size="small"
              />
            </div>

            {contractId ? (
              <div className="border-t pt-4">
                <AttachmentField
                  resourceType="erp_contract"
                  resourceId={contractId}
                  usageHint="合同扫描件、补充协议、验收单等"
                />
              </div>
            ) : null}
          </div>
        ) : null}

        <Dialog open={milestoneOpen} onOpenChange={setMilestoneOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>添加里程碑</DialogTitle>
            </DialogHeader>
            <Form {...milestoneForm}>
              <form onSubmit={onAddMilestone} className="space-y-4">
                <FormField
                  control={milestoneForm.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        名称 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="请输入里程碑名称" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="flex gap-4">
                  <FormField
                    control={milestoneForm.control}
                    name="amount"
                    render={({ field }) => (
                      <FormItem className="flex-1">
                        <FormLabel>金额（元）</FormLabel>
                        <FormControl>
                          <Input
                            type="number"
                            min={0}
                            value={String(field.value ?? '')}
                            onChange={field.onChange}
                            onBlur={field.onBlur}
                            name={field.name}
                            ref={field.ref}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={milestoneForm.control}
                    name="dueCondition"
                    render={({ field }) => (
                      <FormItem className="flex-1">
                        <FormLabel>触发条件</FormLabel>
                        <FormControl>
                          <Input placeholder="如：验收通过" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <DialogFooter>
                  <Button type="submit">保存</Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>

        <Dialog open={calloffOpen} onOpenChange={setCalloffOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>框架合同下单（Call-off）</DialogTitle>
            </DialogHeader>
            <Form {...calloffForm}>
              <form onSubmit={onAddCalloff} className="space-y-4">
                <FormField
                  control={calloffForm.control}
                  name="amount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        下单金额（元）{' '}
                        <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
                          value={String(field.value ?? '')}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={calloffForm.control}
                  name="remark"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>备注</FormLabel>
                      <FormControl>
                        <Textarea placeholder="下单说明" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <DialogFooter>
                  <Button type="submit">下单</Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>

        <Dialog open={changeOpen} onOpenChange={setChangeOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>登记合同变更</DialogTitle>
            </DialogHeader>
            <Form {...changeForm}>
              <form onSubmit={onCreateChange} className="space-y-4">
                <FormField
                  control={changeForm.control}
                  name="changeLog"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>
                        变更说明 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Textarea placeholder="请描述本次变更内容" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={changeForm.control}
                  name="newAmount"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>变更后金额（元，不变可填 0）</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
                          value={String(field.value ?? '')}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <DialogFooter>
                  <Button type="submit">保存变更</Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </DialogContent>
    </Dialog>
  );
};

export default ContractDetailDialog;
