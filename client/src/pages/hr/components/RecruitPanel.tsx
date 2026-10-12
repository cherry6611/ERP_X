import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus, Users } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import HrStatusBadge, { CANDIDATE_STAGE_LABELS, RECRUIT_STATUS_LABELS } from './HrStatusBadge';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { hrApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import type {
  Candidate,
  CandidateAction,
  CreateCandidateDto,
  CreateRecruitReqDto,
  Department,
  RecruitReq,
} from '@shared/api.interface';

const reqSchema = z.object({
  title: z.string().min(1, '请填写招聘岗位'),
  departmentId: z.string(),
  headcount: z.coerce.number().min(1, 'HC 必须大于 0'),
  remark: z.string(),
});

const candidateSchema = z.object({
  name: z.string().min(1, '请填写候选人姓名'),
  phone: z.string(),
  remark: z.string(),
});

const NEXT_ACTION_LABEL: Partial<Record<CandidateAction, string>> = {
  interview: '安排面试',
  offer: '发 offer',
  hired: '确认入职',
};

const RecruitPanel: React.FC = () => {
  const [reqOpen, setReqOpen] = useState(false);
  const [candidateOpen, setCandidateOpen] = useState(false);
  const [selectedReq, setSelectedReq] = useState<RecruitReq | null>(null);
  const [operating, setOperating] = useState(false);

  const { data: reqs, loading: reqLoading, error: reqError, reload: reloadReqs } =
    useAsyncData<RecruitReq[]>(() => hrApi.listRecruitReqs(), []);
  const { data: candidates, loading: candLoading, error: candError, reload: reloadCands } =
    useAsyncData<Candidate[]>(
      () => hrApi.listCandidates(selectedReq ? selectedReq.id : undefined),
      [selectedReq?.id],
    );
  const { data: departments } = useAsyncData<Department[]>(() => hrApi.listDepartments(), []);

  const reqForm = useForm<
    z.input<typeof reqSchema>,
    unknown,
    z.output<typeof reqSchema>
  >({
    resolver: zodResolver(reqSchema),
    defaultValues: { title: '', departmentId: '', headcount: 1, remark: '' },
  });

  const candidateForm = useForm<
    z.input<typeof candidateSchema>,
    unknown,
    z.output<typeof candidateSchema>
  >({
    resolver: zodResolver(candidateSchema),
    defaultValues: { name: '', phone: '', remark: '' },
  });

  const onReqSubmit = reqForm.handleSubmit(async (values) => {
    const dto: CreateRecruitReqDto = {
      title: values.title,
      departmentId: values.departmentId || undefined,
      headcount: values.headcount,
      remark: values.remark || undefined,
    };
    setOperating(true);
    try {
      await hrApi.createRecruitReq(dto);
      toast.success('招聘需求已创建');
      setReqOpen(false);
      reqForm.reset({ title: '', departmentId: '', headcount: 1, remark: '' });
      await reloadReqs();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败');
    } finally {
      setOperating(false);
    }
  });

  const onCandidateSubmit = candidateForm.handleSubmit(async (values) => {
    if (!selectedReq) return;
    const dto: CreateCandidateDto = {
      recruitReqId: selectedReq.id,
      name: values.name,
      phone: values.phone || undefined,
      remark: values.remark || undefined,
    };
    setOperating(true);
    try {
      await hrApi.createCandidate(dto);
      toast.success('候选人已添加');
      setCandidateOpen(false);
      candidateForm.reset({ name: '', phone: '', remark: '' });
      await reloadCands();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '添加失败');
    } finally {
      setOperating(false);
    }
  });

  const doCandidateAction = async (cand: Candidate, action: CandidateAction) => {
    try {
      await hrApi.candidateAction(cand.id, action);
      toast.success(action === 'rejected' ? '已淘汰' : `已${NEXT_ACTION_LABEL[action] ?? '流转'}`);
      await reloadCands();
      await reloadReqs();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const reqColumns: TableColumnsType<RecruitReq> = [
    { title: '需求编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '部门', dataIndex: 'departmentName', width: 140, render: (v) => v ?? '-' },
    { title: '岗位', dataIndex: 'title', width: 180 },
    { title: 'HC', dataIndex: 'headcount', width: 70 },
    { title: '已入职', dataIndex: 'hiredCount', width: 80 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => <HrStatusBadge status={s} labels={RECRUIT_STATUS_LABELS} />,
    },
    { title: '备注', dataIndex: 'remark', width: 180, render: (v) => v ?? '-' },
    {
      title: '操作',
      key: 'action',
      width: 130,
      render: (_: unknown, record: RecruitReq) => (
        <Button
          variant={selectedReq?.id === record.id ? 'default' : 'ghost'}
          size="sm"
          onClick={() => setSelectedReq(record)}
        >
          <Users className="h-4 w-4" />
          候选人
        </Button>
      ),
    },
  ];

  const candidateColumns: TableColumnsType<Candidate> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '姓名', dataIndex: 'name', width: 110 },
    { title: '电话', dataIndex: 'phone', width: 130, render: (v) => v ?? '-' },
    {
      title: '阶段',
      dataIndex: 'stage',
      width: 110,
      render: (s: string) => <HrStatusBadge status={s} labels={CANDIDATE_STAGE_LABELS} />,
    },
    { title: '备注', dataIndex: 'remark', width: 160, render: (v) => v ?? '-' },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_: unknown, record: Candidate) => (
        <div className="flex gap-1">
          {record.stage === 'pending' ? (
            <CanRole roles={['admin']}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void doCandidateAction(record, 'interview')}
              >
                安排面试
              </Button>
            </CanRole>
          ) : null}
          {record.stage === 'interview' ? (
            <CanRole roles={['admin']}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void doCandidateAction(record, 'offer')}
              >
                发 offer
              </Button>
            </CanRole>
          ) : null}
          {record.stage === 'offer' ? (
            <CanRole roles={['admin']}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void doCandidateAction(record, 'hired')}
              >
                确认入职
              </Button>
            </CanRole>
          ) : null}
          {record.stage !== 'hired' && record.stage !== 'rejected' ? (
            <CanRole roles={['admin']}>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() => void doCandidateAction(record, 'rejected')}
              >
                淘汰
              </Button>
            </CanRole>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold">招聘需求</h3>
          <CanRole roles={['admin']}>
            <Button onClick={() => setReqOpen(true)}>
              <Plus className="h-4 w-4" />
              新建需求
            </Button>
          </CanRole>
        </div>
        {reqError ? (
          <p className="text-sm text-destructive">
            {reqError}
            <Button variant="ghost" size="sm" className="ml-2" onClick={() => void reloadReqs()}>
              重试
            </Button>
          </p>
        ) : null}
        <Table
          columns={reqColumns}
          dataSource={reqs ?? []}
          loading={reqLoading}
          rowKey="id"
          scroll={{ x: 1000, y: 360 }}
          pagination={{
            pageSize: 10,
            showTotal: (t: number) => `共 ${t} 条`,
          }}
          locale={{ emptyText: '暂无招聘需求，点击右上角新建需求' }}
        />
      </section>

      <section className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-base font-semibold">
            候选人列表
            {selectedReq ? (
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {selectedReq.code} - {selectedReq.title}
              </span>
            ) : null}
          </h3>
          <CanRole roles={['admin']}>
            <Button disabled={!selectedReq} onClick={() => setCandidateOpen(true)}>
              <Plus className="h-4 w-4" />
              添加候选人
            </Button>
          </CanRole>
        </div>
        {selectedReq ? (
          <>
            {candError ? (
              <p className="text-sm text-destructive">
                {candError}
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-2"
                  onClick={() => void reloadCands()}
                >
                  重试
                </Button>
              </p>
            ) : null}
            <Table
              columns={candidateColumns}
              dataSource={candidates ?? []}
              loading={candLoading}
              rowKey="id"
              scroll={{ x: 800, y: 320 }}
              pagination={{
                pageSize: 10,
                showTotal: (t: number) => `共 ${t} 条`,
              }}
              locale={{ emptyText: '该需求暂无候选人，点击右上角添加候选人' }}
            />
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            请在上方需求列表点击「候选人」查看对应候选人
          </p>
        )}
      </section>

      <Dialog open={reqOpen} onOpenChange={setReqOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>新建招聘需求</DialogTitle>
          </DialogHeader>
          <Form {...reqForm}>
            <form onSubmit={onReqSubmit} className="space-y-4">
              <FormField
                control={reqForm.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      招聘岗位 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="如：数据工程师" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex gap-4">
                <FormField
                  control={reqForm.control}
                  name="departmentId"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>部门</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择部门" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(departments ?? []).map((d: Department) => (
                            <SelectItem key={d.id} value={d.id}>
                              {d.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={reqForm.control}
                  name="headcount"
                  render={({ field }) => (
                    <FormItem className="w-28">
                      <FormLabel>
                        HC <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={1}
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
              </div>
              <FormField
                control={reqForm.control}
                name="remark"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>备注</FormLabel>
                    <FormControl>
                      <Input placeholder="需求说明" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="submit" disabled={operating}>
                  保存
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={candidateOpen} onOpenChange={setCandidateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>添加候选人</DialogTitle>
          </DialogHeader>
          <Form {...candidateForm}>
            <form onSubmit={onCandidateSubmit} className="space-y-4">
              <FormField
                control={candidateForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      姓名 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="候选人姓名" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={candidateForm.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>电话</FormLabel>
                    <FormControl>
                      <Input placeholder="联系电话" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={candidateForm.control}
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
                <Button type="submit" disabled={operating}>
                  保存
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default RecruitPanel;
