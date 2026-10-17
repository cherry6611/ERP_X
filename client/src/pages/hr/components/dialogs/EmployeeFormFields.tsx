/**
 * 员工表单里被「新建员工」与「编辑员工」两个弹窗**共用**的两组字段
 *
 * §5.9（F8）：从 `EmployeePanel.tsx` 抽出的表单片段（原 `supplierField` /
 * `employeeSelectFields` 两个 JSX 变量，共 120 行，被两个弹窗各用一次）。
 *
 * ## 为什么要单独成文件
 *
 * 它们与弹窗自身的提交逻辑无关，只依赖 `form` 与三个下拉数据源（部门 / 岗位 / 供应商），
 * 因此可以整体搬走 —— 否则承载它们的 `EmployeeFormDialog.tsx` 会被这两组字段顶到
 * 500 行门槛之上。
 *
 * ## 逐字搬运：只换包裹层，`form` 沿用同名 prop
 *
 * 两处 JSX 一字未动（仅整体左移两格缩进，用于适配组件体）。原文件里 `form` /
 * `departments` / `positions` / `suppliers` 就是 `EmployeePanel` 作用域内的名字，
 * 这里沿用**同名 props**，于是字段内部对 `form.control`、`(suppliers ?? [])`、
 * `(departments ?? [])` 的写法完全不需要改。
 *
 * `EmployeeForm` 类型别名与 `useForm<EmployeeFormInput, unknown, EmployeeFormData>` 的
 * 返回类型一致：两个弹窗共享同一个表单实例（校验状态与 `reset` 行为都在一起），
 * 所以这里传的是**实例本身**而不是它的克隆。
 */
import React from 'react';
import type { UseFormReturn } from 'react-hook-form';
import { Button } from '@client/src/components/ui/button';
import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@client/src/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { UserSelect } from '@client/src/components/business-ui/user-select';
import type { EmployeeFormData, EmployeeFormInput } from '../employee-import';
import type { Department, Position, Supplier } from '@shared/api.interface';

/** 与父组件 `useForm<EmployeeFormInput, unknown, EmployeeFormData>` 同一类型 */
export type EmployeeForm = UseFormReturn<
  EmployeeFormInput,
  unknown,
  EmployeeFormData
>;

interface SupplierFieldProps {
  form: EmployeeForm;
  suppliers: Supplier[] | undefined;
}

export const SupplierField: React.FC<SupplierFieldProps> = ({
  form,
  suppliers,
}) => (
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

interface EmployeeSelectFieldsProps {
  form: EmployeeForm;
  departments: Department[] | undefined;
  positions: Position[] | undefined;
}

export const EmployeeSelectFields: React.FC<EmployeeSelectFieldsProps> = ({
  form,
  departments,
  positions,
}) => (
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
