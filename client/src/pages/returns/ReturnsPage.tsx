import React, { useState } from 'react';
import { toast } from 'sonner';
import PageShell from '@client/src/components/PageShell';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import StatCard from '@client/src/components/erp/StatCard';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import * as returnsApi from '@client/src/api/returns';
import * as purApi from '@client/src/api/pur';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import {
  RETURN_ACTION_LABELS,
  RETURN_STATUS_LABELS,
  STATUS_VARIANTS,
} from '@client/src/utils/biz-labels';
import { Badge } from '@client/src/components/ui/badge';
import { cn } from '@client/src/lib/utils';
import { money } from './components/returns-format';
import PurchaseReturnCreateDialog from './components/PurchaseReturnCreateDialog';
import type {
  PurchaseReturnItem,
  ReturnAction,
  ReturnRegisterResult,
  SalesReturnItem,
} from '@shared/api.interface';

/*
 * F7（§5.8）：状态标签与色表**不再内联**。
 *
 * 标签改为走 `biz-labels.ts` 的 `RETURN_STATUS_LABELS`（字典优先、常量兜底）：
 * 原先这份字面量意味着业务方在「设置 → 字典」改了文案，本页**不生效** ——
 * 那正是 B-05 要消除的问题。
 *
 * 色表改为用语义 `Badge` variant（`STATUS_VARIANTS`）：原先的
 * `bg-emerald-100` 这类固定色阶**不跟随主题**（没有 `dark:` 变体），
 */

/** 各状态允许的动作（与后端状态机同源；后端仍会二次校验） */
function allowedActions(status: string): ReturnAction[] {
  switch (status) {
    case 'draft':
      return ['submit', 'void'];
    case 'submitted':
      return ['approve', 'reject', 'void'];
    case 'approved':
      return ['complete', 'void'];
    default:
      return [];
  }
}

/**
 * C-05：采购/销售退货闭环。
 *
 * 设计要点：
 * 1. **建单前先查可退数量**：可退 = 已验收 − 已退。少扣一次已退就会超退，
 *    因此采购退货必须先选订单、看到"可退 N"才能填数量，且前端也做上限校验
 *    （后端仍会再校验一次，前端校验只是体验）。
 * 2. **动作按钮由状态派生**：草稿只能提交/作废，待审才能批准/驳回，
 *    已批准才能完成（完成才出红字凭证）。
 * 3. **完成后不可作废**：已生成红字凭证，必须先作废凭证（与后端状态机一致）。
 */
const ReturnsPage: React.FC = () => {
  const [tab, setTab] = useState<'purchase' | 'sales'>('purchase');
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // 销售退货“完成”前必须逐单确定退回商品的处置方式（决定成本冲回的对方科目）
  const [completeTarget, setCompleteTarget] = useState<SalesReturnItem | null>(
    null,
  );
  const [disposalType, setDisposalType] = useState<'restock' | 'scrap'>(
    'restock',
  );

  const { data: register, reload: reloadRegister } =
    useAsyncData<ReturnRegisterResult>(() => returnsApi.getReturnRegister(), []);
  const {
    data: purchases,
    loading: purchaseLoading,
    error: purchaseError,
    reload: reloadPurchases,
  } = useAsyncData(() => returnsApi.listPurchaseReturns({ pageSize: 200 }), []);
  const {
    data: sales,
    loading: salesLoading,
    error: salesError,
    reload: reloadSales,
  } = useAsyncData(() => returnsApi.listSalesReturns({ pageSize: 200 }), []);
  const { data: orders } = useAsyncData(
    () => purApi.listOrders({ pageSize: 200 }),
    [],
  );

  const purchaseRows: PurchaseReturnItem[] = purchases?.items ?? [];
  const salesRows: SalesReturnItem[] = sales?.items ?? [];
  const orderOptions = orders?.items ?? [];

  const reloadAll = () => {
    reloadPurchases();
    reloadSales();
    reloadRegister();
  };

  const runAction = async (
    kind: 'purchase' | 'sales',
    id: string,
    action: ReturnAction,
    label: string,
    disposal?: 'restock' | 'scrap',
  ) => {
    try {
      if (kind === 'purchase') {
        await returnsApi.purchaseReturnAction(id, action);
      } else {
        await returnsApi.salesReturnAction(id, action, undefined, disposal);
      }
      toast.success(`${label}成功`);
      reloadAll();
    } catch (err) {
      toast.error(getApiErrorMessage(err, `${label}失败`));
    }
  };

  return (
    <PageShell
      title="退货管理"
      description="采购退货（冲减应付与库存）与销售退货（红冲收入与应收）的申请、审批与红字凭证"
      actions={
        tab === 'purchase' ? (
          <Button type="button" onClick={() => setCreateOpen(true)}>
            新建采购退货
          </Button>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-6">
        <div className="flex gap-2">
          {(['purchase', 'sales'] as const).map((key) => (
            <Button
              key={key}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setTab(key)}
              className={cn(
                tab === key
                  ? 'bg-primary/10 font-medium text-primary'
                  : 'text-foreground/80',
              )}
            >
              {key === 'purchase' ? '采购退货' : '销售退货'}
            </Button>
          ))}
        </div>

        {register && (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard
              label="采购退货总额"
              value={money(register.purchase.totalAmount)}
              tone="warning"
            />
            <StatCard
              label="采购退货已完成"
              value={money(register.purchase.completedAmount)}
            />
            <StatCard
              label="销售退货总额"
              value={money(register.sales.totalAmount)}
              tone="info"
            />
            <StatCard
              label="销售退货已完成"
              value={money(register.sales.completedAmount)}
            />
          </div>
        )}

        {tab === 'purchase' ? (
          <DataBoundary
            loading={purchaseLoading}
            error={purchaseError}
            empty={purchaseRows.length === 0}
            emptyText="暂无采购退货单"
            onRetry={reloadPurchases}
          >
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left">
                    <th className="p-2 font-medium">退货单号</th>
                    <th className="p-2 font-medium">原订单</th>
                    <th className="p-2 font-medium">供应商</th>
                    <th className="p-2 font-medium">退货日期</th>
                    <th className="p-2 text-right font-medium">数量</th>
                    <th className="p-2 text-right font-medium">含税金额</th>
                    <th className="p-2 text-right font-medium">净额/税额</th>
                    <th className="p-2 font-medium">状态</th>
                    <th className="p-2 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {purchaseRows.map((row) => (
                    <tr key={row.id} className="border-t">
                      <td className="p-2 font-mono text-xs">{row.code}</td>
                      <td className="p-2">{row.orderCode ?? '—'}</td>
                      <td className="p-2">{row.supplierName ?? '—'}</td>
                      <td className="p-2">{row.returnDate}</td>
                      <td className="p-2 text-right tabular-nums">
                        {row.returnQuantity}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {money(row.amount)}
                      </td>
                      <td className="p-2 text-right text-xs tabular-nums">
                        {money(row.netAmount)} / {money(row.taxAmount)}
                      </td>
                      <td className="p-2">
                        <Badge variant={STATUS_VARIANTS[row.status] ?? 'secondary'}>
                          {RETURN_STATUS_LABELS[row.status] ?? row.status}
                        </Badge>
                        {row.status === 'completed' && !row.voucherRef && (
                          <div className="text-xs text-amber-600">
                            凭证待补录
                          </div>
                        )}
                      </td>
                      <td className="p-2">
                        <div className="flex flex-wrap gap-1">
                          {allowedActions(row.status).map((action) => (
                            <Button
                              key={action}
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-6 px-1.5 text-xs"
                              onClick={() =>
                                runAction(
                                  'purchase',
                                  row.id,
                                  action,
                                  RETURN_ACTION_LABELS[action],
                                )
                              }
                            >
                              {action === 'submit'
                                ? '提交'
                                : action === 'approve'
                                  ? '批准'
                                  : action === 'reject'
                                    ? '驳回'
                                    : action === 'complete'
                                      ? '完成'
                                      : '作废'}
                            </Button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </DataBoundary>
        ) : (
          <DataBoundary
            loading={salesLoading}
            error={salesError}
            empty={salesRows.length === 0}
            emptyText="暂无销售退货单"
            onRetry={reloadSales}
          >
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm">
                <thead className="bg-muted/50">
                  <tr className="text-left">
                    <th className="p-2 font-medium">退货单号</th>
                    <th className="p-2 font-medium">收入确认单</th>
                    <th className="p-2 font-medium">客户</th>
                    <th className="p-2 font-medium">退货日期</th>
                    <th className="p-2 text-right font-medium">含税金额</th>
                    <th className="p-2 text-right font-medium">净额/税额</th>
                    <th className="p-2 font-medium">状态</th>
                    <th className="p-2 font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {salesRows.map((row) => (
                    <tr key={row.id} className="border-t">
                      <td className="p-2 font-mono text-xs">{row.code}</td>
                      <td className="p-2">{row.revenueCode ?? '—'}</td>
                      <td className="p-2">{row.customerName ?? '—'}</td>
                      <td className="p-2">{row.returnDate}</td>
                      <td className="p-2 text-right tabular-nums">
                        {money(row.amount)}
                      </td>
                      <td className="p-2 text-right text-xs tabular-nums">
                        {money(row.netAmount)} / {money(row.taxAmount)}
                      </td>
                      <td className="p-2">
                        <Badge variant={STATUS_VARIANTS[row.status] ?? 'secondary'}>
                          {RETURN_STATUS_LABELS[row.status] ?? row.status}
                        </Badge>
                      </td>
                      <td className="p-2">
                        <div className="flex flex-wrap gap-1">
                          {allowedActions(row.status).map((action) => (
                            <Button
                              key={action}
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-6 px-1.5 text-xs"
                              onClick={() => {
                                // 完成才出红字凭证（含成本冲回），必须先定处置方式
                                if (action === 'complete') {
                                  setDisposalType(
                                    row.disposalType === 'scrap'
                                      ? 'scrap'
                                      : 'restock',
                                  );
                                  setCompleteTarget(row);
                                  return;
                                }
                                runAction(
                                  'sales',
                                  row.id,
                                  action,
                                  RETURN_ACTION_LABELS[action],
                                );
                              }}
                            >
                              {action === 'submit'
                                ? '提交'
                                : action === 'approve'
                                  ? '批准'
                                  : action === 'reject'
                                    ? '驳回'
                                    : action === 'complete'
                                      ? '完成'
                                      : '作废'}
                            </Button>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              销售退货完成时红冲收入与应收，并按所选处置方式同步冲回成本
              （回库：借 1403 原材料 / 报废：借 6602 管理费用，均贷 6401）；
              成本金额按项目累计成本 × 退货净额占项目净收入的比例自动分摊。
            </p>
          </DataBoundary>
        )}
      </div>

      {/* 销售退货完成：逐单选择退回商品处置方式，决定成本冲回的对方科目 */}
      <Dialog
        open={completeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setCompleteTarget(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>完成销售退货 {completeTarget?.code}</DialogTitle>
            <DialogDescription>
              退回商品是否还能再售必须逐单判定：一律按回库处理会把报废退货挂成库存，
              一律按报废处理会把可再售退货计成费用。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-2">
              <Button
                type="button"
                variant={disposalType === 'restock' ? 'default' : 'outline'}
                onClick={() => setDisposalType('restock')}
              >
                回库可再售（借 1403 原材料）
              </Button>
              <Button
                type="button"
                variant={disposalType === 'scrap' ? 'default' : 'outline'}
                onClick={() => setDisposalType('scrap')}
              >
                报废（借 6602 管理费用）
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              两种方式都会贷记 6401 主营业务成本；项目无收入或成本数据时金额记 0，
              本次不生成成本行（后端会记录告警）。
            </p>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setCompleteTarget(null)}
              >
                取消
              </Button>
              <Button
                type="button"
                disabled={busy}
                onClick={async () => {
                  const target = completeTarget;
                  if (!target) return;
                  setBusy(true);
                  await runAction(
                    'sales',
                    target.id,
                    'complete',
                    '完成退货',
                    disposalType,
                  );
                  setBusy(false);
                  setCompleteTarget(null);
                }}
              >
                确认完成并生成红字凭证
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/*
        §5.9 / F8：新建采购退货弹窗（表单 state、loadReturnable、submitCreate 与
        JSX）整体搬到 ./components/PurchaseReturnCreateDialog。这里**无条件挂载**：
        它的 5 个 useState 原先是页面组件的常驻 state，条件挂载会让表单随开关重建。
      */}
      <PurchaseReturnCreateDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        orderOptions={orderOptions}
        busy={busy}
        setBusy={setBusy}
        reloadAll={reloadAll}
      />
    </PageShell>
  );
};

export default ReturnsPage;
