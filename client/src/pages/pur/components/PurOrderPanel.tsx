/**
 * 采购订单面板（§5.9 / F8）
 *
 * ## 本文件保留什么
 *
 * 状态 / 供应商筛选区、订单分页表格的壳、两个弹窗的挂载点；数据查询（订单列表、
 * 供应商列表）与三个写操作（创建、验收、取消）的编排。
 *
 * ## 拆到哪去了
 *
 * · 表格列定义（含打印模板与「操作」列）→ `./pur-order-columns.tsx`（工厂函数，
 *   由本文件注入 `openAcceptDialog` / `doCancel`）
 * · 新建采购订单弹窗（含 `orderSchema` / `EMPTY_FORM` / `useForm` / 提交后动作）
 *   → `./dialogs/CreatePurOrderDialog.tsx`
 * · 订单验收弹窗 → `./dialogs/AcceptOrderDialog.tsx`（`acceptSchema` 随它搬走）
 *
 * ## 两个弹窗的重置语义（拆分时逐字保留，未新增任何重置）
 *
 * · 新建弹窗：**没有**「打开时重置」。重置发生在**创建成功之后**：
 *       setCreateOpen(false);
 *       form.reset(EMPTY_FORM);
 *   因此该弹窗被无条件挂载（只用 `open` 控制显隐），关掉再打开时仍保留上次填写内容。
 * · 验收弹窗：重置在**行点击处理函数里同步执行**（不是 effect、也不是挂载时）：
 *       const openAcceptDialog = (order: PurOrderItem) => {
 *         acceptForm.reset({
 *           quantity: order.quantity - order.acceptedQuantity,
 *           acceptDate: todayIso(),
 *         });
 *         setAcceptTarget(order);
 *       };
 *   触发点在本文件（表格行 → `purOrderColumns` 注入的 `onAccept` → 这里），故
 *   `acceptForm` / `acceptTarget` / `setAcceptTarget` / `onAcceptSubmit` 以**同名 props**
 *   下沉给 `AcceptOrderDialog`，本文件仍是唯一的重置处。
 *
 * ## 已知缺陷（证据见对应文件头）
 *
 * 1. 「新建采购订单」原先**必然**被服务端以 400 拒绝：服务端 `PurService.createOrder`
 *    要求 `requestId`（F4X-7「采购订单必须关联已批准的采购申请」，`pur.service.ts:385`），
 *    而界面不采集该字段、DTO 也不带它。**已由后续一轮补齐** —— 创建弹窗新增必选
 *    「关联采购申请」，选项判据抽到零 React 依赖的 `./pur-order-rules.ts`（并配规格）。
 * 2. 验收单打印的「验收金额」与落库应付可能差 1 分（打印件对合计数量一次取整，
 *    服务端按每次验收分别取整）—— **本轮仅记录，未修**，实测数字见
 *    `./pur-order-columns.tsx` 文件头。
 */
import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import { PUR_ORDER_STATUS_LABELS } from './PurStatusBadge';
import { purOrderColumns } from './pur-order-columns';
import CreatePurOrderDialog from './dialogs/CreatePurOrderDialog';
import AcceptOrderDialog, {
  acceptSchema,
  type AcceptOrderFormData,
  type AcceptOrderFormInput,
} from './dialogs/AcceptOrderDialog';
import { Button } from '@client/src/components/ui/button';
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { masterDataApi, purApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { todayIso } from '@client/src/utils/format';
import type {
  AcceptPurOrderDto,
  PurOrderItem,
  Supplier,
} from '@shared/api.interface';

const PAGE_SIZE = 20;

const PurOrderPanel: React.FC = () => {
  const [page, setPage] = useState<number>(1);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [supplierFilter, setSupplierFilter] = useState<string>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [acceptTarget, setAcceptTarget] = useState<PurOrderItem | null>(null);
  const [operating, setOperating] = useState(false);

  const { data, loading, error, reload } = useAsyncData(
    () =>
      purApi.listOrders({
        page,
        pageSize: PAGE_SIZE,
        status: statusFilter !== 'all' ? statusFilter : undefined,
        supplierId: supplierFilter !== 'all' ? supplierFilter : undefined,
      }),
    [page, statusFilter, supplierFilter],
  );

  const { data: suppliers } = useAsyncData<Supplier[]>(
    () => masterDataApi.listSuppliers(),
    [],
  );

  const acceptForm = useForm<
    AcceptOrderFormInput,
    unknown,
    AcceptOrderFormData
  >({
    resolver: zodResolver(acceptSchema),
    defaultValues: { quantity: 1, acceptDate: todayIso() },
  });

  const openAcceptDialog = (order: PurOrderItem) => {
    acceptForm.reset({
      quantity: order.quantity - order.acceptedQuantity,
      acceptDate: todayIso(),
    });
    setAcceptTarget(order);
  };

  const onAcceptSubmit = acceptForm.handleSubmit(async (values) => {
    if (!acceptTarget) return;
    const dto: AcceptPurOrderDto = {
      quantity: values.quantity,
      acceptDate: values.acceptDate || undefined,
    };
    setOperating(true);
    try {
      await purApi.acceptOrder(acceptTarget.id, dto);
      toast.success('订单验收完成，已生成应付及联动记录');
      setAcceptTarget(null);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '验收操作失败');
    } finally {
      setOperating(false);
    }
  });

  const doCancel = async (order: PurOrderItem) => {
    try {
      await purApi.cancelOrder(order.id);
      toast.success('采购订单已取消');
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '取消订单失败');
    }
  };

  const columns = purOrderColumns({
    onAccept: openAcceptDialog,
    onCancel: doCancel,
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2">
            <Label htmlFor="pur-order-status">状态</Label>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger id="pur-order-status" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部状态</SelectItem>
                {Object.entries(PUR_ORDER_STATUS_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="pur-order-supplier">供应商</Label>
            <Select value={supplierFilter} onValueChange={setSupplierFilter}>
              <SelectTrigger id="pur-order-supplier" className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部供应商</SelectItem>
                {(suppliers ?? []).map((s: Supplier) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <CanCapabilityWrite capability="pur_asset">
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            新建采购订单
          </Button>
        </CanCapabilityWrite>
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
        dataSource={data?.items ?? []}
        loading={loading}
        rowKey="id"
        scroll={{ x: 1400, y: 480 }}
        pagination={{
          current: page,
          pageSize: PAGE_SIZE,
          total: data?.total ?? 0,
          showTotal: (t: number) => `共 ${t} 条`,
          onChange: (p: number) => setPage(p),
        }}
        locale={{ emptyText: '暂无采购订单记录，点击右上角新建采购订单' }}
      />

      <CreatePurOrderDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        suppliers={suppliers}
        orders={data?.items ?? null}
        operating={operating}
        setOperating={setOperating}
        setPage={setPage}
        reload={reload}
      />

      <AcceptOrderDialog
        acceptForm={acceptForm}
        acceptTarget={acceptTarget}
        setAcceptTarget={setAcceptTarget}
        operating={operating}
        onAcceptSubmit={onAcceptSubmit}
      />
    </div>
  );
};

export default PurOrderPanel;
