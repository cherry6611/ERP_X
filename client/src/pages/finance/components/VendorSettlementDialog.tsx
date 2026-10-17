/**
 * 外协供应商结算弹窗（§5.9 / F8）。
 *
 * 从 `ApTab.tsx` 抽出的**自包含**弹窗，也是四个弹窗里唯一带副作用的一个：
 *   · 预览副作用（`useEffect` 按「供应商 + 月份 + 项目」取结算明细）；
 *   · 预览结果 / 加载中 / 生成中三个 state；
 *   · 结算明细的列定义。
 * 这些原先都散在 `ApTab` 里，抽出后与使用它们的 JSX 同处一文件。
 *
 * ⚠️ **行为零变更**：JSX、`useEffect` 与提交处理都是原块的逐字搬运 ——
 * 只做了三件事：
 *   ① 整体去掉一层缩进；
 *   ② `vendorSettlementOpen` / `setVendorSettlementOpen` 改为 props
 *      `open` / `onOpenChange`，`suppliers` / `projects` 改为同名 props；
 *   ③ `await reload()` 改为 `await onSaved()`（父组件传入的就是 `reload`）。
 *
 * ⚠️ 本组件**必须无条件挂载**（父组件不能用 `{open && <VendorSettlementDialog/>}`
 * 渲染）：预览 `useEffect` 与三个 state 原先在 `ApTab` 里是常驻的，
 * 条件挂载会改变副作用的触发时机、并在每次打开时丢掉 `settlementPreview`。
 *
 * ## 表单重置时机（刻意保持原样）
 *
 * 生成成功后重置表单（`vendorSettlementForm.reset(...)`）并清空预览，
 * 不是"打开弹窗时" —— 原实现没有 reset-on-open。
 */
import React, { useEffect, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Table, TableColumnsType } from 'antd';
import DateField from '@client/src/components/erp/DateField';
import { DataState } from '@client/src/components/DataState';
import { Button } from '@client/src/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { financeApi } from '@client/src/api';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { formatMoney, recentPeriods } from '@client/src/utils/format';
import {
  vendorSettlementSchema,
  type VendorSettlementFormData,
  type VendorSettlementFormInput,
} from '../ap-schemas';
import type {
  GenerateVendorSettlementDto,
  Project,
  Supplier,
  VendorSettlementLine,
  VendorSettlementPreview,
} from '@shared/api.interface';

/*
 * §5.9（F8）：近 12 个月期间选项改用共享的 `recentPeriods()`。
 *
 * 原来的内联实现有一个**真实 bug**：它用 `new Date(now.getFullYear(),
 * now.getMonth() - i, 1)`，即**浏览器本地时区**，而服务端的期间闸门
 * （`assertPeriodOpen`）与报表口径全按 Asia/Shanghai。跨时区用户在
 * 月初/月末的窗口内会让"当前月份"根本不在选项里（如上海已 11-01 而本地
 * 还是 10-31 → 选项从 10 月起，缺 11 月），也就无法选到本月做结算。
 *
 * 现在锚定业务时区，且该函数已有 10 条单测（`utils/format.spec.ts`）——
 * 这类"只在特定时区 + 特定时刻出现"的缺陷无法靠人工测试发现。
 */
const VENDOR_SETTLEMENT_PERIODS: string[] = recentPeriods(12);

interface VendorSettlementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 供应商选项。父组件持有查询，故允许 `undefined`（加载中） */
  suppliers: Supplier[] | undefined;
  /** 项目选项。父组件持有查询，故允许 `undefined`（加载中） */
  projects: Project[] | undefined;
  /** 生成成功后调用，父组件据此重取应付列表 */
  onSaved: () => void | Promise<void>;
}

const VendorSettlementDialog: React.FC<VendorSettlementDialogProps> = ({
  open,
  onOpenChange,
  suppliers,
  projects,
  onSaved,
}) => {
  const [settlementPreview, setSettlementPreview] = useState<VendorSettlementPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [generating, setGenerating] = useState(false);

  const vendorSettlementForm = useForm<
    VendorSettlementFormInput,
    unknown,
    VendorSettlementFormData
  >({
    resolver: zodResolver(vendorSettlementSchema),
    defaultValues: { supplierId: '', period: '', projectId: '', dueDate: '' },
  });
  const vsSupplierId: string = vendorSettlementForm.watch('supplierId');
  const vsPeriod: string = vendorSettlementForm.watch('period');
  const vsProjectId: string = vendorSettlementForm.watch('projectId') ?? '';

  useEffect(() => {
    if (!vsSupplierId || !vsPeriod) {
      setSettlementPreview(null);
      return;
    }
    let cancelled = false;
    setPreviewLoading(true);
    financeApi
      .vendorSettlementPreview(vsSupplierId, vsPeriod, vsProjectId || undefined)
      .then((data: VendorSettlementPreview) => {
        if (!cancelled) setSettlementPreview(data);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setSettlementPreview(null);
          toast.error(getApiErrorMessage(err, '获取结算明细失败'));
        }
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [vsSupplierId, vsPeriod, vsProjectId]);

  const onGenerateVendorSettlement = vendorSettlementForm.handleSubmit(
    async (values) => {
      setGenerating(true);
      try {
        const dto: GenerateVendorSettlementDto = {
          supplierId: values.supplierId,
          period: values.period,
          projectId: values.projectId || null,
          dueDate: values.dueDate,
        };
        const result = await financeApi.generateVendorSettlement(dto);
        toast.success(`结算单已生成，应付单号 ${result.code}`);
        onOpenChange(false);
        vendorSettlementForm.reset({
          supplierId: '',
          period: '',
          projectId: '',
          dueDate: '',
        });
        setSettlementPreview(null);
        await onSaved();
      } catch (err) {
        toast.error(getApiErrorMessage(err, '生成失败'));
      } finally {
        setGenerating(false);
      }
    },
  );

  const vendorSettlementLineColumns: TableColumnsType<VendorSettlementLine> = [
    { title: '员工', dataIndex: 'employeeName', width: 120 },
    { title: '角色', dataIndex: 'roleName', width: 120, render: (v) => v ?? '-' },
    { title: '工时(h)', dataIndex: 'hours', width: 90, align: 'right' },
    {
      title: '单价(元/h)',
      dataIndex: 'rate',
      width: 110,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '金额（不含税）',
      dataIndex: 'amount',
      width: 120,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>外协供应商结算</DialogTitle>
        </DialogHeader>
        <Form {...vendorSettlementForm}>
          <form onSubmit={onGenerateVendorSettlement} className="space-y-4">
            <div className="flex gap-4">
              <FormField
                control={vendorSettlementForm.control}
                name="supplierId"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      供应商{' '}
                      <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择供应商" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(suppliers ?? []).map((s) => (
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
                control={vendorSettlementForm.control}
                name="period"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>
                      月份{' '}
                      <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择月份" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {VENDOR_SETTLEMENT_PERIODS.map((p: string) => (
                          <SelectItem key={p} value={p}>
                            {p}
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
                control={vendorSettlementForm.control}
                name="projectId"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>项目（可选）</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value || undefined}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择项目" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(projects ?? []).map((p) => (
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
              <FormField
                control={vendorSettlementForm.control}
                name="dueDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>付款到期日</FormLabel>
                    <DateField value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-semibold">结算明细</h4>
              {previewLoading ? (
                <DataState loading skeleton="table" />
              ) : !settlementPreview ? (
                <p className="text-sm text-muted-foreground">
                  请选择供应商与月份后查看结算明细
                </p>
              ) : settlementPreview.lines.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  该期间无已确认的外协工时
                </p>
              ) : (
                <div className="flex flex-col gap-2">
                  <Table
                    columns={vendorSettlementLineColumns}
                    dataSource={settlementPreview.lines}
                    rowKey="employeeId"
                    pagination={false}
                    size="small"
                    scroll={{ x: 600 }}
                  />
                  <div className="flex items-center justify-end gap-8 border-t pt-2 text-sm font-semibold">
                    <span>合计</span>
                    <span>{formatMoney(settlementPreview.totalAmount)}</span>
                  </div>
                </div>
              )}
              {settlementPreview?.alreadyGenerated ? (
                <p className="text-sm text-warning">
                  该供应商该期间结算单已生成
                </p>
              ) : null}
            </div>
            <DialogFooter>
              <Button
                type="submit"
                disabled={
                  generating ||
                  previewLoading ||
                  !settlementPreview ||
                  settlementPreview.alreadyGenerated ||
                  settlementPreview.lines.length === 0
                }
              >
                生成结算单
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default VendorSettlementDialog;
