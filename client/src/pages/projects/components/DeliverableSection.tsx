import React, { useCallback, useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
import { DataState } from '@client/src/components/DataState';
import { SectionTitle } from '@client/src/components/SectionTitle';
import DateField from '@client/src/components/erp/DateField';
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
import { projectsApi } from '@client/src/api';
import { PrintButton } from '@client/src/components/print';
import { compactFields, metaField } from '@client/src/components/print';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type {
  CreateDeliverableDto,
  DeliverableItem,
  DeliverableStatus,
} from '@shared/api.interface';

const DELIVERABLE_STATUS_META: Record<
  DeliverableStatus,
  { label: string; variant: 'secondary' | 'warning' | 'success' | 'destructive' }
> = {
  pending: { label: '待交付', variant: 'secondary' },
  submitted: { label: '待验收', variant: 'warning' },
  accepted: { label: '已验收', variant: 'success' },
  returned: { label: '已退回', variant: 'destructive' },
};

const dateStringSchema = z
  .string()
  .refine((v) => v === '' || /^\d{4}-\d{2}-\d{2}$/u.test(v), '请输入 YYYY-MM-DD 格式日期');

const deliverableSchema = z.object({
  name: z.string().min(1, '交付物名称不能为空'),
  deliverableType: z.string(),
  acceptanceCriteria: z.string(),
  dueDate: dateStringSchema,
  reviewer: z.string(),
  remark: z.string(),
});

type DeliverableFormData = z.infer<typeof deliverableSchema>;

const deliverableReturnSchema = z.object({
  reason: z.string().min(1, '请填写退回原因'),
});

type DeliverableReturnFormData = z.infer<typeof deliverableReturnSchema>;

const deliverableAcceptSchema = z.object({
  conclusion: z.string(),
  acceptDate: z.string().optional(),
});

type DeliverableAcceptFormData = z.infer<typeof deliverableAcceptSchema>;

interface DeliverableSectionProps {
  projectId: string;
  onChanged?: () => void;
}

const DeliverableSection: React.FC<DeliverableSectionProps> = ({ projectId, onChanged }) => {
  const [deliverables, setDeliverables] = useState<DeliverableItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [returnTarget, setReturnTarget] = useState<DeliverableItem | null>(null);
  const [returnOpen, setReturnOpen] = useState(false);
  const [acceptTarget, setAcceptTarget] = useState<DeliverableItem | null>(null);

  const deliverableForm = useForm<DeliverableFormData>({
    resolver: zodResolver(deliverableSchema),
    defaultValues: {
      name: '',
      deliverableType: '',
      acceptanceCriteria: '',
      dueDate: '',
      reviewer: '',
      remark: '',
    },
  });

  const deliverableReturnForm = useForm<DeliverableReturnFormData>({
    resolver: zodResolver(deliverableReturnSchema),
    defaultValues: { reason: '' },
  });

  const deliverableAcceptForm = useForm<DeliverableAcceptFormData>({
    resolver: zodResolver(deliverableAcceptSchema),
    defaultValues: { conclusion: '', acceptDate: '' },
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const detail = await projectsApi.getProject(projectId);
      setDeliverables(detail.deliverables);
    } catch (err) {
      setError(getApiErrorMessage(err, '加载交付物失败'));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    await load();
    onChanged?.();
  };

  const onCreateDeliverable = deliverableForm.handleSubmit(async (values) => {
    const dto: CreateDeliverableDto = {
      name: values.name,
      deliverableType: values.deliverableType || undefined,
      acceptanceCriteria: values.acceptanceCriteria || undefined,
      dueDate: values.dueDate || undefined,
      reviewer: values.reviewer || undefined,
      remark: values.remark || undefined,
    };
    try {
      await projectsApi.createDeliverable(projectId, dto);
      toast.success('交付物已添加');
      setAddOpen(false);
      deliverableForm.reset({
        name: '',
        deliverableType: '',
        acceptanceCriteria: '',
        dueDate: '',
        reviewer: '',
        remark: '',
      });
      await refresh();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '添加失败'));
    }
  });

  const submitDeliverableAction = async (d: DeliverableItem) => {
    try {
      await projectsApi.submitDeliverable(d.id);
      toast.success(d.status === 'returned' ? '交付物已重新提交' : '交付物已提交验收');
      await refresh();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '操作失败'));
    }
  };

  const openAcceptDeliverable = (d: DeliverableItem) => {
    deliverableAcceptForm.reset({
      conclusion: d.acceptConclusion ?? '',
      acceptDate: dayjs().format('YYYY-MM-DD'),
    });
    setAcceptTarget(d);
  };

  const onAcceptDeliverable = deliverableAcceptForm.handleSubmit(async (values) => {
    if (!acceptTarget) return;
    try {
      await projectsApi.acceptDeliverable(acceptTarget.id, {
        reviewer: acceptTarget.reviewer ?? undefined,
        acceptConclusion: values.conclusion || undefined,
      });
      toast.success('交付物已通过验收');
      setAcceptTarget(null);
      await refresh();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '验收失败'));
    }
  });

  const openReturnDeliverable = (d: DeliverableItem) => {
    setReturnTarget(d);
    deliverableReturnForm.reset({ reason: '' });
    setReturnOpen(true);
  };

  const onReturnDeliverable = deliverableReturnForm.handleSubmit(async (values) => {
    if (!returnTarget) return;
    try {
      await projectsApi.returnDeliverable(returnTarget.id, { reason: values.reason });
      toast.success('交付物已退回');
      setReturnOpen(false);
      setReturnTarget(null);
      await refresh();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '退回失败'));
    }
  });

  const todayStr = dayjs().format('YYYY-MM-DD');

  const deliverableColumns: TableColumnsType<DeliverableItem> = [
    { title: '编号', dataIndex: 'code', width: 130 },
    { title: '名称', dataIndex: 'name', width: 150 },
    {
      title: '类型',
      dataIndex: 'deliverableType',
      width: 90,
      render: (v: string) => v || '-',
    },
    {
      title: '验收标准',
      dataIndex: 'acceptanceCriteria',
      width: 200,
      render: (v: string | null) =>
        v ? (
          <span className="block truncate" title={v}>
            {v}
          </span>
        ) : (
          '-'
        ),
    },
    {
      title: '截止日期',
      dataIndex: 'dueDate',
      width: 110,
      render: (v: string | null, record) =>
        record.status !== 'accepted' && v && v < todayStr ? (
          <span className="text-destructive">{v}</span>
        ) : (
          (v ?? '-')
        ),
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: DeliverableStatus) => (
        <Badge variant={DELIVERABLE_STATUS_META[s].variant}>
          {DELIVERABLE_STATUS_META[s].label}
        </Badge>
      ),
    },
    { title: '评审人', dataIndex: 'reviewer', width: 90, render: (v) => v ?? '-' },
    {
      title: '退回原因',
      dataIndex: 'returnedReason',
      width: 150,
      render: (v: string | null) =>
        v ? (
          <span className="block truncate" title={v}>
            {v}
          </span>
        ) : (
          '-'
        ),
    },
    {
      title: '验收结论',
      dataIndex: 'acceptConclusion',
      width: 150,
      render: (v: string | null) =>
        v ? (
          <span className="block truncate" title={v}>
            {v}
          </span>
        ) : (
          '-'
        ),
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 160,
      render: (_, record) => (
        <div className="flex gap-1">
          {/* C-06：交付物验收单（已验收出正式验收单，未验收出待验收联） */}
          <PrintButton
            variant="ghost"
            size="sm"
            label="验收单"
            stopPropagation
            build={() => ({
              kind: 'deliverable_acceptance',
              code: record.code,
              title: '交付物验收单',
              subtitle: `交付物编号：${record.code}`,
              meta: compactFields([
                metaField('交付物名称', record.name),
                metaField('交付物类型', record.deliverableType),
                metaField('截止日期', record.dueDate),
                metaField(
                  '状态',
                  DELIVERABLE_STATUS_META[record.status].label,
                ),
                metaField('评审人', record.reviewer),
                metaField('提交日期', record.submittedAt?.slice(0, 10)),
                metaField('验收日期', record.acceptedAt?.slice(0, 10)),
              ]),
              tableTitle: '验收内容',
              columns: [
                { key: 'item', label: '项目' },
                { key: 'value', label: '内容' },
              ],
              rows: [
                {
                  cells: {
                    item: '验收标准',
                    value: record.acceptanceCriteria ?? '—',
                  },
                },
                {
                  cells: {
                    item: '验收结论',
                    value: record.acceptConclusion ?? '待验收',
                  },
                },
                {
                  cells: {
                    item: '退回原因',
                    value: record.returnedReason ?? '—',
                  },
                },
              ],
              clauses: [record.remark ? `备注：${record.remark}` : ''].filter(Boolean),
              signatures: [
                { slot: 'prepared', label: '交付人', signer: null },
                { slot: 'reviewed', label: '评审人', signer: record.reviewer ?? null },
                { slot: 'approved', label: '客户/项目负责人', signer: null },
              ],
              sourceNote: '数据来源：项目交付模块',
            })}
          />
          <CanCapabilityWrite capability="projects_write">
            <div className="flex gap-1">
              {record.status === 'pending' || record.status === 'returned' ? (
                <Button variant="ghost" size="sm" onClick={() => void submitDeliverableAction(record)}>
                  {record.status === 'returned' ? '重新提交' : '提交验收'}
                </Button>
              ) : null}
              {record.status === 'submitted' ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => openAcceptDeliverable(record)}>
                    通过
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => openReturnDeliverable(record)}>
                    退回
                  </Button>
                </>
              ) : null}
              {record.status === 'accepted' ? (
                <Button variant="ghost" size="sm" onClick={() => openAcceptDeliverable(record)}>
                  验收详情
                </Button>
              ) : null}
            </div>
          </CanCapabilityWrite>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <SectionTitle>项目交付物</SectionTitle>
        <CanCapabilityWrite capability="projects_write">
          <Button size="sm" variant="outline" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4" />
            添加交付物
          </Button>
        </CanCapabilityWrite>
      </div>
      <DataState loading={loading} error={error} skeleton="table">
        <Table
          columns={deliverableColumns}
          dataSource={deliverables}
          rowKey="id"
          scroll={{ x: 1320, y: 240 }}
          pagination={false}
          size="small"
          locale={{ emptyText: '暂无交付物' }}
        />
      </DataState>

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>添加交付物</DialogTitle>
          </DialogHeader>
          <Form {...deliverableForm}>
            <form onSubmit={onCreateDeliverable} className="space-y-4">
              <FormField
                control={deliverableForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      名称 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="如：数据交付报告" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={deliverableForm.control}
                name="deliverableType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>类型</FormLabel>
                    <FormControl>
                      <Input placeholder="如：文档 / 代码 / 模型 / 报告" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={deliverableForm.control}
                name="acceptanceCriteria"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>验收标准</FormLabel>
                    <FormControl>
                      <Textarea placeholder="请描述验收标准" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={deliverableForm.control}
                name="dueDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>截止日期</FormLabel>
                    <FormControl>
                      <Input
                        type="text"
                        placeholder="YYYY-MM-DD"
                        {...field}
                        value={field.value ?? ''}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={deliverableForm.control}
                name="reviewer"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>评审人</FormLabel>
                    <FormControl>
                      <Input placeholder="评审人" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={deliverableForm.control}
                name="remark"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>备注</FormLabel>
                    <FormControl>
                      <Input placeholder="备注" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="submit">保存</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={returnOpen} onOpenChange={setReturnOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>退回交付物</DialogTitle>
          </DialogHeader>
          <Form {...deliverableReturnForm}>
            <form onSubmit={onReturnDeliverable} className="space-y-4">
              <FormField
                control={deliverableReturnForm.control}
                name="reason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      退回原因 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Textarea placeholder="请填写退回原因" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="submit">确认退回</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={acceptTarget !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setAcceptTarget(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>验收交付物 - {acceptTarget?.name ?? ''}</DialogTitle>
          </DialogHeader>
          {acceptTarget ? (
            <div className="space-y-4">
              {acceptTarget.status === 'accepted' ? (
                <div className="space-y-3">
                  <div>
                    <p className="text-sm font-medium">验收结论</p>
                    <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                      {acceptTarget.acceptConclusion ?? '-'}
                    </p>
                  </div>
                  <div>
                    <p className="text-sm font-medium">验收日期</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {acceptTarget.acceptedAt ? acceptTarget.acceptedAt.slice(0, 10) : '-'}
                    </p>
                  </div>
                </div>
              ) : (
                <Form {...deliverableAcceptForm}>
                  <form onSubmit={onAcceptDeliverable} className="space-y-4">
                    <FormField
                      control={deliverableAcceptForm.control}
                      name="conclusion"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>验收结论</FormLabel>
                          <FormControl>
                            <Textarea
                              placeholder="如：数据质量达标，客户确认通过"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={deliverableAcceptForm.control}
                      name="acceptDate"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>验收日期</FormLabel>
                          <DateField value={field.value} onChange={field.onChange} />
                          <p className="text-xs text-muted-foreground">
                            仅作提示，验收日期由后端按当日记录
                          </p>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <DialogFooter>
                      <Button type="submit">确认通过</Button>
                    </DialogFooter>
                  </form>
                </Form>
              )}
              <div className="space-y-2">
                <p className="text-sm font-medium">验收附件</p>
                <AttachmentField
                  resourceType="erp_deliverable"
                  resourceId={acceptTarget.id}
                  usageHint="客户验收单扫描件、云文档链接"
                />
              </div>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default DeliverableSection;
