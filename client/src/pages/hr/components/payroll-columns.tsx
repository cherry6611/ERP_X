/**
 * 工资单列表的 antd 列定义（§5.9 / F8）
 *
 * 从 `PayrollPanel.tsx` 抽出的列定义模块，与同目录的 `attendance-columns.tsx`、
 * `employee-columns.tsx` 同一形态。
 *
 * ## 为什么用工厂函数而不是常量
 *
 * 「操作」列的按钮闭包了父组件的 `doAction`（`hrApi.payrollAction` + 审批待办通知 +
 * 列表刷新）。该入口随父组件每次渲染而变，常量数组持有不了，因此导出
 * `payrollColumns({ doAction })`，由父组件在渲染时调用、拿到列定义。
 *
 * ## 逐字搬运，只有「父组件的 doAction 变 props」一处
 *
 * 数组字面量本身逐字搬运：列头文案、`fixed`、`width`、`dataIndex`、`render`、
 * 按钮的 `variant` / `size` 与三个状态分支全部未动。`doAction` 以**同名**解构入参，
 * 因此 `onClick={() => void doAction(record, 'submit')}` 这类写法一字未改。
 *
 * ⚠️ **没有**给 `columns` 加 `useMemo`：原文件也没有（`const columns = [...]` 每次渲染
 * 重建），加了会改变 antd 表格拿到新列引用的时机 —— 那是行为变更，不在本次拆分范围。
 *
 * ## 拆分时发现、但**故意未修**的缺陷：工资单被驳回后没有出路
 *
 * 服务端 `HrPayService.payrollAction` 的 submit 分支接受 `draft` **或** `rejected`
 * （`hr-pay.service.ts` 注释 D-14：允许 rejected 回到 submitted 重开，避免该月永久死锁；
 * 错误文案为「仅草稿或已驳回状态可提交」），`PayrollStatus` 契约（`shared/api.interface.ts`）
 * 同样含 `rejected`。但本文件的「操作」列只对 `draft` 渲染提交按钮，`rejected` 行除打印
 * 工资条外**没有任何按钮**；而 `createPayroll` 的查重键是 (employeeId, period)、与状态无关，
 * 重开会抛「该员工此月份工资单已存在」。于是被驳回的那张单既不能重新提交、也不能重建 ——
 * 该员工该月的工资单永久停在 `rejected`。
 * 修复等于新增一个按钮（可见 UI 变更），超出本次「逐字搬运」的范围，故保留原样并在此记录。
 */
import { TableColumnsType } from 'antd';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import HrStatusBadge, { PAYROLL_STATUS_LABELS } from './HrStatusBadge';
import { Button } from '@client/src/components/ui/button';
import PayslipPrintButton from '@client/src/components/print/PayslipPrintButton';
import { formatMoney } from '@client/src/utils/format';
import type { PayrollAction, PayrollItem } from '@shared/api.interface';

interface PayrollColumnsArgs {
  /** 工资单动作入口（`hrApi.payrollAction` + 审批待办通知 + 刷新列表） */
  doAction: (item: PayrollItem, action: PayrollAction) => Promise<void>;
}

export function payrollColumns({
  doAction,
}: PayrollColumnsArgs): TableColumnsType<PayrollItem> {
  const columns: TableColumnsType<PayrollItem> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '员工', dataIndex: 'employeeName', width: 110 },
    { title: '期间', dataIndex: 'period', width: 90 },
    {
      title: '基本工资',
      dataIndex: 'baseSalary',
      width: 110,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '绩效工资',
      dataIndex: 'perfSalary',
      width: 110,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '补贴',
      dataIndex: 'allowance',
      width: 100,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '社保',
      dataIndex: 'socialInsurance',
      width: 100,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '公积金',
      dataIndex: 'housingFund',
      width: 100,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '个税',
      dataIndex: 'tax',
      width: 100,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '实发',
      dataIndex: 'netSalary',
      width: 120,
      align: 'right',
      render: (v: number) => <span className="font-medium">{formatMoney(v)}</span>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => <HrStatusBadge status={s} labels={PAYROLL_STATUS_LABELS} />,
    },
    {
      title: '操作',
      key: 'action',
      width: 260,
      render: (_: unknown, record: PayrollItem) => (
        <div className="flex items-center gap-1">
          {/* C-06：工资条打印（裁剪后随工资发放，或作为个人留存凭证） */}
          <PayslipPrintButton payroll={record} stopPropagation />
          <CanCapabilityWrite capability="hr_write">
            <div className="flex gap-1">
              {/*
                * ⚠️ 条件必须是 `draft` **或** `rejected` —— 原先只有 `draft`，
                * 于是被驳回的工资单在界面上**没有任何出路**（详见文件头「已修缺陷」）。
                * 服务端 `HrPayService.payrollAction` 的 submit 分支接受
                * `current !== 'draft' && current !== 'rejected'` 时拒绝，
                * 即它**本来就允许**重新提交（注释 D-14：「允许 rejected → submitted
                * 重开，避免该月永久死锁」）。这里只是把漏掉的入口补上，
                * 按钮文案与 handler 一字未改。
                */}
              {record.status === 'draft' || record.status === 'rejected' ? (
                <Button variant="ghost" size="sm" onClick={() => void doAction(record, 'submit')}>
                  提交审批
                </Button>
              ) : null}
              {record.status === 'submitted' ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => void doAction(record, 'approve')}>
                    审批通过
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => void doAction(record, 'reject')}
                  >
                    驳回
                  </Button>
                </>
              ) : null}
              {/*
                B12（§7.2）：`approved` 原先没有任何后续按钮 ——
                "批准了但还没打款"与"已经打款"在界面上无法区分，
                出纳只能靠线下表格跟踪；误批准也无从撤销。
                现在补齐"标记发放"与"作废"两个出口，与后端状态机一致。
              */}
              {record.status === 'approved' ? (
                <>
                  <Button variant="ghost" size="sm" onClick={() => void doAction(record, 'pay')}>
                    标记发放
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => void doAction(record, 'void')}
                  >
                    作废
                  </Button>
                </>
              ) : null}
            </div>
          </CanCapabilityWrite>
        </div>
      ),
    },
  ];
  return columns;
}
