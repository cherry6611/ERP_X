/**
 * 合同详情页**含 JSX 的两张表**的列定义（§5.9 / F8 拆分第二轮）。
 *
 * ## 为什么这两块不能和 `calloffColumns` 一起搬进 `contract-detail-model.ts`
 *
 * `calloffColumns`（框架下单表）是**纯**列定义：无 JSX、无闭包，所以它上一轮就
 * 搬进了零 React 依赖的模型模块并拿到逐列断言。本文件的两种列定义做不到 ——
 * `milestoneColumns` 的「操作」列 render 里是 `<CanCapabilityWrite>` + `<Button>`，
 * 并闭包了「达成」的提交处理函数；`versionColumns` 的「金额变动」列 render 里是
 * `<span className={…}>`。把它们塞进模型模块会把 React 拉进单测的纯逻辑层。
 *
 * 但"不能单测"不等于"该留在 909 行的组件主文件里"：这两块合计 56 行，
 * 且**改错看不出来** —— 「达成」按钮挂错处理函数时按钮照样能点，只是打到了别的接口。
 *
 * ## 为什么一个导出工厂、一个是常量
 *
 * `milestoneColumns({ onReach })`：「达成」按钮需要组件层注入的提交处理函数
 * （它要 `toast` + 写后 `load()`），常量数组拿不到随渲染变化的闭包，故由
 * `ContractDetailBody` 在渲染时调用 —— 重建时机与原先组件内的 `const` 相同。
 * `versionColumns` 不闭包任何东西，直接导出常量。
 *
 * ⚠️ **行为零变更**：两份数组字面量是原块的**逐字搬运**，只做了三件事 ——
 *   ① 整体去掉一层缩进；
 *   ② `milestoneColumns` 由 `const` 改为工厂函数：闭包捕获的 `reachMilestone`
 *      改为入参 `onReach`（`ContractDetailBody` 传入的就是 `reachMilestone`），
 *      函数末尾加 `return milestoneColumns;`；
 *   ③ `versionColumns` 由 `const` 改为 `export const`。
 * 列头文案、宽度、`fixed`、`dataIndex`、`render` 全部未动。
 */
import { TableColumnsType } from 'antd';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { Button } from '@client/src/components/ui/button';
import { formatMoney } from '@client/src/utils/format';
import { MILESTONE_STATUS_LABELS } from '../contract-detail-model';
import type { ContractMilestone, ContractVersion } from '@shared/api.interface';

interface MilestoneColumnsArgs {
  /** 标记里程碑达成（父组件持有 `contractsApi.updateMilestone` + `load`） */
  onReach: (milestone: ContractMilestone) => void;
}

export function milestoneColumns({
  onReach: reachMilestone,
}: MilestoneColumnsArgs): TableColumnsType<ContractMilestone> {
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
      <StatusBadge status={s} labels={MILESTONE_STATUS_LABELS} />
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
        <CanCapabilityWrite capability="crm_write">
          <Button variant="ghost" size="sm" onClick={() => void reachMilestone(record)}>
            达成
          </Button>
        </CanCapabilityWrite>
      ) : null,
  },
  ];
  return milestoneColumns;
}

export const versionColumns: TableColumnsType<ContractVersion> = [
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
