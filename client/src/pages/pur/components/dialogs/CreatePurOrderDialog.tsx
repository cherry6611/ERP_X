/**
 * 「新建采购订单」弹窗（§5.9 / F8）
 *
 * 从 `PurOrderPanel.tsx` 抽出的弹窗（原 `<Dialog open={createOpen}>`，原文件 467-674 行），
 * 连同它的 `orderSchema`、`EMPTY_FORM`、`useForm` 与提交处理器
 * （原文件 56-78、119-126、145-170 行）。抽出的理由：主文件原先同时承载
 * 「筛选区 + 190 行列定义 + 两个弹窗」，一个 `<Dialog>` 块里混着 schema / 表单 /
 * DTO 组装 / 提交后动作（关弹窗、重置、回第 1 页、重取列表）；抽出后
 * 「表单字段 → schema → DTO → 提交后动作」四件事就近可读。
 *
 * ## 为什么本组件自持 `useForm`，而验收弹窗不自持
 *
 * 本弹窗的重置发生在**创建成功之后**：
 *
 *     setCreateOpen(false);
 *     form.reset(EMPTY_FORM);
 *     setPage(1);
 *     await reload();
 *
 * 触发点就在本组件内部，可以整体搬走；而验收弹窗的重置发生在**行点击处理函数里**，
 * 触发点在父组件，故那边的表单实例以下沉 props 传入（见 `AcceptOrderDialog.tsx`）。
 * 本组件**无条件挂载**（父组件始终渲染它，只用 `open` 控制显隐）—— 与拆分前一致：
 * 两个下拉的取数时机不变，且关闭弹窗再打开时**保留**上次填写的内容（原实现不重置）。
 *
 * ⚠️ **行为零变更**：JSX 与 schema 逐字搬运，只做了三件事 ——
 *   ① 整体去掉一层缩进（2 个空格）；
 *   ② `createOpen` / `setCreateOpen` / `operating` / `setOperating` / `setPage` /
 *      `reload` / `suppliers` 由父组件的 props 提供（`open` / `onOpenChange` 是本仓弹窗
 *      的约定命名，在解构处绑回原变量名 `createOpen` / `setCreateOpen`，故下面每一行都是原文）；
 *   ③ `contracts` / `projects` 两个下拉的数据查询随本组件搬走（父组件只用 `suppliers`
 *      一处：筛选区的供应商下拉），挂载时机不变。
 *
 * ## F4X-7 缺口已修（本文件原注释记录为"已知缺陷，未修"）
 *
 * 拆分当时记录过：服务端 `PurService.createOrder` 在缺少 `requestId` 时拒绝下单
 * （F4X-7「采购订单必须关联已批准的采购申请」，`server/modules/pur/pur.service.ts:385`），
 * 而本弹窗 —— 全仓**唯一**的采购订单创建入口 —— 既没有「关联采购申请」字段，
 * 提交的 DTO 也不含 `requestId`，因此**每次创建都被 400 拒绝**。
 *
 * 现已补齐：① 必选下拉「关联采购申请」；② `orderSchema` / `EMPTY_FORM` / DTO
 * 都带上 `requestId`；③ 选项过滤复用纯函数模块
 * `../pur-order-rules`（与服务端判据逐条对齐，并配规格）。
 *
 * 选项取数：`listRequests({ status: 'approved', pageSize: 100 })` —— 服务端
 * `normalizePaging` 的上限就是 100（`pur.service.ts:92 MAX_PAGE_SIZE`），
 * 故直接请求上限而不是传一个会被静默截断的更大值。为判断"一申请一有效订单"，
 * 同时取订单列表（父组件已有一份，这里复用父组件传入的 `orders` 以免重复请求）。
 */
import React from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { contractsApi, masterDataApi, projectsApi, purApi } from '@client/src/api';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import DateField from '@client/src/components/erp/DateField';
import AttachmentHint from '@client/src/components/attachments/AttachmentHint';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import type {
  Contract,
  CreatePurOrderDto,
  Project,
  PurOrderItem,
  Supplier,
} from '@shared/api.interface';
import { orderableRequestOptions } from '../pur-order-rules';

const orderSchema = z.object({
  /*
   * F4X-7：服务端强制要求关联**已批准**的采购申请，故这里是必填。
   * 报错文案与仓内其它必选下拉一致（「请选择…」）。
   */
  requestId: z.string().min(1, '请选择采购申请'),
  supplierId: z.string().min(1, '请选择供应商'),
  contractId: z.string(),
  projectId: z.string(),
  taxEntityId: z.string(),
  itemName: z.string().min(1, '请填写采购品名'),
  category: z.string().min(1, '请选择采购类别'),
  quantity: z.coerce.number().int().min(1, '数量至少为 1'),
  unitPrice: z.coerce.number().min(0, '单价不能为负'),
  orderDate: z.string(),
  remark: z.string(),
});

const EMPTY_FORM = {
  requestId: '',
  supplierId: '',
  contractId: '',
  projectId: '',
  taxEntityId: '',
  itemName: '',
  category: 'service',
  quantity: 1,
  unitPrice: 0,
  orderDate: '',
  remark: '',
};

interface CreatePurOrderDialogProps {
  /** 父组件的 `createOpen` */
  open: boolean;
  /** 父组件的 `setCreateOpen` */
  onOpenChange: (open: boolean) => void;
  /** 供应商列表：筛选区也用同一份数据，故由父组件取数后传入 */
  suppliers: Supplier[] | null;
  /**
   * 订单列表：用于判断"一申请一有效订单"（哪些已批准申请已被占用）。
   * 父组件已为表格取过同一份数据，故传入复用，避免重复请求。
   */
  orders: PurOrderItem[] | null;
  /** 提交中标记：两个弹窗与拆分前一样共用父组件的一个 state */
  operating: boolean;
  setOperating: (operating: boolean) => void;
  /** 父组件的 `setPage`：创建成功后回到第 1 页（与原实现一致） */
  setPage: (page: number) => void;
  /** 父组件订单列表的 `reload`（`useAsyncData` 的 `reload`，返回 Promise） */
  reload: () => Promise<void>;
}

const CreatePurOrderDialog: React.FC<CreatePurOrderDialogProps> = ({
  open: createOpen,
  onOpenChange: setCreateOpen,
  suppliers,
  orders,
  operating,
  setOperating,
  setPage,
  reload,
}) => {
  const { data: contracts } = useAsyncData<Contract[]>(
    () => contractsApi.listContracts(),
    [],
  );
  const { data: projects } = useAsyncData<Project[]>(
    () => projectsApi.listProjects(),
    [],
  );
  /*
   * 已批准的采购申请（服务端上限 100，故 pageSize 直接取 100）。
   * 过滤规则见 `../pur-order-rules`：approved 且未被非取消订单占用。
   */
  const { data: taxEntities } = useAsyncData(() => masterDataApi.listTaxEntities(), []);
  const { data: approvedRequests } = useAsyncData(
    () => purApi.listRequests({ status: 'approved', pageSize: 100 }),
    [],
  );
  const requestOptions = orderableRequestOptions(
    approvedRequests?.items,
    orders,
  );

  const form = useForm<
    z.input<typeof orderSchema>,
    unknown,
    z.output<typeof orderSchema>
  >({
    resolver: zodResolver(orderSchema),
    defaultValues: EMPTY_FORM,
  });

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreatePurOrderDto = {
      /* F4X-7：服务端强制要求，缺它必被 400 拒绝 */
      requestId: values.requestId,
      supplierId: values.supplierId,
      contractId: values.contractId || undefined,
      projectId: values.projectId || undefined,
      taxEntityId: values.taxEntityId || undefined,
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

  return (
    <Dialog open={createOpen} onOpenChange={setCreateOpen}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>新建采购订单</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            {/*
             * F4X-7：必须关联已批准的采购申请。放在最前，因为它是
             * 「这张订单从哪来」的前提；选不到选项时给出明确空态提示，
             * 而不是让使用者面对一个空下拉。
             */}
            <FormField
              control={form.control}
              name="requestId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>
                    关联采购申请 <span aria-hidden="true" className="text-destructive">*</span>
                  </FormLabel>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue
                          placeholder={
                            requestOptions.length === 0
                              ? '暂无可下单的采购申请'
                              : '请选择已批准的采购申请'
                          }
                        />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {requestOptions.map((r) => (
                        <SelectItem key={r.id} value={r.id}>
                          {r.label}
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
                      单价（含税）{' '}
                      <span aria-hidden="true" className="text-destructive">*</span>
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
              name="taxEntityId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>我方纳税主体</FormLabel>
                  <Select value={field.value || undefined} onValueChange={field.onChange}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="默认用项目合同主体，可改" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {(taxEntities ?? [])
                        .filter((entity) => entity.status === 'active')
                        .map((entity) => (
                          <SelectItem key={entity.id} value={entity.id}>
                            {entity.name}
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
  );
};

export default CreatePurOrderDialog;
