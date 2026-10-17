/**
 * 合同详情弹窗的**主体内容**（§5.9 / F8 拆分第二轮）。
 *
 * ## 本组件承担什么
 *
 * 原先 `ContractDetailDialog.tsx` 的 `const content = ( … )` —— 275 行 JSX：
 * 概览栅格、状态机按钮行、合同明细表、里程碑表、Call-off 表、变更版本表、附件区。
 * 本轮把这整块搬到这里；父组件只剩数据查询（`load`）、六个弹窗的状态与
 * 六个提交处理函数 —— 也就是"页面级编排"。
 *
 * | 块 | 去向 |
 * |---|---|
 * | 里程碑表列定义（含「达成」按钮） | `./contract-detail-columns.tsx` 的 `milestoneColumns({ onReach })` |
 * | 变更版本表列定义 | `./contract-detail-columns.tsx` 的 `versionColumns` |
 * | 合同明细表内联列定义（含删除按钮） | `./contract-item-columns.tsx` 的 `contractItemColumns({ detail, onDeleted })` |
 * | 本文件 | 概览栅格 + 按钮行 + 四张表 + 附件区（原 `content` 整块） |
 *
 * ⚠️ **行为零变更**：`<DataState …>` 起的整块 JSX 逐字搬运。允许的改动只有四类：
 *   ① 整体去掉一层缩进；
 *   ② 闭包捕获的组件层值改为 **同名 prop**（`detail` / `items` / `contractId` /
 *      `loading` / `error` / `setMilestoneOpen` / `setCalloffOpen` / `setChangeOpen` /
 *      `setItemOpen` / `doAction` / `reachMilestone` / `load`）；两处列定义只是把
 *      原来的内联 `const` 换成工厂调用，`render` 体一个字符未动；
 *   ③ 两个按钮的 `onClick` **体**（共 24 行）改为调用 `onOpenItem()` /
 *      `onOpenQuotationImport()` —— 这两段原先不是 JSX 而是处理逻辑，其函数体
 *      （`setItemDraft(prev => …)` 与 `crmApi.listQuotations()`）按要求**逐字留在
 *      父组件**，本组件只是调用它。这样 props 面不必再暴露四个 setter，而
 *      "点击时先按主体校正税率再打开"的时序完全没变：调用点仍是同一个按钮的
 *      同一个 `onClick`；
 *   ④ 原来包住整块的 `{detail ? ( … ) : null}` 提成父组件的挂载条件
 *      （`{detail ? <ContractDetailBody … /> : null}`）—— 渲染条件完全相同。
 * 文案、类名、`render`、表格属性全部未动。
 *
 * ## 为什么列定义在本组件内调用工厂、而不是由父组件传数组
 *
 * `milestoneColumns` 的 identity 随渲染变化（闭包了「达成」处理函数），原先它也是
 * 每次渲染重建的组件内 `const`。在这里调用工厂，重建时机与原来一致；若提到父组件
 * 再当 prop 传下来，反而多一层，且父组件的 `detail` 可能是 `null` 而列定义需要
 * 已加载的 `detail`。
 *
 * ## 附件区留在本组件
 *
 * `<AttachmentField resourceType="erp_contract" …>` 只依赖 `contractId`，
 * 但它属于"详情内容"的一部分（一个 `border-t` 区块），跟着 `content` 整块搬家。
 */
import React from 'react';
import { Plus } from 'lucide-react';
import { Table } from 'antd';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import { DataState } from '@client/src/components/DataState';
import { SectionTitle } from '@client/src/components/SectionTitle';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
import { contractItemColumns } from './contract-item-columns';
import {
  milestoneColumns as milestoneColumnsOf,
  versionColumns,
} from './contract-detail-columns';
import type { ContractItem } from '@client/src/api/contracts';
import { formatMoney } from '@client/src/utils/format';
import { BILLING_MODEL_LABELS } from '@client/src/utils/biz-labels';
import { formatTaxSplitLine } from '@client/src/utils/tax-display';
import { calloffColumns, statusActionsFor } from '../contract-detail-model';
import type {
  ContractDetail,
  ContractMilestone,
  ContractStatusAction,
} from '@shared/api.interface';

interface ContractDetailBodyProps {
  /** 详情已加载 —— 父组件只在 `detail` 非空时渲染本组件（原 `{detail ? (…) : null}`） */
  detail: ContractDetail;
  items: ContractItem[];
  contractId: string | null;
  loading: boolean;
  error: string | null;
  /** 状态机按钮点击（父组件持有 `contractsApi.changeContractStatus` + `load`） */
  doAction: (action: ContractStatusAction) => void;
  /** 里程碑「达成」（父组件持有 `contractsApi.updateMilestone` + `load`） */
  reachMilestone: (milestone: ContractMilestone) => void;
  /** 明细「删除」成功后重取详情与明细（父组件传入的就是 `load`） */
  load: () => void | Promise<void>;
  /** 「添加明细」：父组件在打开前按合同主体校正默认税率 */
  onOpenItem: () => void;
  /** 「从报价导入」：父组件清空已选报价并拉取报价单列表 */
  onOpenQuotationImport: () => void;
  setMilestoneOpen: (open: boolean) => void;
  setCalloffOpen: (open: boolean) => void;
  setChangeOpen: (open: boolean) => void;
}

const ContractDetailBody: React.FC<ContractDetailBodyProps> = ({
  detail,
  items,
  contractId,
  loading,
  error,
  doAction,
  reachMilestone,
  load,
  onOpenItem,
  onOpenQuotationImport,
  setMilestoneOpen,
  setCalloffOpen,
  setChangeOpen,
}) => {
  const actions = statusActionsFor(detail.status);
  const itemColumns = contractItemColumns({ detail, onDeleted: load });
  /*
   * 列定义在这里按渲染重建 —— 与原先组件内的 `const milestoneColumns = [...]`
   * 同一时机（原先的「达成」按钮就闭包了每次渲染新建的 `reachMilestone`）。
   */
  const milestoneColumns = milestoneColumnsOf({ onReach: reachMilestone });

  return (
    <>
      <DataState loading={loading} error={error}>
<div className="flex flex-col gap-6">
  <div className="grid grid-cols-3 gap-3 text-sm">
    <div>
      <p className="text-muted-foreground">客户</p>
      <p>{detail.customerName}</p>
    </div>
    <div>
      <p className="text-muted-foreground">计费模式</p>
      <p>
        <Badge variant="secondary">
          {BILLING_MODEL_LABELS[detail.billingModel] ?? detail.billingModel}
        </Badge>
      </p>
    </div>
    <div>
      <p className="text-muted-foreground">合同金额（含税）</p>
      <p>{formatMoney(detail.amount)}</p>
      <p className="text-xs text-muted-foreground mt-0.5">
        {formatTaxSplitLine(detail.amount, detail.taxRate)}
      </p>
    </div>
    <div>
      <p className="text-muted-foreground">税率</p>
      <p>{detail.taxRate}%</p>
    </div>
    <div>
      <p className="text-muted-foreground">不含税金额</p>
      <p>{formatMoney(detail.netAmount ?? 0)}</p>
    </div>
    <div>
      <p className="text-muted-foreground">税额</p>
      <p>{formatMoney(detail.taxAmount ?? 0)}</p>
    </div>
    <div>
      <p className="text-muted-foreground">负责人</p>
      <p>{detail.owner ?? '-'}</p>
    </div>
    <div>
      <p className="text-muted-foreground">付款条款</p>
      <p>{detail.paymentTerms ?? '-'}</p>
    </div>
    <div>
      <p className="text-muted-foreground">签订日期</p>
      <p>{detail.signDate ?? '-'}</p>
    </div>
    <div>
      <p className="text-muted-foreground">履约周期</p>
      <p>
        {detail.startDate ?? '-'} ~ {detail.endDate ?? '-'}
      </p>
    </div>
    <div>
      <p className="text-muted-foreground">可开票金额</p>
      <p>{formatMoney(detail.billable.billableAmount)}</p>
    </div>
  </div>

  <CanCapabilityWrite capability="crm_write">
    <div className="flex flex-wrap gap-2">
      {actions.map(({ action, label }) => (
        <Button
          key={action}
          size="sm"
          variant={action === 'reject' ? 'destructive' : 'default'}
          onClick={() => void doAction(action)}
        >
          {label}
        </Button>
      ))}
      <Button size="sm" variant="outline" onClick={() => setChangeOpen(true)}>
        登记变更
      </Button>
    </div>
  </CanCapabilityWrite>

  <div className="flex flex-col gap-3">
    <div className="flex items-center justify-between">
      <SectionTitle>合同明细</SectionTitle>
      {detail.status === 'draft' ? (
        <CanCapabilityWrite capability="crm_write">
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                /*
                 * 修复 P0-3：打开时按合同主体校正默认税率，
                 * 否则小规模主体下 <select value={6}> 匹配不到选项 → 显示空白、提交 400。
                 * 校正逻辑（含"越界时取该主体的合法默认档位、绝不返回 null"）
                 * 已抽到 `./contract-detail-model` 的 `resolveItemTaxRate`，
                 * 与下拉选项 `itemRateOptions` 同源。
                 */
                onOpenItem();
              }}
            >
              <Plus className="h-4 w-4" />
              添加明细
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                onOpenQuotationImport();
              }}
            >
              从报价导入
            </Button>
          </div>
        </CanCapabilityWrite>
      ) : null}
    </div>
    <Table
      rowKey="id"
      size="small"
      pagination={false}
      dataSource={items}
      columns={itemColumns}
      locale={{ emptyText: '暂无明细，草稿阶段可添加' }}
    />
  </div>

  <div className="flex flex-col gap-3">
    <div className="flex items-center justify-between">
      <SectionTitle>合同里程碑</SectionTitle>
      <CanCapabilityWrite capability="crm_write">
        <Button size="sm" variant="outline" onClick={() => setMilestoneOpen(true)}>
          <Plus className="h-4 w-4" />
          添加里程碑
        </Button>
      </CanCapabilityWrite>
    </div>
    <Table
      columns={milestoneColumns}
      dataSource={detail.milestones}
      rowKey="id"
      scroll={{ x: 800, y: 240 }}
      pagination={false}
      size="small"
    />
  </div>

  {detail.billingModel === 'framework' ? (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <SectionTitle>
          Call-off 下单（累计 {formatMoney(detail.billable.calloffTotal)} / 上限{' '}
          {formatMoney(detail.amount)}）
        </SectionTitle>
        <CanCapabilityWrite capability="crm_write">
          <Button size="sm" variant="outline" onClick={() => setCalloffOpen(true)}>
            <Plus className="h-4 w-4" />
            框架下单
          </Button>
        </CanCapabilityWrite>
      </div>
      <Table
        columns={calloffColumns}
        dataSource={detail.calloffs}
        rowKey="id"
        scroll={{ x: 800, y: 240 }}
        pagination={false}
        size="small"
      />
    </div>
  ) : null}

  <div className="flex flex-col gap-3">
    <SectionTitle>变更版本留痕</SectionTitle>
    <Table
      columns={versionColumns}
      dataSource={detail.versions}
      rowKey="id"
      scroll={{ x: 600, y: 240 }}
      pagination={false}
      size="small"
    />
  </div>

  {contractId ? (
    <div className="border-t pt-4">
      <AttachmentField
        resourceType="erp_contract"
        resourceId={contractId}
        usageHint="合同扫描件、补充协议、验收单等"
      />
    </div>
  ) : null}
</div>
      </DataState>
    </>
  );
};

export default ContractDetailBody;