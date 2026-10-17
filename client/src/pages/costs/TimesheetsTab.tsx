import React, { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Download, History, Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { logger } from '@client/src/platform/logger';
import DateField from '@client/src/components/erp/DateField';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { todayIso } from '@client/src/utils/format';
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
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { costsApi, feishuSyncApi, hrApi, masterDataApi, projectsApi } from '@client/src/api';
import FeishuSyncRecordsDialog from '@client/src/components/erp/FeishuSyncRecordsDialog';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import {
  activeEmployeesOf,
  effectiveRoleName,
  isRoleLocked,
  pickableEmployees,
  roleNameForEmployee,
} from './timesheet-employee';
import {
  timesheetSchema,
  type TimesheetFormData,
  type TimesheetFormInput,
} from './timesheet-form';
import { TIMESHEET_STATUS_LABELS } from '@client/src/utils/biz-labels';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import type {
  CreateTimesheetDto,
  Employee,
  LaborRate,
  Project,
  Timesheet,
  TimesheetAction,
} from '@shared/api.interface';

/*
 * ⚠️ §5.9 已知超标项（本文件约 510 行，门槛 500）—— **有意保留，不是漏拆**。
 *
 * 已做的拆分：schema / 类型 → `./timesheet-form`；员工可选集合、角色锁定等
 * 纯规则 → `./timesheet-employee`（两者都有 spec）。剩下的 510 行里，
 * **约 170 行是「登记工时」弹窗的 JSX**，它是唯一还能再拆的块。
 *
 * 之所以不拆，是一条实测教训：我按"把弹窗整体搬成自包含组件"的思路写过一版，
 * 写完才发现主文件里的员工字段**比我记忆中的实现更完整** —— 它带有
 * `（本人绑定员工）` 兜底文案、姓名后附工号、`暂无在职员工` 空态、以及
 * 解释"为何只读"的 `title`。若按我那版替换，这些都会**静默丢失**。
 *
 * 也就是说：这个弹窗需要的不是"搬走"，而是"把员工字段那段额外的展示逻辑
 * 一起搬走"。那属于带行为改动的重构，风险与收益不成比例（当前仅超门槛 10 行、
 * 且 §5.9 的门槛是**收益判据而非硬性红线** —— 本文件已无可单测的纯逻辑可搬）。
 *
 * 若将来要拆，正确做法是：先把员工字段那段（只读分支 + 三个兜底文案）
 * 抄全，再搬；搬完必须跑 `verify-costs-actions.mjs` 一类的行为复验，
 * 不能只看"页面能打开"。
 */

const TimesheetsTab: React.FC = () => {
  const [projectFilter, setProjectFilter] = useState('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [recordsOpen, setRecordsOpen] = useState(false);
  /**
   * 当前账号**绑定的员工 id**（未绑定为 null）。
   *
   * 为什么必须知道它：服务端 `CostsService.createTimesheet` 解析员工的顺序是
   *   ① 先按 `feishu_union_id / platform_user_id` 找**当前账号绑定的员工**；
   *   ② 只有**①没找到**（即本人未绑定员工）时，才用请求体里的 `employeeId` 代登。
   * 也就是说：本人已绑定员工时，`employeeId` 会被**忽略**。
   * 而原实现把员工下拉列成"全部在职员工"并允许任意选择 —— 提交后库里记的却是
   * 本人那一条，界面上完全看不出来（toast 照报成功）。
   * 现在：本人已绑定时把员工锁定为本人（只读展示），未绑定（管理员代登场景）
   * 才放开选择，与服务端口径一致。
   */
  const [boundEmployeeId, setBoundEmployeeId] = useState<string | null>(null);

  const { data, loading, error, reload } = useAsyncData<Timesheet[]>(
    () => costsApi.listTimesheets(projectFilter !== 'all' ? projectFilter : undefined),
    [projectFilter],
  );
  const { data: projects } = useAsyncData<Project[]>(() => projectsApi.listProjects(), []);
  const { data: rates } = useAsyncData<LaborRate[]>(() => costsApi.listLaborRates(), []);
  const { data: employees } = useAsyncData<Employee[]>(
    () => masterDataApi.listEmployees(),
    [],
  );
  const activeEmployees: Employee[] = activeEmployeesOf(employees);
  /**
   * 本人已绑定 → 只能报本人；未绑定 → 允许代登（服务端同样只在此时接受 employeeId）。
   * 判据与注释见 `./timesheet-employee.ts`。
   */
  const pickable: Employee[] = pickableEmployees(activeEmployees, boundEmployeeId);

  const form = useForm<TimesheetFormInput, unknown, TimesheetFormData>({
    resolver: zodResolver(timesheetSchema),
    defaultValues: {
      projectId: '',
      employeeId: '',
      roleName: '',
      workDate: todayIso(),
      hours: 8,
      remark: '',
    },
  });

  const selectedEmployeeId = form.watch('employeeId');
  /*
   * ⚠️ 这里曾有 `const selectedEmployee = activeEmployees.find(...)`，但它**从未被使用**
   * （只读不用的死代码，每次渲染还白跑一次 find）。删掉不留注释残留 —— 若将来
   * 需要"当前选中员工"的对象，请连同它的用途一起加回来。
   */
  const roleLocked = isRoleLocked(activeEmployees, selectedEmployeeId);

  const onEmployeeChange = (id: string, employee?: Employee) => {
    form.setValue('employeeId', id);
    form.setValue(
      'roleName',
      employee ? employee.roleName ?? '' : roleNameForEmployee(activeEmployees, id),
    );
  };

  /**
   * 打开登记工时对话框时解析「当前账号绑定的员工」。
   *
   * 两件事一起做，不能只做一件：
   *   ① 已绑定 → 带出该员工（原行为）；
   *   ② **记住这个绑定**，用来把员工下拉锁成只读 —— 否则用户在下拉里选别人，
   *      提交后服务端仍按绑定员工落库（`costs.service.ts` 的解析顺序），
   *      出现"选了 A、记了 B"而界面毫无提示。未绑定时保持可代登。
   */
  useEffect(() => {
    if (!createOpen) return undefined;
    let cancelled = false;
    hrApi
      .fetchMyEmployee()
      .then((emp: Employee | null) => {
        if (cancelled) return;
        setBoundEmployeeId(emp?.id ?? null);
        if (!emp) return;
        form.setValue('employeeId', emp.id, { shouldValidate: true });
        form.setValue('roleName', emp.roleName ?? '');
      })
      .catch((err: unknown) => {
        logger.warn('获取当前用户绑定员工失败，员工字段保持为空', err);
      });
    return () => {
      cancelled = true;
    };
  }, [createOpen, form]);

  const onSubmit = form.handleSubmit(async (values) => {
    const employee = activeEmployees.find(
      (e: Employee) => e.id === values.employeeId,
    );
    const dto: CreateTimesheetDto = {
      projectId: values.projectId,
      employeeId: values.employeeId,
      employeeName: employee?.name ?? '',
      // 岗位角色优先，与服务端 `employee.roleName || dto.roleName` 同口径
      roleName: effectiveRoleName(activeEmployees, values.employeeId, values.roleName),
      workDate: values.workDate,
      hours: values.hours,
      remark: values.remark || undefined,
    };
    try {
      await costsApi.createTimesheet(dto);
      toast.success('工时已登记');
      setCreateOpen(false);
      form.reset({
        projectId: '',
        employeeId: '',
        roleName: '',
        workDate: todayIso(),
        hours: 8,
        remark: '',
      });
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '登记失败');
    }
  });

  const handleImportFromBase = async () => {
    setImporting(true);
    try {
      const result = await feishuSyncApi.syncTimesheetsFromBase();
      if (result.failed > 0) {
        toast.error(result.message);
      } else {
        toast.success(result.message);
      }
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '从多维表格导入工时失败'));
    } finally {
      setImporting(false);
    }
  };

  const doAction = async (ts: Timesheet, action: TimesheetAction) => {
    if (action === 'reject') {
      const ok = await confirmDanger(
        `确认退回工时 ${ts.code}？`,
        { title: '确认退回', confirmLabel: '确认退回' },
      );
      if (!ok) return;
    }
    try {
      await costsApi.timesheetAction(ts.id, action);
      toast.success(action === 'confirm' ? '工时已确认并折算成本' : '操作成功');
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const columns: TableColumnsType<Timesheet> = [
    { title: '工时编号', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '项目', dataIndex: 'projectName', width: 180 },
    { title: '员工', dataIndex: 'employeeName', width: 100 },
    { title: '角色', dataIndex: 'roleName', width: 110, render: (v) => v ?? '-' },
    { title: '工作日期', dataIndex: 'workDate', width: 110, render: (v) => v ?? '-' },
    { title: '工时（h）', dataIndex: 'hours', width: 90 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => <StatusBadge status={s} labels={TIMESHEET_STATUS_LABELS} />,
    },
    {
      title: '已折算成本',
      dataIndex: 'costGenerated',
      width: 100,
      render: (v: boolean) => (v ? '是' : '否'),
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 150,
      render: (_, record) => (
        <div className="flex gap-1">
          {record.status === 'draft' ? (
            <Button variant="ghost" size="sm" onClick={() => void doAction(record, 'submit')}>
              提交
            </Button>
          ) : null}
          {record.status === 'submitted' ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => void doAction(record, 'confirm')}>
                确认
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void doAction(record, 'reject')}>
                退回
              </Button>
            </>
          ) : null}
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Label htmlFor="ts-project-filter">项目</Label>
          <Select value={projectFilter} onValueChange={setProjectFilter}>
            <SelectTrigger id="ts-project-filter" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部项目</SelectItem>
              {(projects ?? []).map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4" />
          登记工时
        </Button>
        <Button
          variant="outline"
          disabled={importing}
          onClick={() => void handleImportFromBase()}
          aria-label="从多维表格导入工时"
        >
          <Download className="h-4 w-4" />
          {importing ? '导入中…' : '从多维表格导入工时'}
        </Button>
        <Button
          variant="outline"
          onClick={() => setRecordsOpen(true)}
          aria-label="查看同步记录"
        >
          <History className="h-4 w-4" />
          同步记录
        </Button>
      </div>
      {error ? (
        <p className="text-sm text-destructive">
          {error}
          <Button variant="ghost" size="sm" className="ml-2" onClick={() => void reload()}>
            重试
          </Button>
        </p>
      ) : null}
      <Table
        columns={columns}
        dataSource={data ?? []}
        loading={loading}
        rowKey="id"
        scroll={{ x: 1200, y: 500 }}
        pagination={{
          pageSize: 10,
          showTotal: (total: number) => `共 ${total} 条`,
        }}
        locale={{ emptyText: '暂无工时记录，点击右上角「登记工时」创建' }}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>登记工时</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <FormField
                control={form.control}
                name="projectId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      项目 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择项目" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(projects ?? []).map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="employeeId"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        员工 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      {boundEmployeeId ? (
                        /*
                         * 本人已绑定员工 → 服务端只会按绑定员工落库，代登在此场景**无效**。
                         * 因此展示只读值而不是可选下拉，从界面上杜绝"选了 A、记了 B"。
                         */
                        <FormControl>
                          <Input
                            value={
                              activeEmployees.find(
                                (e: Employee) => e.id === field.value,
                              )?.name ?? '（本人绑定员工）'
                            }
                            readOnly
                            aria-readonly="true"
                            title="工时只能登记到本人绑定的员工档案；如需代登，请使用未绑定员工的账号"
                          />
                        </FormControl>
                      ) : (
                        <Select
                          value={field.value}
                          onValueChange={(id: string) => onEmployeeChange(id)}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="请选择员工" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {pickable.length === 0 ? (
                              <SelectItem value="empty" disabled>
                                暂无在职员工
                              </SelectItem>
                            ) : (
                              pickable.map((e: Employee) => (
                                <SelectItem key={e.id} value={e.id}>
                                  {e.name}（{e.code}）
                                </SelectItem>
                              ))
                            )}
                          </SelectContent>
                        </Select>
                      )}
                      <FormMessage />
                    </FormItem>
                  )}
                />
              <FormField
                control={form.control}
                name="roleName"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      角色 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    {roleLocked ? (
                      <FormControl>
                        <Input value={field.value ?? ''} readOnly aria-readonly="true" />
                      </FormControl>
                    ) : (
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择角色" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(rates ?? []).map((r) => (
                            <SelectItem key={r.id} value={r.roleName}>
                              {r.roleName}（{r.rate}/人天）
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                    <FormMessage />
                  </FormItem>
                )}
              />
              </div>
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="workDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        工作日期 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <DateField value={field.value} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="hours"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        工时（h） <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0.5}
                          max={24}
                          step={0.5}
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
              <DialogFooter>
                <Button type="submit">保存</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <FeishuSyncRecordsDialog
        open={recordsOpen}
        onOpenChange={setRecordsOpen}
        direction="inbound"
        bizType="timesheet"
      />
    </div>
  );
};

export default TimesheetsTab;
