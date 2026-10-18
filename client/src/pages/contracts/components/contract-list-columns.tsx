/**
 * 「合同列表」表的列定义（§5.9 / F8 拆分）。
 *
 * `ContractsPage.tsx` 里最大的一块 JSX 结构就是这张表的列定义（72 行）：`render`
 * 里既有 `<Badge>` / `<StatusBadge>` / `formatTaxSplitLine` 的展示，也有
 * `<DropdownMenu>` 的两项行内动作（找相似 / 转项目）与「详情」跳转的闭包。
 * 抽成工厂函数后，页面主文件里只剩 `const columns = contractListColumns({…})`。
 *
 * ⚠️ **行为零变更**：数组字面量（含 `const columns: TableColumnsType<Contract> = [`
 * 与收尾的 `];`）是原块的**逐字搬运**，连缩进都未动（原块就是 2 空格起，函数体内
 * 恰好同层）。只做了三件事 ——
 *   ① 原 `const columns` 的声明整行搬进函数体，末尾加 `return columns;`；
 *   ② 闭包捕获的三个组件层值改为入参（**同名**，故 `render` 体一个字符未动）：
 *      · `navigate` —— `useNavigate()` 的返回值，「详情」按钮与「找相似」选
 *        中后的跳转都用它；
 *      · `setSimilarTarget` / `setTransferTarget` —— 页面两个 `useState` 的
 *        setter（`SimilarTarget | null` 与 `Contract | null`）。
 *   ③ `TRANSFERABLE_STATUSES`（全仓仅本块使用）随块搬走。
 * 列头文案、宽度、`fixed`、`dataIndex`、`render` 全部未动。
 *
 * ## 「转项目」的显隐条件（原样保留，未改）
 *
 * `TRANSFERABLE_STATUSES = ['active', 'performing', 'completed']` 是**服务端口径**：
 * `server/modules/projects/projects.service.ts` 的 `createProject` 只对这三个状态
 * 放行，其余状态直接回 400「合同 … 状态不允许立项，须先生效」。前端据此不渲染
 * 点了必然失败的菜单项；两侧白名单当前逐个一致 —— 本文件与 service 各写一份，
 * 改其一必须同步。
 *
 * ## 「编辑」的显隐条件（本轮新增）
 *
 * `EDITABLE_STATUSES` 是服务端**冻结状态**的补集：`contract-update-guard.ts` 的
 * `CONTRACT_FROZEN_STATUSES = ['closed', 'terminated']` 下名称/计费模式/税率/负责人/
 * 日期/备注全部冻结，编辑弹窗里**大半字段都会被拒**；剩下的只有付款条款与签订日期，
 * 不值得渲染一个"点了多半报错"的入口（本仓既有判据：下拉/按钮只列可操作项）。
 * 故只在非冻结状态渲染「编辑」。
 *
 * ⚠️ 「金额/客户仅草稿可改」是**服务端**判据（同一模块的 `CONTRACT_DRAFT_ONLY_FIELDS`），
 * 前端不据此隐藏入口：已生效合同改名称/负责人/日期是常态，把整个入口对 `active`
 * 藏起来会砍掉绝大多数可用场景。该限制由弹窗内提示 + 服务端中文报错共同表达。
 *
 * ## 与门禁的关系
 *
 * 本文件没有 `<Label>`（唯一带可访问名的是「更多操作」按钮自带的 `aria-label`），
 * 因此 `check:label-a11y` 不涉及；日期列一律直接展示 `signDate` 原值并
 * `?? '-'`，未引入任何时区换算（`check:biz-timezone`）。
 */
import React from 'react';
import { TableColumnsType } from 'antd';
import { MoreHorizontal } from 'lucide-react';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@client/src/components/ui/dropdown-menu';
import type { SimilarTarget } from '@client/src/components/SimilarItemsDialog';
import { formatTaxSplitLine } from '@client/src/utils/tax-display';
import { formatMoney } from '@client/src/utils/format';
import {
  BILLING_MODEL_LABELS,
  CONTRACT_STATUS_LABELS,
} from '@client/src/utils/biz-labels';
import type { NavigateFunction } from 'react-router-dom';
import type { Contract } from '@shared/api.interface';

/** 允许「转项目」的合同状态：与服务端 `createProject` 的白名单逐个一致 */
const TRANSFERABLE_STATUSES = ['active', 'performing', 'completed'];

/**
 * 允许「编辑」的合同状态：服务端**冻结状态**的补集
 * （`server/modules/contracts/contract-update-guard.ts` 的 `CONTRACT_FROZEN_STATUSES`）。
 * 改其一必须同步另一侧。
 */
const EDITABLE_STATUSES = ['draft', 'approving', 'active', 'performing', 'completed'];

interface ContractListColumnsArgs {
  /** 行内跳转（父组件传入的就是 `useNavigate()`） */
  navigate: NavigateFunction;
  /** 「找相似」把目标行写进页面状态（父组件的 `setSimilarTarget`） */
  setSimilarTarget: React.Dispatch<React.SetStateAction<SimilarTarget | null>>;
  /** 「转项目」把目标行写进页面状态（父组件的 `setTransferTarget`） */
  setTransferTarget: React.Dispatch<React.SetStateAction<Contract | null>>;
  /** 「编辑」把目标行交给父组件（父组件负责打开编辑弹窗，见 `ContractsPage`） */
  onEdit: (record: Contract) => void;
  /** 「快速查看」打开右侧抽屉 */
  onQuickView: (record: Contract) => void;
}

export function contractListColumns({
  navigate,
  setSimilarTarget,
  setTransferTarget,
  onEdit,
  onQuickView,
}: ContractListColumnsArgs): TableColumnsType<Contract> {
  const columns: TableColumnsType<Contract> = [
    { title: '合同编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '名称', dataIndex: 'name', width: 220 },
    { title: '客户', dataIndex: 'customerName', width: 160 },
    {
      title: '计费模式',
      dataIndex: 'billingModel',
      width: 110,
      render: (m: string) => (
        <Badge variant="secondary">{BILLING_MODEL_LABELS[m] ?? m}</Badge>
      ),
    },
    {
      title: '金额（含税）',
      dataIndex: 'amount',
      width: 200,
      align: 'right',
      render: (v: number, record) => (
        <div className="text-right">
          <div>{formatMoney(v)}</div>
          <div className="text-xs text-muted-foreground">
            {formatTaxSplitLine(v, record.taxRate)}
          </div>
        </div>
      ),
    },
    { title: '税率', dataIndex: 'taxRate', width: 80, render: (v: number) => `${v}%` },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => <StatusBadge status={s} labels={CONTRACT_STATUS_LABELS} />,
    },
    { title: '负责人', dataIndex: 'owner', width: 100, render: (v) => v ?? '-' },
    { title: '签订日期', dataIndex: 'signDate', width: 110, render: (v) => v ?? '-' },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 240,
      render: (_, record) => (
        <div className="flex gap-1">
          <Button size="sm" variant="outline" onClick={() => onQuickView(record)}>
            查看
          </Button>
          <Button size="sm" onClick={() => navigate(`/contracts/${record.id}`)}>
            详情
          </Button>
          {EDITABLE_STATUSES.includes(record.status) ? (
            <CanCapabilityWrite capability="crm_write">
              <Button size="sm" variant="outline" onClick={() => onEdit(record)}>
                编辑
              </Button>
            </CanCapabilityWrite>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`${record.name} 的更多操作`}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                onClick={() =>
                  setSimilarTarget({ id: record.id, code: record.code, name: record.name })
                }
              >
                找相似
              </DropdownMenuItem>
              {TRANSFERABLE_STATUSES.includes(record.status) ? (
                <CanCapabilityWrite capability="projects_write">
                  <DropdownMenuItem onClick={() => setTransferTarget(record)}>
                    转项目
                  </DropdownMenuItem>
                </CanCapabilityWrite>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];
  return columns;
}


