/*
 * §5.9（F8）：本文件原先自带的三段 `<Dialog>`（添加 / 退回 / 验收）已拆到
 * `./dialogs/`，各自的 schema 随弹窗文件同行。
 *
 * 搬走的理由是体量：占行数的从来不是声明，而是**三段弹窗 JSX + 三个提交处理器 +
 * 三个 schema**（约 250 行）。本文件现在只保留区块级编排：数据查询
 * （`projectsApi.getProject`）、表格列定义、三个弹窗的 open state 与触发处理器。
 *
 * ⚠️ 两个重置时机**语义不同**，搬迁时逐条核对过，**没有**统一、也没有新增：
 *   · 「添加」**没有** reset-on-open，重置在提交成功之后（`setAddOpen(false)` →
 *     `reset` → 重取）—— 故它的 `useForm` 随弹窗一起搬走；父组件无条件挂载
 *     该弹窗，表单状态因此像原实现一样跨开关存活；
 *   · 「退回」「验收」**在打开弹窗时**重置，触发点就是下面
 *     `openReturnDeliverable` / `openAcceptDeliverable` 里那两行 `reset(...)`
 *     （验收还按行数据预填验收结论与当天日期）—— 触发点在父组件，故这两个
 *     `useForm` 实例留在父组件，以下沉的同名 props（`deliverableReturnForm` /
 *     `deliverableAcceptForm` 及各自的 `handleSubmit` 结果）传给弹窗，
 *     而不是搬进子组件后用 `useEffect` 复现。
 *   · 三个弹窗仍**无条件挂载**（只切 `open` prop），不写成 `{open && <… />}`：
 *     条件挂载会在关闭时立刻卸载 Radix 内容（跳过退场动画），也会丢掉「添加」
 *     弹窗跨开关保留的输入。
 */

import React, { useCallback, useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import { DataState } from '@client/src/components/DataState';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { projectsApi } from '@client/src/api';
import { PrintButton } from '@client/src/components/print';
import { compactFields, metaField } from '@client/src/components/print';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type {
  DeliverableItem,
  DeliverableStatus,
} from '@shared/api.interface';
import AddDeliverableDialog from './dialogs/AddDeliverableDialog';
import ReturnDeliverableDialog, {
  deliverableReturnSchema,
  type DeliverableReturnFormData,
} from './dialogs/ReturnDeliverableDialog';
import AcceptDeliverableDialog, {
  deliverableAcceptSchema,
  type DeliverableAcceptFormData,
} from './dialogs/AcceptDeliverableDialog';

const DELIVERABLE_STATUS_META: Record<
  DeliverableStatus,
  { label: string; variant: 'secondary' | 'warning' | 'success' | 'destructive' }
> = {
  pending: { label: '待交付', variant: 'secondary' },
  submitted: { label: '待验收', variant: 'warning' },
  accepted: { label: '已验收', variant: 'success' },
  returned: { label: '已退回', variant: 'destructive' },
};

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

      <AddDeliverableDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        projectId={projectId}
        onSaved={refresh}
      />

      <ReturnDeliverableDialog
        open={returnOpen}
        onOpenChange={setReturnOpen}
        deliverableReturnForm={deliverableReturnForm}
        onReturnDeliverable={onReturnDeliverable}
      />

      <AcceptDeliverableDialog
        open={acceptTarget !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setAcceptTarget(null);
        }}
        acceptTarget={acceptTarget}
        deliverableAcceptForm={deliverableAcceptForm}
        onAcceptDeliverable={onAcceptDeliverable}
      />
    </div>
  );
};

export default DeliverableSection;
