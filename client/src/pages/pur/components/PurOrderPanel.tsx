import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanRole } from '@client/src/platform/auth';
import PurStatusBadge, {
  PUR_ORDER_CATEGORY_LABELS,
  PUR_ORDER_STATUS_LABELS,
} from './PurStatusBadge';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import DateField from '@client/src/components/erp/DateField';
import { AttachmentField } from '@client/src/components/attachments/AttachmentField';
import AttachmentHint from '@client/src/components/attachments/AttachmentHint';
import { contractsApi, masterDataApi, projectsApi, purApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney, todayIso } from '@client/src/utils/format';
import type {
  AcceptPurOrderDto,
  Contract,
  CreatePurOrderDto,
  Project,
  PurOrderItem,
  Supplier,
} from '@shared/api.interface';

const orderSchema = z.object({
  supplierId: z.string().min(1, '请选择供应商'),
  contractId: z.string(),
  projectId: z.string(),
  itemName: z.string().min(1, '请填写采购品名'),
  category: z.string().min(1, '请选择采购类别'),
  quantity: z.coerce.number().int().min(1, '数量至少为 1'),
  unitPrice: z.coerce.number().min(0, '单价不能为负'),
  orderDate: z.string(),
  remark: z.string(),
});

const EMPTY_FORM = {
  supplierId: '',
  contractId: '',
  projectId: '',
  itemName: '',
  category: 'service',
  quantity: 1,
  unitPrice: 0,
  orderDate: '',
  remark: '',
};

const acceptSchema = z.object({
  quantity: z.coerce.number().int().min(1, '验收数量至少为 1'),
  acceptDate: z.string(),
});

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
  const { data: contracts } = useAsyncData<Contract[]>(
    () => contractsApi.listContracts(),
    [],
  );
  const { data: projects } = useAsyncData<Project[]>(
    () => projectsApi.listProjects(),
    [],
  );

  const form = useForm<
    z.input<typeof orderSchema>,
    unknown,
    z.output<typeof orderSchema>
  >({
    resolver: zodResolver(orderSchema),
    defaultValues: EMPTY_FORM,
  });

  const acceptForm = useForm<
    z.input<typeof acceptSchema>,
    unknown,
    z.output<typeof acceptSchema>
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

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreatePurOrderDto = {
      supplierId: values.supplierId,
      contractId: values.contractId || undefined,
      projectId: values.projectId || undefined,
      itemName: values.itemName,
      category: values.category as CreatePurOrderDto['category'],
      quantity: values.quantity,
      unitPrice: values.unitPrice,
      orderDate: values.orderDate || undefined,
      remark: values.remark || undefined,
    };
    setOperating(true);
    try {
      await purApi.createOrder(dto);
      toast.success('采购订单已创建');
      setCreateOpen(false);
      form.reset(EMPTY_FORM);
      setPage(1);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建采购订单失败');
    } finally {
      setOperating(false);
    }
  });

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

  const columns: TableColumnsType<PurOrderItem> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '采购品名', dataIndex: 'itemName', width: 160 },
    {
      title: '类别',
      dataIndex: 'category',
      width: 90,
      render: (v: string) => PUR_ORDER_CATEGORY_LABELS[v] ?? v,
    },
    { title: '供应商', dataIndex: 'supplierName', width: 130 },
    { title: '合同', dataIndex: 'contractName', width: 140, render: (v: string | null) => v ?? '-' },
    { title: '项目', dataIndex: 'projectName', width: 130, render: (v: string | null) => v ?? '-' },
    {
      title: '数量',
      key: 'quantity',
      width: 110,
      render: (_: unknown, record: PurOrderItem) =>
        `${record.acceptedQuantity} / ${record.quantity}`,
    },
    {
      title: '单价',
      dataIndex: 'unitPrice',
      width: 100,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '订单金额',
      dataIndex: 'amount',
      width: 120,
      align: 'right',
      render: (v: number) => <span className="font-medium">{formatMoney(v)}</span>,
    },
    { title: '下单日期', dataIndex: 'orderDate', width: 110, render: (v: string | null) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => (
        <PurStatusBadge status={s} labels={PUR_ORDER_STATUS_LABELS} />
      ),
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 170,
      render: (_: unknown, record: PurOrderItem) => (
        <CanRole roles={['admin']}>
          <div className="flex gap-1">
            {record.status === 'pending' ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => openAcceptDialog(record)}
                >
                  验收
                </Button>
                {record.acceptedQuantity === 0 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive"
                    onClick={() => void doCancel(record)}
                  >
                    取消
                  </Button>
                ) : null}
              </>
            ) : null}
          </div>
        </CanRole>
      ),
    },
  ];

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
        <CanRole roles={['admin']}>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="h-4 w-4" />
            新建采购订单
          </Button>
        </CanRole>
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

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>新建采购订单</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <FormField
                control={form.control}
                name="itemName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      采购品名 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="请输入采购品名" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="supplierId"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        供应商 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
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
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="category"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        采购类别 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择类别" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="service">服务类</SelectItem>
                          <SelectItem value="equipment">设备类</SelectItem>
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
                  name="contractId"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>关联合同</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择合同（可选）" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(contracts ?? []).map((c: Contract) => (
                            <SelectItem key={c.id} value={c.id}>
                              {c.code} {c.name}
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
                  name="projectId"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>关联项目</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择项目（可选）" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {(projects ?? []).map((p: Project) => (
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
              </div>
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="quantity"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        数量 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={1}
                          placeholder="请输入数量"
                          value={String(field.value ?? '')}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="unitPrice"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        单价 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
                          placeholder="请输入单价"
                          value={String(field.value ?? '')}
                          onChange={field.onChange}
                          onBlur={field.onBlur}
                          name={field.name}
                          ref={field.ref}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="orderDate"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>下单日期</FormLabel>
                      <DateField value={field.value || undefined} onChange={field.onChange} />
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="remark"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>备注</FormLabel>
                    <FormControl>
                      <Input placeholder="请输入备注" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <AttachmentHint text="保存后可在订单验收时上传订单扫描件、采购合同等附件" />
              <DialogFooter>
                <Button type="submit" disabled={operating}>
                  创建订单
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={acceptTarget !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setAcceptTarget(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>订单验收</DialogTitle>
            {acceptTarget ? (
              <DialogDescription>
                订单 {acceptTarget.code}（{acceptTarget.itemName}）：订单数量{' '}
                {acceptTarget.quantity}，已验收 {acceptTarget.acceptedQuantity}，可验收上限{' '}
                {acceptTarget.quantity - acceptTarget.acceptedQuantity}
              </DialogDescription>
            ) : null}
          </DialogHeader>
          <Form {...acceptForm}>
            <form onSubmit={onAcceptSubmit} className="space-y-4">
              <FormField
                control={acceptForm.control}
                name="quantity"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      验收数量 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={1}
                        placeholder="请输入验收数量"
                        value={String(field.value ?? '')}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={acceptForm.control}
                name="acceptDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>验收日期</FormLabel>
                    <DateField value={field.value || undefined} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
              {acceptTarget ? (
                <div className="border-t pt-4">
                  <AttachmentField
                    resourceType="pur_order"
                    resourceId={acceptTarget.id}
                    usageHint="订单扫描件、采购合同等"
                  />
                </div>
              ) : null}
              <DialogFooter>
                <Button type="submit" disabled={operating}>
                  确认验收
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default PurOrderPanel;
