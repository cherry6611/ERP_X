import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { Table } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { financeApi, masterDataApi, projectsApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import type {
  ChainApItem,
  ChainArItem,
  PaymentItem,
  ReceiptItem,
  Supplier,
} from '@shared/api.interface';
import { openArItems, payableApItems } from './ar-ap-model';
import { arApColumns } from './ar-ap-columns';
import ArDialog from './dialogs/ArDialog';
import ApDialog from './dialogs/ApDialog';
import PaymentDialog from './dialogs/PaymentDialog';
import ReceiptDialog from './dialogs/ReceiptDialog';

/*
 * §5.9（F8）：本文件原先自带的四份表单 schema、四张表的状态标签与四张表的
 * 列定义（合计约 190 行声明）已移到 `./ar-ap-model`。
 *
 * 搬走的原因与收益：
 *   · 组件文件的开头全是声明，打开文件先看到声明才看到组件；
 *   · 那一块**零 React 依赖**，搬走后立刻可单测（`ar-ap-model.spec.ts`），
 *     而它恰恰是"改错了界面上看不出来"的重灾区 —— schema 的金额门槛、
 *     状态标签有没有漏键、列取错字段（表格照样渲染，只是数字落在错的列里）。
 *
 * 但只搬声明不够：文件仍然 886 行 —— 占体量的从来不是声明，而是
 * **四段 `<Dialog>` JSX（419 行）与四个提交处理器（84 行）**。本轮把它们整体
 * 搬到 `./dialogs/`（四个弹窗各自持有 `useForm`、提交处理器与渲染），列定义
 * （含状态 / 责任人的 JSX 渲染）搬到 `./ar-ap-columns`。
 *
 *   · 本文件保留：数据查询（`useAsyncData`）、过滤后的候选集（`openArs` /
 *     `payableAps`）、两张表的分组编排与四段弹窗各自的 `open` state ——
 *     也就是"区块级编排"；
 *   · 子组件只拿**数据**与 `onSaved`（写成功后由本文件重取三份数据并回调
 *     `onChanged` 联动顶部财务卡），不再由本文件传入 setter。
 *
 * ⚠️ 三个必须保住的语义（搬迁时逐条核对）：
 *   ① 四个弹窗**无条件挂载**，不能写成 `{open && <ArDialog />}` —— `useForm`
 *      状态原先常驻在父组件，条件挂载会让"提交失败后关掉弹窗"丢掉已填内容；
 *   ② 表单重置时机不变：都在**提交成功之后**（`toast.success` → 关闭 → reset
 *      → 重取）。原实现**没有** reset-on-open，关闭再打开会保留上次输入；
 *   ③ JSX 文案、schema、校验消息逐字未动，`ar-ap-model.ts` 仍是唯一定义处。
 */

interface ArApSectionProps {
  projectId: string;
  onChanged?: () => void;
}

const ArApSection: React.FC<ArApSectionProps> = ({ projectId, onChanged }) => {
  const [arOpen, setArOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [apOpen, setApOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);

  const { data: chain, loading, error, reload } = useAsyncData(
    () => projectsApi.getProjectChain(projectId),
    [projectId],
  );
  const customerId: string | undefined = chain?.customer?.id ?? undefined;
  const contractId: string = chain?.contract?.id ?? '';
  const { data: suppliers } = useAsyncData<Supplier[]>(
    () => masterDataApi.listSuppliers(),
    [],
  );
  const { data: receipts, reload: reloadReceipts } = useAsyncData<ReceiptItem[]>(
    () => (customerId ? financeApi.listReceipts(customerId) : Promise.resolve([])),
    [customerId],
  );
  const { data: payments, reload: reloadPayments } = useAsyncData<PaymentItem[]>(
    () => financeApi.listPayments(),
    [],
  );

  const arItems: ChainArItem[] = chain?.arItems ?? [];
  const apItems: ChainApItem[] = chain?.apItems ?? [];
  const apIds: string[] = apItems.map((a: ChainApItem) => a.id);
  const projectPayments: PaymentItem[] = (payments ?? []).filter(
    (p: PaymentItem) => apIds.includes(p.apId),
  );
  const openArs: ChainArItem[] = openArItems(arItems);
  const payableAps: ChainApItem[] = payableApItems(apItems);

  const refreshAll = async () => {
    await Promise.all([reload(), reloadReceipts(), reloadPayments()]);
    onChanged?.();
  };

  /*
   * 四张表的列定义（结构 / 取值 / JSX 渲染）在 `./ar-ap-columns`：
   * 结构取自 `./ar-ap-model` 的 `*TableMeta`，取值取自 `AR_AP_COLUMN_VALUES`
   * （规格读的是同一份），列头、列序、列宽、对齐、固定列与原实现逐字一致。
   *
   * 这里每次渲染现算一次（与原先"每次渲染现算四个常量数组"完全一致）——
   * 刻意不加 `useMemo`：那会改变列的引用稳定性，属于拆分之外的行为改动。
   */
  const { arColumns, receiptColumns, apColumns, paymentColumns } = arApColumns();

  return (
    <Card>
      <CardHeader className="space-y-1">
        <CardTitle className="text-base font-semibold">应收 / 应付</CardTitle>
        <CardDescription>
          应收未回款 {formatMoney(chain?.arOpenAmount ?? 0)}，应付未付{' '}
          {formatMoney(chain?.apOpenAmount ?? 0)}
          {customerId ? `，客户：${chain?.customer?.name ?? ''}` : '，项目未关联客户'}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {error ? (
          <p className="text-sm text-destructive">
            {error}
            <Button
              variant="ghost"
              size="sm"
              className="ml-2"
              onClick={() => void reload()}
            >
              重试
            </Button>
          </p>
        ) : null}
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold">应收 / 回款</h4>
            <div className="flex items-center gap-2">
              <CanCapabilityWrite capability="finance_write">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!contractId}
                  onClick={() => setArOpen(true)}
                >
                  <Plus className="h-4 w-4" />
                  登记应收
                </Button>
              </CanCapabilityWrite>
              <CanCapabilityWrite capability="finance_write">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!customerId}
                  onClick={() => setReceiptOpen(true)}
                >
                  <Plus className="h-4 w-4" />
                  登记回款
                </Button>
              </CanCapabilityWrite>
            </div>
          </div>
          <Table
            columns={arColumns}
            dataSource={arItems}
            loading={loading}
            rowKey="id"
            scroll={{ x: 800, y: 300 }}
            pagination={{ pageSize: 5, showTotal: (t: number) => `共 ${t} 条` }}
            locale={{ emptyText: '暂无应收，点击「登记应收」创建' }}
          />
          <Table
            columns={receiptColumns}
            dataSource={receipts ?? []}
            rowKey="id"
            scroll={{ x: 800, y: 300 }}
            pagination={{ pageSize: 5, showTotal: (t: number) => `共 ${t} 条` }}
            locale={{ emptyText: '暂无回款记录' }}
            size="small"
          />
        </div>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-semibold">应付 / 付款</h4>
            <div className="flex items-center gap-2">
              <CanCapabilityWrite capability="finance_write">
                <Button variant="outline" size="sm" onClick={() => setApOpen(true)}>
                  <Plus className="h-4 w-4" />
                  登记应付
                </Button>
              </CanCapabilityWrite>
              <CanCapabilityWrite capability="finance_write">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={payableAps.length === 0}
                  onClick={() => setPaymentOpen(true)}
                >
                  <Plus className="h-4 w-4" />
                  登记付款
                </Button>
              </CanCapabilityWrite>
            </div>
          </div>
          <Table
            columns={apColumns}
            dataSource={apItems}
            loading={loading}
            rowKey="id"
            scroll={{ x: 900, y: 300 }}
            pagination={{ pageSize: 5, showTotal: (t: number) => `共 ${t} 条` }}
            locale={{ emptyText: '暂无应付，点击「登记应付」创建' }}
          />
          <Table
            columns={paymentColumns}
            dataSource={projectPayments}
            rowKey="id"
            scroll={{ x: 800, y: 300 }}
            pagination={{ pageSize: 5, showTotal: (t: number) => `共 ${t} 条` }}
            locale={{ emptyText: '暂无付款记录' }}
            size="small"
          />
        </div>
      </CardContent>

      <ArDialog
        open={arOpen}
        onOpenChange={setArOpen}
        projectId={projectId}
        contractId={contractId}
        chain={chain}
        onSaved={refreshAll}
      />

      <ReceiptDialog
        open={receiptOpen}
        onOpenChange={setReceiptOpen}
        customerId={customerId}
        openArs={openArs}
        onSaved={refreshAll}
      />

      <ApDialog
        open={apOpen}
        onOpenChange={setApOpen}
        projectId={projectId}
        suppliers={suppliers}
        onSaved={refreshAll}
      />

      <PaymentDialog
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
        payableAps={payableAps}
        onSaved={refreshAll}
      />
    </Card>
  );
};

export default ArApSection;
