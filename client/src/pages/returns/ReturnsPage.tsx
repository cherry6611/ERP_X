import React, { useState } from 'react';
import { toast } from 'sonner';
import PageShell from '@client/src/components/PageShell';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@client/src/components/ui/dialog';
import { Input } from '@client/src/components/ui/input';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import DataBoundary from '@client/src/components/erp/DataBoundary';
import StatCard from '@client/src/components/erp/StatCard';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import * as returnsApi from '@client/src/api/returns';
import * as purApi from '@client/src/api/pur';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { cn } from '@client/src/lib/utils';
import type {
  PurchaseReturnItem,
  ReturnAction,
  ReturnRegisterResult,
  ReturnableQuantityResult,
  SalesReturnItem,
} from '@shared/api.interface';

const STATUS_LABELS: Record<string, string> = {
  draft: '草稿',
  submitted: '待审批',
  approved: '已批准',
  completed: '已完成',
  void: '已作废',
};

const STATUS_TONE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-700',
  submitted: 'bg-amber-100 text-amber-800',
  approved: 'bg-sky-100 text-sky-700',
  completed: 'bg-emerald-100 text-emerald-700',
  void: 'bg-rose-100 text-rose-700',
};

function money(value: number): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

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

  // 采购退货建单表单
  const [orderId, setOrderId] = useState('');
  const [returnable, setReturnable] = useState<ReturnableQuantityResult | null>(
    null,
  );
  const [returnQuantity, setReturnQuantity] = useState('');
  const [returnDate, setReturnDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [reason, setReason] = useState('');

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

  const loadReturnable = async (id: string) => {
    setOrderId(id);
    setReturnable(null);
    if (!id) return;
    try {
      const info = await returnsApi.getPurchaseReturnable(id);
      setReturnable(info);
      if (info.notAccepted) {
        toast.warning(
          `订单 ${info.orderCode} 尚未验收，无可退数量（退货基准是已验收数量）`,
        );
      }
    } catch (err) {
      toast.error(getApiErrorMessage(err, '查询可退数量失败'));
    }
  };

  const submitCreate = async () => {
    if (!orderId) {
      toast.error('请先选择采购订单');
      return;
    }
    const quantity = Number(returnQuantity);
    if (!Number.isInteger(quantity) || quantity <= 0) {
      toast.error('退货数量必须为大于 0 的整数');
      return;
    }
    if (returnable && quantity > returnable.returnableQuantity) {
      toast.error(
        `退货数量超过可退数量 ${returnable.returnableQuantity}（已验收 ${returnable.acceptedQuantity}，已退 ${returnable.returnedQuantity}）`,
      );
      return;
    }
    setBusy(true);
    try {
      await returnsApi.createPurchaseReturn({
        orderId,
        returnDate,
        returnQuantity: quantity,
        reason: reason || undefined,
      });
      toast.success('采购退货单已创建（草稿），提交审批后才生效');
      setCreateOpen(false);
      setOrderId('');
      setReturnable(null);
      setReturnQuantity('');
      setReason('');
      reloadAll();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '建单失败'));
    } finally {
      setBusy(false);
    }
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
                        <span
                          className={cn(
                            'rounded px-1.5 py-0.5 text-xs',
                            STATUS_TONE[row.status],
                          )}
                        >
                          {STATUS_LABELS[row.status]}
                        </span>
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
                                  STATUS_LABELS[row.status] ?? '',
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
                        <span
                          className={cn(
                            'rounded px-1.5 py-0.5 text-xs',
                            STATUS_TONE[row.status],
                          )}
                        >
                          {STATUS_LABELS[row.status]}
                        </span>
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
                                  STATUS_LABELS[row.status] ?? '',
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

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>新建采购退货</DialogTitle>
            <DialogDescription>
              可退数量 = 已验收 − 已退。未验收的货不可退（应向供应商催货或取消订单）。
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="return-order">采购订单</Label>
              <Select value={orderId} onValueChange={loadReturnable}>
                <SelectTrigger id="return-order">
                  <SelectValue placeholder="选择采购订单" />
                </SelectTrigger>
                <SelectContent>
                  {orderOptions.map((order) => (
                    <SelectItem key={order.id} value={order.id}>
                      {order.code} {order.itemName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {returnable && (
              <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <StatCard
                  label="已验收"
                  value={String(returnable.acceptedQuantity)}
                />
                <StatCard
                  label="已退"
                  value={String(returnable.returnedQuantity)}
                />
                <StatCard
                  label="可退"
                  value={String(returnable.returnableQuantity)}
                  tone={returnable.returnableQuantity > 0 ? 'success' : 'warning'}
                />
                <StatCard
                  label="含税单价 / 税率"
                  value={`${money(returnable.unitPrice)} / ${returnable.taxRate}%`}
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label htmlFor="return-qty">退货数量</Label>
                <Input
                  id="return-qty"
                  inputMode="numeric"
                  value={returnQuantity}
                  placeholder="0"
                  onChange={(event) => setReturnQuantity(event.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="return-date">退货日期</Label>
                <Input
                  id="return-date"
                  type="date"
                  value={returnDate}
                  onChange={(event) => setReturnDate(event.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="return-reason">退货原因</Label>
              <Input
                id="return-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </div>

            <p className="text-xs text-muted-foreground">
              批准并「完成」后才生成红字凭证：借 2202 应付账款（含税）/
              贷 1403 原材料（净额）+ 贷 222102 进项税额。
            </p>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateOpen(false)}
            >
              取消
            </Button>
            <Button type="button" disabled={busy} onClick={submitCreate}>
              {busy ? '创建中…' : '创建退货单'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
};

export default ReturnsPage;
