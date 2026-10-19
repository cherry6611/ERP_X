/**
 * 「新建员工」+「编辑员工」两个弹窗（共用同一个表单实例）
 *
 * §5.9（F8）：从 `EmployeePanel.tsx` 抽出的两个 `<Dialog>` 块及其表单逻辑
 * （原第 126–209 行的 `useForm` / `watch` / `useEffect` / DTO 映射 / 两个提交处理函数，
 * 加第 522–796 行的两个弹窗 JSX）。
 *
 * ## 为什么两个弹窗在同一个文件里（而不是一人一个文件）
 *
 * 它们**共用同一个 `useForm` 实例**：原文件里 `form` 定义在 `EmployeePanel` 作用域，
 * 两个弹窗都读它。这不是巧合，而是现状语义的一部分：
 *   · `useEffect([editTarget])` 在打开「编辑」时把表单 `reset` 成该员工的值；
 *   · 「新建」提交成功后 `form.reset(EMPTY_FORM)`。
 * 若把两个弹窗拆成两个组件、各持一个 `useForm`，上面两条 `reset` 的**作用域就变了**
 * ——「先开编辑、再开新建」看到的初值会从"上一个编辑对象的值"变成空表单，属于可见行为
 * 变更。因此拆分边界划在"共用表单"之外，而不是两个弹窗之间。
 *
 * ## 逐字搬运，只有四处"父组件 state/setter 变 props"
 *
 *   · `onOpenChange={setCreateOpen}` → `onCreateOpenChange`；
 *   · 编辑弹窗 `setEditTarget(null)` → `onEditTargetChange(null)`（JSX 一处）；
 *   · 更新成功后 `setEditTarget(null)` → `onEditTargetChange(null)`（处理函数一处）；
 *   · 提交成功后的 `await reload()` → `await onSaved()`（新建 / 更新各一处）。
 * 字段、文案、`placeholder`、`Select` 的取值（含编辑态 `field.value || undefined`
 * 那一处与新建态不同的写法）全部保持原样。
 *
 * ## `operating` 为什么变成组件内状态
 *
 * 原实现的 `operating` 是**两个表单弹窗 + 离职弹窗共用一个布尔值**：任一处提交就把三处的
 * 提交按钮一起置灰。抽出后每个弹窗各持一个 —— 三个弹窗互斥（都是模态，同一时刻只可能
 * 开一个），因此可见行为完全一致。同 `dialogs/AttendanceDialog.tsx` 的处理与说明。
 *
 * ## reset 语义（已核对：保持原样，未新增也未删除）
 *
 * 本组件保留原文件**仅有**的两处 `reset`：① `useEffect` 在 `editTarget` 变化时 `reset`
 * 成该员工的值；② 新建成功后 `reset(EMPTY_FORM)`。
 * 原文件**没有**"打开新建弹窗时清空表单"这类 reset-on-open（新建弹窗打开时看到的是表单
 * 里残留的上一次值），这里也**没有**加 —— 加了就是行为变更。
 */
import React, { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Explained } from '@client/src/components/erp/ItemHelp';
import DateField from '@client/src/components/erp/DateField';
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
import {
  EMPLOYEE_STATUS_LABELS,
  EMPLOYMENT_TYPE_LABELS,
} from '../HrStatusBadge';
import {
  EMPTY_FORM,
  employeeSchema,
  type EmployeeFormData,
  type EmployeeFormInput,
} from '../employee-import';
import { EmployeeSelectFields, SupplierField } from './EmployeeFormFields';
import type {
  CreateEmployeeDto,
  Department,
  Employee,
  Position,
  Supplier,
  UpdateEmployeeDto,
} from '@shared/api.interface';

interface EmployeeFormDialogProps {
  /** 「新建员工」弹窗开关（父组件 `createOpen`） */
  createOpen: boolean;
  /** 父组件 `setCreateOpen` */
  onCreateOpenChange: (open: boolean) => void;
  /** 待编辑员工；null 表示「编辑员工」弹窗关闭（与父组件 `editTarget !== null` 判据一致） */
  editTarget: Employee | null;
  /** 父组件 `setEditTarget` */
  onEditTargetChange: (target: Employee | null) => void;
  departments: Department[] | undefined;
  positions: Position[] | undefined;
  suppliers: Supplier[] | undefined;
  /** 写成功后的刷新（父组件传 `reload`，原 `await reload()`） */
  onSaved: () => void | Promise<void>;
}

const EmployeeFormDialog: React.FC<EmployeeFormDialogProps> = ({
  createOpen,
  onCreateOpenChange,
  editTarget,
  onEditTargetChange,
  departments,
  positions,
  suppliers,
  onSaved,
}) => {
  const [operating, setOperating] = useState(false);

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
      onCreateOpenChange(false);
      form.reset(EMPTY_FORM);
      await onSaved();
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
      onEditTargetChange(null);
      await onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '更新失败');
    } finally {
      setOperating(false);
    }
  });

  const supplierField = <SupplierField form={form} suppliers={suppliers} />;
  const employeeSelectFields = (
    <EmployeeSelectFields
      form={form}
      departments={departments}
      positions={positions}
    />
  );

  return (
    <>
      <Dialog open={createOpen} onOpenChange={onCreateOpenChange}>
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
                      <Explained
                        title="用工类型"
                        content="正式、劳务或实习等。它决定人事口径，不直接改工资单上的个税和社保。"
                      >
                        <FormLabel>用工类型</FormLabel>
                      </Explained>
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
                      <Explained
                        title="缴费基数"
                        content="社保和公积金按这个基数计算，不是按当月实发工资。基数一般由参保地规定上下限。"
                      >
                        <FormLabel>缴费基数</FormLabel>
                      </Explained>
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

      <Dialog open={editTarget !== null} onOpenChange={(open: boolean) => !open && onEditTargetChange(null)}>
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
                      <Explained
                        title="用工类型"
                        content="正式、劳务或实习等。它决定人事口径，不直接改工资单上的个税和社保。"
                      >
                        <FormLabel>用工类型</FormLabel>
                      </Explained>
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
                      <Explained
                        title="缴费基数"
                        content="社保和公积金按这个基数计算，不是按当月实发工资。基数一般由参保地规定上下限。"
                      >
                        <FormLabel>缴费基数</FormLabel>
                      </Explained>
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
    </>
  );
};

export default EmployeeFormDialog;
