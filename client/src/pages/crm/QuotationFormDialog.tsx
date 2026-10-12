import React, { useEffect, useMemo, useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { FileDown, Loader2, Plus, Trash2 } from 'lucide-react';
import DateField from '@client/src/components/erp/DateField';
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
import { Label } from '@client/src/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@client/src/components/ui/select';
import { Button } from '@client/src/components/ui/button';
import { crmApi, masterDataApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney, formatPercent, todayIso } from '@client/src/utils/format';
import type {
  CreateQuotationDto,
  Customer,
  Opportunity,
  ParsedQuotationDraft,
  ParsedQuotationItem,
  Quotation,
  QuotationItemInput,
} from '@shared/api.interface';

const quoteSchema = z.object({
  title: z.string().min(1, '报价标题不能为空'),
  customerId: z.string().min(1, '请选择客户'),
  opportunityId: z.string(),
  quoteDate: z.string().optional(),
  validUntil: z.string().optional(),
  discountPct: z.coerce.number().min(0).max(100),
  remark: z.string(),
});

type QuoteFormData = z.output<typeof quoteSchema>;
type QuoteFormInput = z.input<typeof quoteSchema>;

interface QuotationItemRow {
  itemName: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discountPct: number;
  estUnitCost: number;
  remark: string;
}

export interface QuotationFormPreset {
  customerId?: string;
  opportunityId?: string;
  title?: string;
  quoteDate?: string;
  validUntil?: string;
  remark?: string;
  items?: QuotationItemInput[];
}

interface QuotationFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  preset?: QuotationFormPreset;
  editTarget?: Quotation | null;
  onSaved: (quotation: Quotation) => void;
}

const MARGIN_RED_LINE = 20;

const EMPTY_ITEM: QuotationItemRow = {
  itemName: '',
  unit: '人天',
  quantity: 1,
  unitPrice: 0,
  discountPct: 0,
  estUnitCost: 0,
  remark: '',
};

const toNum = (value: string): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const QuotationFormDialog: React.FC<QuotationFormDialogProps> = ({
  open,
  onOpenChange,
  preset,
  editTarget,
  onSaved,
}) => {
  const [items, setItems] = useState<QuotationItemRow[]>([EMPTY_ITEM]);
  const [docUrl, setDocUrl] = useState<string>('');
  const [parsing, setParsing] = useState<boolean>(false);

  const isValidDocUrl = docUrl.includes('/docx/');
  const showDocFormatError = docUrl.trim() !== '' && !isValidDocUrl;

  const handleDocParse = async () => {
    if (!isValidDocUrl || parsing) return;
    setParsing(true);
    try {
      const draft: ParsedQuotationDraft = await crmApi.parseQuotationDoc(docUrl);
      const current = form.getValues();
      form.reset({
        title: draft.title ?? current.title,
        customerId: current.customerId,
        opportunityId: current.opportunityId,
        quoteDate: draft.quoteDate || current.quoteDate || todayIso(),
        validUntil: draft.validUntil || current.validUntil || '',
        discountPct: current.discountPct,
        remark: draft.remark ?? current.remark,
      });
      const parsedRows: QuotationItemRow[] = draft.items.map(
        (item: ParsedQuotationItem): QuotationItemRow => ({
          itemName: item.itemName,
          unit: item.unit ?? '人天',
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discountPct: item.discountPct ?? 0,
          estUnitCost: item.estUnitCost ?? 0,
          remark: item.remark ?? '',
        }),
      );
      setItems(parsedRows.length > 0 ? parsedRows : [{ ...EMPTY_ITEM }]);
      setDocUrl('');
      toast.success('解析成功，请确认明细');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '解析失败，请稍后重试');
    } finally {
      setParsing(false);
    }
  };

  const form = useForm<QuoteFormInput, unknown, QuoteFormData>({
    resolver: zodResolver(quoteSchema),
    defaultValues: {
      title: '',
      customerId: '',
      opportunityId: '',
      quoteDate: todayIso(),
      validUntil: '',
      discountPct: 0,
      remark: '',
    },
  });

  const { data: customers } = useAsyncData<Customer[]>(
    () => masterDataApi.listCustomers(),
    [],
  );
  const { data: opportunities } = useAsyncData<Opportunity[]>(
    () => crmApi.listOpportunities(),
    [],
  );

  useEffect(() => {
    if (!open) return;
    if (editTarget) {
      form.reset({
        title: editTarget.title,
        customerId: editTarget.customerId,
        opportunityId: editTarget.opportunityId ?? '',
        quoteDate: editTarget.quoteDate ?? '',
        validUntil: editTarget.validUntil ?? '',
        discountPct: editTarget.discountPct,
        remark: editTarget.remark ?? '',
      });
      setItems(
        [...editTarget.items]
          .sort((a, b) => a.seq - b.seq)
          .map((item) => ({
            itemName: item.itemName,
            unit: item.unit,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            discountPct: item.discountPct,
            estUnitCost: item.estUnitCost,
            remark: item.remark ?? '',
          })),
      );
    } else {
      form.reset({
        title: preset?.title ?? '',
        customerId: preset?.customerId ?? '',
        opportunityId: preset?.opportunityId ?? '',
        quoteDate: preset?.quoteDate || todayIso(),
        validUntil: preset?.validUntil ?? '',
        discountPct: 0,
        remark: preset?.remark ?? '',
      });
      const presetRows: QuotationItemRow[] = (preset?.items ?? []).map(
        (item: QuotationItemInput): QuotationItemRow => ({
          itemName: item.itemName,
          unit: item.unit ?? '人天',
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discountPct: item.discountPct ?? 0,
          estUnitCost: item.estUnitCost ?? 0,
          remark: item.remark ?? '',
        }),
      );
      setItems(presetRows.length > 0 ? presetRows : [{ ...EMPTY_ITEM }]);
    }
  }, [open, editTarget, preset, form]);

  const addItem = () => {
    setItems((prev: QuotationItemRow[]) => [...prev, { ...EMPTY_ITEM }]);
  };

  const removeItem = (index: number) => {
    setItems((prev: QuotationItemRow[]) =>
      prev.filter((_: QuotationItemRow, i: number) => i !== index),
    );
  };

  const updateItem = (index: number, patch: Partial<QuotationItemRow>) => {
    setItems((prev: QuotationItemRow[]) =>
      prev.map((row: QuotationItemRow, i: number) =>
        i === index ? { ...row, ...patch } : row,
      ),
    );
  };

  const wholeDiscountPct = form.watch('discountPct');

  const totals = useMemo(() => {
    let gross = 0;
    let cost = 0;
    for (const item of items) {
      gross += item.quantity * item.unitPrice * (1 - item.discountPct / 100);
      cost += item.quantity * item.estUnitCost;
    }
    const total = gross * (1 - Number(wholeDiscountPct ?? 0) / 100);
    const marginPct = total > 0 ? ((total - cost) / total) * 100 : null;
    return { total, cost, marginPct };
  }, [items, wholeDiscountPct]);

  const belowMarginLine =
    totals.marginPct !== null && totals.marginPct < MARGIN_RED_LINE;

  const onSubmit = form.handleSubmit(async (values: QuoteFormData) => {
    if (items.length === 0) {
      toast.error('请至少添加一条明细行');
      return;
    }
    if (items.some((item: QuotationItemRow) => !item.itemName.trim())) {
      toast.error('请填写所有明细行的服务项名称');
      return;
    }
    const dto: CreateQuotationDto = {
      customerId: values.customerId,
      title: values.title,
      quoteDate: values.quoteDate || undefined,
      validUntil: values.validUntil || undefined,
      discountPct: values.discountPct,
      remark: values.remark || undefined,
      items: items.map(
        (item: QuotationItemRow): QuotationItemInput => ({
          itemName: item.itemName.trim(),
          unit: item.unit || undefined,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          discountPct: item.discountPct,
          estUnitCost: item.estUnitCost,
          remark: item.remark || undefined,
        }),
      ),
    };
    if (values.opportunityId) {
      dto.opportunityId = values.opportunityId;
    }
    try {
      const saved = editTarget
        ? await crmApi.updateQuotation(editTarget.id, dto)
        : await crmApi.createQuotation(dto);
      toast.success(editTarget ? '报价单已更新' : '报价单已创建');
      onOpenChange(false);
      onSaved(saved);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败');
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{editTarget ? '编辑报价单' : '新建报价单'}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            {!editTarget ? (
              <div className="space-y-2 rounded-md border bg-muted/40 p-3">
                <div className="flex items-center gap-2">
                  <FileDown className="h-4 w-4 text-muted-foreground" />
                  <Label htmlFor="quotation-doc-url">云文档解析</Label>
                  <span className="text-xs text-muted-foreground">
                    粘贴飞书 docx 文档链接，自动抓取报价信息填充下方表单
                  </span>
                </div>
                <div className="flex items-start gap-2">
                  <Input
                    id="quotation-doc-url"
                    placeholder="https://xxx.feishu.cn/docx/xxxx"
                    value={docUrl}
                    onChange={(e) => setDocUrl(e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => void handleDocParse()}
                    disabled={!isValidDocUrl || parsing}
                  >
                    {parsing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    {parsing ? '解析中…' : '解析并填充'}
                  </Button>
                </div>
                {showDocFormatError ? (
                  <p className="text-sm text-destructive">
                    链接格式不正确，需包含 /docx/ 路径
                  </p>
                ) : null}
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-x-4 gap-y-4">
              <FormField
                control={form.control}
                name="title"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      标题 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <FormControl>
                      <Input placeholder="如：数据中台建设一期报价" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="customerId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      客户 <span aria-hidden="true" className="text-destructive">*</span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择客户" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(customers ?? []).map((c: Customer) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.name}
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
                name="opportunityId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>关联商机</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="不关联商机" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(opportunities ?? []).map((o: Opportunity) => (
                          <SelectItem key={o.id} value={o.id}>
                            {o.title}
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
                name="quoteDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>报价日期</FormLabel>
                    <DateField value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="validUntil"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>有效期至</FormLabel>
                    <DateField value={field.value} onChange={field.onChange} />
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="discountPct"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>整单折扣（%）</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        max={100}
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
                name="remark"
                render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>备注</FormLabel>
                    <FormControl>
                      <Input placeholder="备注信息（可选）" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>明细行</Label>
                <Button type="button" variant="outline" size="sm" onClick={addItem}>
                  <Plus className="h-4 w-4" />
                  添加明细
                </Button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-muted-foreground">
                      <th className="py-1 pr-2 font-medium">服务项名称</th>
                      <th className="w-20 py-1 pr-2 font-medium">单位</th>
                      <th className="w-20 py-1 pr-2 font-medium">数量</th>
                      <th className="w-28 py-1 pr-2 font-medium">单价</th>
                      <th className="w-20 py-1 pr-2 font-medium">行折扣%</th>
                      <th className="w-28 py-1 pr-2 font-medium">预估单位成本</th>
                      <th className="py-1 pr-2 font-medium">备注</th>
                      <th className="w-10 py-1 font-medium" />
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((row: QuotationItemRow, index: number) => (
                      <tr key={index} className="border-b">
                        <td className="py-1 pr-2">
                          <Input
                            className="h-8"
                            value={row.itemName}
                            onChange={(e) =>
                              updateItem(index, { itemName: e.target.value })
                            }
                            placeholder="服务项名称"
                          />
                        </td>
                        <td className="py-1 pr-2">
                          <Input
                            className="h-8"
                            value={row.unit}
                            onChange={(e) => updateItem(index, { unit: e.target.value })}
                          />
                        </td>
                        <td className="py-1 pr-2">
                          <Input
                            className="h-8"
                            type="number"
                            min={0}
                            value={String(row.quantity)}
                            onChange={(e) =>
                              updateItem(index, { quantity: toNum(e.target.value) })
                            }
                          />
                        </td>
                        <td className="py-1 pr-2">
                          <Input
                            className="h-8"
                            type="number"
                            min={0}
                            value={String(row.unitPrice)}
                            onChange={(e) =>
                              updateItem(index, { unitPrice: toNum(e.target.value) })
                            }
                          />
                        </td>
                        <td className="py-1 pr-2">
                          <Input
                            className="h-8"
                            type="number"
                            min={0}
                            max={100}
                            value={String(row.discountPct)}
                            onChange={(e) =>
                              updateItem(index, { discountPct: toNum(e.target.value) })
                            }
                          />
                        </td>
                        <td className="py-1 pr-2">
                          <Input
                            className="h-8"
                            type="number"
                            min={0}
                            value={String(row.estUnitCost)}
                            onChange={(e) =>
                              updateItem(index, { estUnitCost: toNum(e.target.value) })
                            }
                          />
                        </td>
                        <td className="py-1 pr-2">
                          <Input
                            className="h-8"
                            value={row.remark}
                            onChange={(e) => updateItem(index, { remark: e.target.value })}
                          />
                        </td>
                        <td className="py-1">
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`删除明细 ${index + 1}`}
                            onClick={() => removeItem(index)}
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-x-6 gap-y-1 border-t pt-3 text-sm">
              <span>
                报价总额：
                <span className="font-semibold">{formatMoney(totals.total)}</span>
              </span>
              <span>
                预估成本：
                <span className="font-semibold">{formatMoney(totals.cost)}</span>
              </span>
              <span className={belowMarginLine ? 'text-destructive' : ''}>
                毛利率：
                <span className="font-semibold">
                  {totals.marginPct === null ? '-' : formatPercent(totals.marginPct)}
                </span>
                {belowMarginLine ? '（低于毛利红线）' : ''}
              </span>
            </div>

            <DialogFooter>
              <Button type="submit">{editTarget ? '保存修改' : '保存'}</Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
};

export default QuotationFormDialog;
