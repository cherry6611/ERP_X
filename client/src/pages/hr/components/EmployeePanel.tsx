/**
 * 员工档案面板（列表编排 + 筛选区）
 *
 * §5.9（F8）：主文件只保留**布局编排与筛选区**（页头筛选 / 空态 / 失败重试 / 表格 /
 * 三个弹窗的挂载），区块全部拆到同目录：
 *
 * | 拆出的东西 | 去处 |
 * |---|---|
 * | `TableColumnsType<Employee>` 列定义（含「操作」列四个按钮） | `employee-columns.tsx`（工厂函数，注入四个入口） |
 * | 「新建员工」+「编辑员工」两个弹窗、共用的 `useForm`、DTO 映射、两个提交处理函数 | `dialogs/EmployeeFormDialog.tsx` |
 * | 两个弹窗共用的两组字段（供应商 / 部门+岗位+飞书账号） | `dialogs/EmployeeFormFields.tsx` |
 * | 「员工离职」弹窗及其状态与提交处理函数 | `dialogs/EmployeeOffboardDialog.tsx` |
 *
 * ## 为什么列定义用工厂函数
 *
 * 「操作」列的四个按钮闭包了本组件的四个入口（`setEditTarget` / `doConfirm` /
 * `toggleActive` / `setResignTarget`）。这四处随本组件每次渲染而变，常量数组持有不了，
 * 故按 `attendance-columns.tsx` 的同一形态导出 `employeeColumns({ ... })` 在渲染时调用。
 * ⚠️ **没有**给 `columns` 加 `useMemo`：原文件也没有，加了会改变 antd 表格分页/排序状态的
 * 重置时机（那是行为变更，不是本次拆分的范围）。
 *
 * ## 拆分的边界：`useForm` 只搬一次
 *
 * 两个表单弹窗共用**同一个** `useForm` 实例，`useEffect([editTarget])` 的 `reset` 与
 * 新建成功后的 `reset(EMPTY_FORM)` 都作用在它上面。因此表单实例整体搬进
 * `EmployeeFormDialog`（两个弹窗仍在同一文件内），而不是一人一个 —— 拆开会改变
 * 「先开编辑、再开新建」时表单初值的来源。
 *
 * ## reset 语义（**已核对：本文件没有 reset-on-open**）
 *
 * 原文件里只有两处 `reset`，都在 `EmployeeFormDialog` 内按原触发点保留：
 *   ① `useEffect(() => { if (editTarget) { form.reset({...该员工的值}); } }, [editTarget, form])`
 *      —— 在「打开编辑」时（`editTarget` 由 null 变为员工）；
 *   ② 新建成功后 `form.reset(EMPTY_FORM)`。
 * 打开「新建员工」时**没有**任何清空动作（会看到表单里残留的上一次值）—— 拆分后同样没有，
 * 未新增任何 reset。
 *
 * ## 离职弹窗的 `resignTarget` 为什么仍在本组件
 *
 * 「操作」列的「离职」按钮要 `setResignTarget(record)`，离职弹窗要 `resignTarget !== null`
 * 判开合 —— 它跨越列定义与弹窗两处，故留在父组件按 prop 传入（`resignDate` /
 * `resignRemark` / `offboardResult` 只被弹窗自己读写，随弹窗搬走）。
 */
import React, { useState } from 'react';
import { toast } from 'sonner';
import { Download, Plus, Upload } from 'lucide-react';
import { Table } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import { ExcelImportDialog } from '@client/src/components/excel/ExcelImportDialog';
import {
  exportRowsToXlsx,
} from '@client/src/components/excel/excel-utils';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import { hrApi, masterDataApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { useListQuery } from '@client/src/hooks/useListQuery';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import {
  EMPLOYEE_EXPORT_COLUMNS,
  EMPLOYEE_IMPORT_COLUMNS,
  parseEmployeeRow,
} from './employee-import';
import { employeeColumns } from './employee-columns';
import EmployeeFormDialog from './dialogs/EmployeeFormDialog';
import EmployeeOffboardDialog from './dialogs/EmployeeOffboardDialog';
import type {
  CreateEmployeeDto,
  Department,
  Employee,
  Position,
  Supplier,
} from '@shared/api.interface';

/*
 * §5.9（F8）：`employeeSchema` / `EMPTY_FORM` / 中英文映射表 / 导入导出列定义 /
 * `parseEmployeeRow` 已移到 `./employee-import`。
 *
 * 搬家同时**修掉一个真实缺陷**：`parseEmployeeRow` 原来只用正则
 * `/^(\d{4})-(\d{1,2})-(\d{1,2})$/` 校验入职日期，而正则**不约束取值范围**，
 * 于是 `2026-13-01`（13 月）与 `2026-02-31` 这类**不存在的日期**会通过，
 * 一路走到 `INSERT` 再由 PostgreSQL 的 `date` 类型在服务端抛错 ——
 * HR 只看到"导入失败"，不知道是哪一行哪一列。现已用 Date 回环补齐日历校验
 * （`2026-02-29` 与 `2000-02-29` 等闰日仍正确接受）。
 *
 * 该模块现有 37 条单测（`employee-import.spec.ts`），其中包括
 * "导出 → 回导闭环"断言：导出的中文用工类型必须能被同一个解析器接受。
 */

const EmployeePanel: React.FC = () => {
  const { q, setQ, debouncedQ, debouncing } = useListQuery();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Employee | null>(null);
  const [resignTarget, setResignTarget] = useState<Employee | null>(null);
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

  const columns = employeeColumns({
    onEdit: (record: Employee) => setEditTarget(record),
    onConfirm: (record: Employee) => void doConfirm(record),
    onToggleActive: (record: Employee) => void toggleActive(record),
    onResign: (record: Employee) => setResignTarget(record),
  });

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
          <CanCapabilityWrite capability="hr_write">
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4" />
              导入 Excel
            </Button>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="h-4 w-4" />
              新建员工
            </Button>
          </CanCapabilityWrite>
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

      <EmployeeFormDialog
        createOpen={createOpen}
        onCreateOpenChange={setCreateOpen}
        editTarget={editTarget}
        onEditTargetChange={setEditTarget}
        departments={departments}
        positions={positions}
        suppliers={suppliers}
        onSaved={reload}
      />

      <EmployeeOffboardDialog
        resignTarget={resignTarget}
        onClose={() => setResignTarget(null)}
        onSaved={reload}
      />

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
