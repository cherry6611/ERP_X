import React, { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Download, Plus, Upload } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import DateField from '@client/src/components/erp/DateField';
import HrStatusBadge, {
  EMPLOYEE_STATUS_LABELS,
  EMPLOYMENT_TYPE_LABELS,
} from './HrStatusBadge';
import { ExcelImportDialog } from '@client/src/components/excel/ExcelImportDialog';
import type {
  ExcelImportColumnDef,
  ParsedRowResult,
} from '@client/src/components/excel/ExcelImportDialog';
import {
  exportRowsToXlsx,
  type ExcelSheetColumn,
} from '@client/src/components/excel/excel-utils';
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
import { UserSelect } from '@client/src/components/business-ui/user-select';
import { UserDisplay } from '@client/src/components/business-ui/user-display';
import { hrApi, masterDataApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { useListQuery } from '@client/src/hooks/useListQuery';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import type {
  CreateEmployeeDto,
  Department,
  Employee,
  HandoverProject,
  OffboardEmployeeDto,
  OffboardResult,
  Position,
  Supplier,
  UpdateEmployeeDto,
} from '@shared/api.interface';

const employeeSchema = z.object({
  name: z.string().min(1, '请填写姓名'),
  departmentId: z.string(),
  positionId: z.string(),
  hireDate: z.string(),
  employmentType: z.string(),
  phone: z.string(),
  platformUserId: z.string(),
  supplierId: z.string(),
  ssCityCode: z.string(),
  ssBase: z.string(),
  status: z.string().min(1, '请选择状态'),
});

type EmployeeFormData = z.output<typeof employeeSchema>;
type EmployeeFormInput = z.input<typeof employeeSchema>;

const EMPTY_FORM: EmployeeFormInput = {
  name: '',
  departmentId: '',
  positionId: '',
  hireDate: '',
  employmentType: 'full_time',
  phone: '',
  platformUserId: '',
  supplierId: '',
  ssCityCode: '',
  ssBase: '',
  status: 'probation',
};

const EMPLOYEE_STATUS_TO_CODE: Record<string, string> = {
  probation: 'probation',
  active: 'active',
  resigned: 'resigned',
  试用期: 'probation',
  在职: 'active',
  已离职: 'resigned',
};

const EMPLOYMENT_TYPE_TO_CODE: Record<string, string> = {
  full_time: 'full_time',
  part_time: 'part_time',
  flex: 'flex',
  intern: 'intern',
  dispatch: 'dispatch',
  全职: 'full_time',
  兼职: 'part_time',
  灵活用工: 'flex',
  实习: 'intern',
  劳务派遣: 'dispatch',
};

const EMPLOYEE_IMPORT_COLUMNS: ExcelImportColumnDef[] = [
  { header: '姓名', required: true },
  { header: '部门' },
  { header: '岗位' },
  { header: '入职日期' },
  { header: '用工类型' },
  { header: '状态' },
  { header: '手机号' },
  { header: '备注' },
];

const EMPLOYEE_EXPORT_COLUMNS: ExcelSheetColumn<Employee>[] = [
  { header: '编号', value: (row: Employee) => row.code },
  { header: '姓名', value: (row: Employee) => row.name },
  { header: '部门', value: (row: Employee) => row.departmentName ?? '' },
  { header: '岗位', value: (row: Employee) => row.position ?? '' },
  { header: '入职日期', value: (row: Employee) => row.hireDate ?? '' },
  {
    header: '用工类型',
    value: (row: Employee) =>
      (row.employmentType && EMPLOYMENT_TYPE_LABELS[row.employmentType]) ||
      row.employmentType ||
      '',
  },
  {
    header: '状态',
    value: (row: Employee) => EMPLOYEE_STATUS_LABELS[row.status] ?? row.status,
  },
  { header: '手机号', value: (row: Employee) => row.phone ?? '' },
];

/** 将一行 Excel 原始数据映射为创建 DTO，部门/岗位按名称映射为 ID */
function parseEmployeeRow(
  raw: Record<string, string>,
  departmentByName: Map<string, string>,
  positionByName: Map<string, string>,
): ParsedRowResult<CreateEmployeeDto> {
  const errors: string[] = [];
  const name: string = (raw['姓名'] ?? '').trim();
  if (!name) errors.push('姓名不能为空');

  const departmentName: string = (raw['部门'] ?? '').trim();
  let departmentId: string | undefined;
  if (departmentName) {
    const matched: string | undefined = departmentByName.get(departmentName);
    if (matched) {
      departmentId = matched;
    } else {
      errors.push(`部门「${departmentName}」不存在`);
    }
  }

  const positionName: string = (raw['岗位'] ?? '').trim();
  let positionId: string | undefined;
  if (positionName) {
    const matched: string | undefined = positionByName.get(positionName);
    if (matched) {
      positionId = matched;
    } else {
      errors.push(`岗位「${positionName}」不存在`);
    }
  }

  const hireDateRaw: string = (raw['入职日期'] ?? '').trim();
  let hireDate: string | undefined;
  if (hireDateRaw) {
    const normalized: string = hireDateRaw.replace(/[/.]/g, '-');
    const matched: RegExpMatchArray | null = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (!matched) {
      errors.push('入职日期格式应为 YYYY-MM-DD');
    } else {
      hireDate = `${matched[1]}-${matched[2].padStart(2, '0')}-${matched[3].padStart(2, '0')}`;
    }
  }

  const employmentTypeRaw: string = (raw['用工类型'] ?? '').trim();
  let employmentType: string = 'full_time';
  if (employmentTypeRaw) {
    const mapped: string | undefined = EMPLOYMENT_TYPE_TO_CODE[employmentTypeRaw];
    if (mapped) {
      employmentType = mapped;
    } else {
      errors.push(`用工类型「${employmentTypeRaw}」无效，应为 全职/兼职/灵活用工/实习/劳务派遣`);
    }
  }

  const statusRaw: string = (raw['状态'] ?? '').trim();
  let status: string = 'probation';
  if (statusRaw) {
    const mapped: string | undefined = EMPLOYEE_STATUS_TO_CODE[statusRaw];
    if (mapped) {
      status = mapped;
    } else {
      errors.push(`状态「${statusRaw}」无效，应为 试用期/在职/已离职`);
    }
  }

  const phone: string = (raw['手机号'] ?? '').trim();
  const remark: string = (raw['备注'] ?? '').trim();

  if (errors.length > 0) return { dto: null, errors };
  return {
    dto: {
      name,
      departmentId,
      positionId,
      hireDate,
      employmentType,
      phone: phone || undefined,
      status,
      remark: remark || undefined,
    },
    errors: [],
  };
}

const EmployeePanel: React.FC = () => {
  const { q, setQ, debouncedQ, debouncing } = useListQuery();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Employee | null>(null);
  const [resignTarget, setResignTarget] = useState<Employee | null>(null);
  const [resignDate, setResignDate] = useState<string | undefined>(undefined);
  const [resignRemark, setResignRemark] = useState('');
  const [offboardResult, setOffboardResult] = useState<OffboardResult | null>(null);
  const [operating, setOperating] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const { data, loading, error, reload } = useAsyncData<Employee[]>(
    () => hrApi.listEmployees(debouncedQ || undefined),
    [debouncedQ],
  );
  const { data: departments } = useAsyncData<Department[]>(
    () => hrApi.listDepartments(),
    [],
  );
  const { data: positions } = useAsyncData<Position[]>(() => hrApi.listPositions(), []);
  const { data: suppliers } = useAsyncData<Supplier[]>(
    () => masterDataApi.listSuppliers(),
    [],
  );
  const employees = data;

  const departmentByName: Map<string, string> = new Map(
    (departments ?? []).map((d: Department) => [d.name, d.id]),
  );
  const positionByName: Map<string, string> = new Map(
    (positions ?? []).map((p: Position) => [p.name, p.id]),
  );

  const handleExport = () => {
    const rows: Employee[] = employees ?? [];
    if (rows.length === 0) {
      toast.error('当前列表为空，无可导出数据');
      return;
    }
    exportRowsToXlsx('员工列表.xlsx', '员工', EMPLOYEE_EXPORT_COLUMNS, rows);
  };

  const form = useForm<EmployeeFormInput, unknown, EmployeeFormData>({
    resolver: zodResolver(employeeSchema),
    defaultValues: EMPTY_FORM,
  });

  const employmentType: string = form.watch('employmentType');
  const isVendorEmployment: boolean =
    employmentType === 'part_time' || employmentType === 'flex';

  useEffect(() => {
    if (editTarget) {
      form.reset({
        name: editTarget.name,
        departmentId: editTarget.departmentId ?? '',
        positionId: editTarget.positionId ?? '',
        hireDate: editTarget.hireDate ?? '',
        employmentType: editTarget.employmentType ?? '',
        phone: editTarget.phone ?? '',
        platformUserId: editTarget.platformUserId ?? '',
        supplierId: editTarget.supplierId ?? '',
        ssCityCode: editTarget.ssCityCode ?? '',
        ssBase: editTarget.ssBase != null ? String(editTarget.ssBase) : '',
        status: editTarget.status,
      });
    }
  }, [editTarget, form]);

  const toCreateDto = (values: EmployeeFormData): CreateEmployeeDto => ({
    name: values.name,
    departmentId: values.departmentId || undefined,
    positionId: values.positionId || undefined,
    hireDate: values.hireDate || undefined,
    employmentType: values.employmentType || undefined,
    phone: values.phone || undefined,
    platformUserId: values.platformUserId || undefined,
    supplierId: isVendorEmployment ? values.supplierId || undefined : undefined,
    ssCityCode: values.ssCityCode || undefined,
    ssBase: values.ssBase !== '' ? Number(values.ssBase) : undefined,
    status: values.status,
  });

  const toUpdateDto = (values: EmployeeFormData): UpdateEmployeeDto => ({
    name: values.name,
    departmentId: values.departmentId || undefined,
    positionId: values.positionId || undefined,
    hireDate: values.hireDate || undefined,
    employmentType: values.employmentType || undefined,
    phone: values.phone || undefined,
    platformUserId: values.platformUserId,
    supplierId: isVendorEmployment ? values.supplierId || null : null,
    ssCityCode: values.ssCityCode || null,
    ssBase: values.ssBase !== '' ? Number(values.ssBase) : null,
    status: values.status,
  });

  const onCreate = form.handleSubmit(async (values) => {
    setOperating(true);
    try {
      await hrApi.createEmployee(toCreateDto(values));
      toast.success('员工已创建');
      setCreateOpen(false);
      form.reset(EMPTY_FORM);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建失败');
    } finally {
      setOperating(false);
    }
  });

  const onUpdate = form.handleSubmit(async (values) => {
    if (!editTarget) return;
    setOperating(true);
    try {
      await hrApi.updateEmployee(editTarget.id, toUpdateDto(values));
      toast.success('员工信息已更新');
      setEditTarget(null);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失败');
    } finally {
      setOperating(false);
    }
  });

  const doConfirm = async (emp: Employee) => {
    try {
      await hrApi.updateEmployee(emp.id, { status: 'active' });
      toast.success(`${emp.name} 已转正`);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    }
  };

  const toggleActive = async (emp: Employee) => {
    const next: 'active' | 'inactive' =
      emp.status === 'inactive' ? 'active' : 'inactive';
    if (next === 'inactive') {
      const ok = await confirmDanger(
        `确认停用员工 ${emp.name}？停用后不可用于新派工。`,
        { title: '确认停用' },
      );
      if (!ok) return;
    }
    try {
      await hrApi.setEmployeeStatus(emp.id, next);
      toast.success(
        next === 'inactive' ? `${emp.name} 已停用` : `${emp.name} 已启用`
      );
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '状态更新失败');
    }
  };

  const resetOffboardDialog = () => {
    setResignTarget(null);
    setResignDate(undefined);
    setResignRemark('');
    setOffboardResult(null);
  };

  const doOffboard = async () => {
    if (!resignTarget) return;
    if (!resignDate) {
      toast.error('请选择离职日期');
      return;
    }
    setOperating(true);
    try {
      const dto: OffboardEmployeeDto = {
        resignDate,
        remark: resignRemark.trim() || undefined,
      };
      const result = await hrApi.offboardEmployee(resignTarget.id, dto);
      if (result.handoverProjects.length === 0) {
        toast.success('离职手续已办理');
        resetOffboardDialog();
      } else {
        setOffboardResult(result);
        toast.success(`办理成功，待交接项目 ${result.handoverProjects.length} 个`);
      }
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '操作失败');
    } finally {
      setOperating(false);
    }
  };

  const columns: TableColumnsType<Employee> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 130 },
    { title: '姓名', dataIndex: 'name', width: 100 },
    { title: '部门', dataIndex: 'departmentName', width: 130, render: (v) => v ?? '-' },
    { title: '岗位', dataIndex: 'position', width: 130, render: (v) => v ?? '-' },
    { title: '角色', dataIndex: 'roleName', width: 110, render: (v) => v ?? '-' },
    { title: '入职日期', dataIndex: 'hireDate', width: 110, render: (v) => v ?? '-' },
    {
      title: '用工类型',
      dataIndex: 'employmentType',
      width: 100,
      render: (v: string | null) =>
        (v && EMPLOYMENT_TYPE_LABELS[v]) || v || '-',
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => (
        <HrStatusBadge status={s} labels={EMPLOYEE_STATUS_LABELS} />
      ),
    },
    {
      title: '飞书账号',
      dataIndex: 'platformUserId',
      width: 140,
      render: (v: string | null) =>
        v ? <UserDisplay value={[v]} size="small" /> : '-',
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_: unknown, record: Employee) => (
        <CanRole roles={['admin']}>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setEditTarget(record)}
            >
              编辑
            </Button>
            {record.status === 'probation' ? (
              <Button variant="ghost" size="sm" onClick={() => void doConfirm(record)}>
                转正
              </Button>
            ) : null}
            {record.status === 'active' || record.status === 'inactive' ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void toggleActive(record)}
              >
                {record.status === 'inactive' ? '启用' : '停用'}
              </Button>
            ) : null}
            {record.status !== 'resigned' ? (
              <Button variant="ghost" size="sm" onClick={() => setResignTarget(record)}>
                离职
              </Button>
            ) : null}
          </div>
        </CanRole>
      ),
    },
  ];

  const supplierField = (
    <FormField
      control={form.control}
      name="supplierId"
      render={({ field }) => (
        <FormItem>
          <FormLabel>所属供应商</FormLabel>
          <div className="flex items-center gap-2">
            <Select onValueChange={field.onChange} value={field.value || undefined}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="请选择供应商" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {(suppliers ?? []).map((s: Supplier) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {field.value ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-label="清除所属供应商"
                onClick={() => field.onChange('')}
              >
                清除
              </Button>
            ) : null}
          </div>
          <FormMessage />
        </FormItem>
      )}
    />
  );

  const employeeSelectFields = (
    <>
      <FormField
        control={form.control}
        name="departmentId"
        render={({ field }) => (
          <FormItem>
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
        control={form.control}
        name="positionId"
        render={({ field }) => (
          <FormItem>
            <FormLabel>岗位</FormLabel>
            <Select onValueChange={field.onChange} value={field.value}>
              <FormControl>
                <SelectTrigger>
                  <SelectValue placeholder="请选择岗位" />
                </SelectTrigger>
              </FormControl>
              <SelectContent>
                {(positions ?? []).map((p: Position) => (
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
      <FormField
        control={form.control}
        name="platformUserId"
        render={({ field }) => (
          <FormItem>
            <FormLabel>关联飞书账号</FormLabel>
            <div className="flex items-center gap-2">
              <UserSelect
                value={field.value || null}
                onChange={(v: string | null) => field.onChange(v ?? '')}
                placeholder="请选择用户"
              />
              {field.value ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label="清除关联飞书账号"
                  onClick={() => field.onChange('')}
                >
                  清除
                </Button>
              ) : null}
            </div>
            <FormMessage />
          </FormItem>
        )}
      />
    </>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Label htmlFor="employee-keyword">关键词</Label>
          <Input
            id="employee-keyword"
            className="w-56"
            placeholder="姓名/编号/部门"
            value={q}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setQ(e.target.value)
            }
          />
          {debouncing ? (
            <span className="text-xs text-muted-foreground">筛选中…</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleExport}>
            <Download className="h-4 w-4" />
            导出 Excel
          </Button>
          <CanRole roles={['admin']}>
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4" />
              导入 Excel
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              新建员工
            </Button>
          </CanRole>
        </div>
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
        dataSource={employees ?? []}
        loading={loading}
        rowKey="id"
        scroll={{ x: 1240, y: 480 }}
        pagination={{
          pageSize: 10,
          showTotal: (t: number) => `共 ${t} 条`,
        }}
        locale={{ emptyText: '暂无员工档案，点击右上角新建员工' }}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>新建员工</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onCreate} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      姓名 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="姓名" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {employeeSelectFields}
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="hireDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>入职日期</FormLabel>
                      <DateField value={field.value || null} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="status"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>状态</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.entries(EMPLOYEE_STATUS_LABELS).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="employmentType"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>用工类型</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.entries(EMPLOYMENT_TYPE_LABELS).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>手机号</FormLabel>
                      <FormControl>
                        <Input placeholder="手机号" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              {isVendorEmployment ? supplierField : null}
              <div className="flex gap-3">
                <FormField
                  control={form.control}
                  name="ssCityCode"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>参保城市代码</FormLabel>
                      <FormControl>
                        <Input placeholder="如 shanghai" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="ssBase"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>缴费基数</FormLabel>
                      <FormControl>
                        <Input placeholder="可选，默认按应发" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <DialogFooter>
                <Button type="submit" disabled={operating}>
                  保存
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog open={editTarget !== null} onOpenChange={(open: boolean) => !open && setEditTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>编辑员工</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onUpdate} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      姓名 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="姓名" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {employeeSelectFields}
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="hireDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>入职日期</FormLabel>
                      <DateField value={field.value || null} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="status"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>状态</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.entries(EMPLOYEE_STATUS_LABELS).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="employmentType"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>用工类型</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value || undefined}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.entries(EMPLOYMENT_TYPE_LABELS).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>手机号</FormLabel>
                      <FormControl>
                        <Input placeholder="手机号" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              {isVendorEmployment ? supplierField : null}
              <div className="flex gap-3">
                <FormField
                  control={form.control}
                  name="ssCityCode"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>参保城市代码</FormLabel>
                      <FormControl>
                        <Input placeholder="如 shanghai" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="ssBase"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>缴费基数</FormLabel>
                      <FormControl>
                        <Input placeholder="可选，默认按应发" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <DialogFooter>
                <Button type="submit" disabled={operating}>
                  保存
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={resignTarget !== null}
        onOpenChange={(open: boolean) => {
          if (!open) resetOffboardDialog();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>员工离职</DialogTitle>
          </DialogHeader>
          {offboardResult ? (
            <div className="space-y-4">
              <p className="text-sm text-success">
                办理成功，待交接项目 {offboardResult.handoverProjects.length} 个：
              </p>
              <ul className="list-disc space-y-1 pl-5 text-sm">
                {offboardResult.handoverProjects.map((p: HandoverProject) => (
                  <li key={p.projectId}>
                    {p.projectName}（已确认工时 {p.confirmedHours} 小时）
                  </li>
                ))}
              </ul>
              <p className="text-sm text-muted-foreground">
                请及时安排项目交接，交接完成后再关闭项目。
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                确认为 {resignTarget?.name}（{resignTarget?.code}）办理离职手续？
              </p>
              <div className="space-y-2">
                <Label htmlFor="resign-date">
                  离职日期 <span aria-hidden="true" className="text-destructive">*</span>
                </Label>
                <div id="resign-date">
                  <DateField value={resignDate} onChange={setResignDate} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="resign-remark">备注</Label>
                <Input
                  id="resign-remark"
                  placeholder="离职原因、交接安排等（可选）"
                  value={resignRemark}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setResignRemark(e.target.value)
                  }
                />
              </div>
            </div>
          )}
          <DialogFooter>
            {offboardResult ? (
              <Button onClick={resetOffboardDialog}>关闭</Button>
            ) : (
              <Button onClick={() => void doOffboard()} disabled={operating}>
                确认离职
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ExcelImportDialog<CreateEmployeeDto>
        open={importOpen}
        onOpenChange={setImportOpen}
        entityName="员工"
        templateFilename="员工导入模板.xlsx"
        columns={EMPLOYEE_IMPORT_COLUMNS}
        parseRow={(raw: Record<string, string>) =>
          parseEmployeeRow(raw, departmentByName, positionByName)
        }
        rowKey={(raw: Record<string, string>) => (raw['姓名'] ?? '').trim()}
        existingKeys={(employees ?? []).map((row: Employee) => row.name.trim())}
        createRow={(dto: CreateEmployeeDto) =>
          hrApi.createEmployee(dto).then(() => undefined)
        }
        onImportFinished={() => void reload()}
      />
    </div>
  );
};

export default EmployeePanel;
