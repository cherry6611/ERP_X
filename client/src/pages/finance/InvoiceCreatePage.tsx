import React, { useEffect, useMemo, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import PageShell from '@client/src/components/PageShell';
import StickyActionBar from '@client/src/components/erp/StickyActionBar';
import { Explained } from '@client/src/components/erp/ItemHelp';
import { Button } from '@client/src/components/ui/button';
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
import { Textarea } from '@client/src/components/ui/textarea';
import { contractsApi, financeApi, masterDataApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatTaxSplitLine } from '@client/src/utils/tax-display';
import {
  resolveFormTaxRate,
  resolveRateOptions,
  resolveTaxEntity,
} from '@client/src/utils/tax-rate-options';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { VAT_RATES } from '@shared/tax';
import type {
  ArItem,
  Contract,
  CreateInvoiceDto,
  Supplier,
  TaxEntity,
} from '@shared/api.interface';

const invoiceSchema = z
  .object({
    direction: z.enum(['sales', 'purchase']),
    contractId: z.string(),
    supplierId: z.string(),
    invoiceType: z.string().min(1, '请选择发票类型'),
    amount: z.coerce.number().min(0.01, '开票金额必须大于 0'),
    taxRate: z.coerce
      .number()
      .refine(
        (value) => (VAT_RATES as readonly number[]).includes(value),
        '请选择合法税率',
      ),
    arId: z.string(),
    invoiceNo: z.string(),
    invoiceDate: z.string(),
    remark: z.string(),
  })
  .superRefine((val, ctx) => {
    if (val.direction === 'sales' && !val.contractId) {
      ctx.addIssue({
        code: 'custom',
        path: ['contractId'],
        message: '请选择合同',
      });
    }
    if (val.direction === 'purchase' && !val.supplierId) {
      ctx.addIssue({
        code: 'custom',
        path: ['supplierId'],
        message: '请选择供应商',
      });
    }
  });

type InvoiceFormData = z.output<typeof invoiceSchema>;
type InvoiceFormInput = z.input<typeof invoiceSchema>;

const FORM_DEFAULTS: InvoiceFormInput = {
  direction: 'sales',
  contractId: '',
  supplierId: '',
  invoiceType: 'vat_special',
  amount: 0,
  taxRate: 6,
  arId: 'none',
  invoiceNo: '',
  invoiceDate: '',
  remark: '',
};

const InvoiceCreatePage: React.FC = () => {
  const navigate = useNavigate();
  const { data: contracts } = useAsyncData<Contract[]>(
    () => contractsApi.listContracts(),
    [],
  );
  const { data: suppliers } = useAsyncData<Supplier[]>(
    () => masterDataApi.listSuppliers(),
    [],
  );
  const { data: taxEntities } = useAsyncData<TaxEntity[]>(
    () => masterDataApi.listTaxEntities(),
    [],
  );
  const { data: ars } = useAsyncData<ArItem[]>(() => financeApi.listArs(), []);

  const form = useForm<InvoiceFormInput, unknown, InvoiceFormData>({
    resolver: zodResolver(invoiceSchema),
    defaultValues: FORM_DEFAULTS,
  });

  const direction = form.watch('direction');
  const contractId = form.watch('contractId');
  const amount = form.watch('amount');
  const taxRate = form.watch('taxRate');

  const selectedContract = useMemo(
    () => (contracts ?? []).find((c) => c.id === contractId),
    [contracts, contractId],
  );

  useEffect(() => {
    if (direction !== 'sales' || !selectedContract) return;
    const entity = resolveTaxEntity({
      taxEntityId: selectedContract.taxEntityId,
      taxEntities: taxEntities ?? [],
    });
    form.setValue('taxRate', resolveFormTaxRate(selectedContract.taxRate, entity));
  }, [direction, selectedContract, taxEntities, form]);

  const rateOptions = resolveRateOptions(
    resolveTaxEntity({
      taxEntityId:
        direction === 'sales' ? selectedContract?.taxEntityId : undefined,
      taxEntities: taxEntities ?? [],
    }),
  );

  const clientRequestId = useRef(crypto.randomUUID());

  const onSubmit = form.handleSubmit(async (values) => {
    const dto: CreateInvoiceDto = {
      direction: values.direction,
      invoiceType: values.invoiceType as CreateInvoiceDto['invoiceType'],
      amount: values.amount,
      taxRate: values.taxRate,
      contractId: values.direction === 'sales' ? values.contractId : undefined,
      supplierId:
        values.direction === 'purchase' ? values.supplierId : undefined,
      arId:
        values.direction === 'sales' && values.arId !== 'none'
          ? values.arId
          : undefined,
      invoiceNo: values.invoiceNo || undefined,
      invoiceDate: values.invoiceDate || undefined,
      remark: values.remark || undefined,
      clientRequestId: clientRequestId.current,
    };
    try {
      const created = await financeApi.createInvoice(dto);
      toast.success(
        values.direction === 'sales' ? '销项发票登记成功' : '进项发票登记成功',
      );
      navigate(`/finance/invoices/${created.id}`, { replace: true });
    } catch (err) {
      toast.error(getApiErrorMessage(err, '发票登记失败'));
    }
  });

  const salesArs = (ars ?? []).filter(
    (a) => a.status === 'open' || a.status === 'partial',
  );

  return (
    <PageShell
      title="发票登记"
      description="登记销项或进项发票，保存后进入详情上传扫描件"
      actions={
        <Button
          variant="outline"
          onClick={() => navigate('/finance?tab=invoices')}
        >
          <ArrowLeft className="h-4 w-4" />
          返回列表
        </Button>
      }
    >
      <div className="mx-auto w-full max-w-3xl">
        <div className="rounded-xl border border-border/80 bg-card p-6">
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4">
            <FormField
              control={form.control}
              name="direction"
              render={({ field }) => (
                <FormItem>
                  <Explained
                    title="方向"
                    content="销项是对外开出的发票，要选合同。进项是收到的发票，要选供应商。作废会释放这张发票占用的可开票金额，不能恢复。"
                  >
                    <FormLabel>方向</FormLabel>
                  </Explained>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="sales">销项</SelectItem>
                      <SelectItem value="purchase">进项</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            {direction === 'sales' ? (
              <FormField
                control={form.control}
                name="contractId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      合同{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="选择合同" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {(contracts ?? []).map((c) => (
                          <SelectItem key={c.id} value={c.id}>
                            {c.code} · {c.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : (
              <FormField
                control={form.control}
                name="supplierId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>
                      供应商{' '}
                      <span aria-hidden="true" className="text-destructive">
                        *
                      </span>
                    </FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="选择供应商" />
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
            )}
            <FormField
              control={form.control}
              name="invoiceType"
              render={({ field }) => (
                <FormItem>
                  <Explained
                    title="发票类型"
                    content="专票、普票或电子发票，只影响票面类型，不改变能选的税率档位。"
                  >
                    <FormLabel>发票类型</FormLabel>
                  </Explained>
                  <Select onValueChange={field.onChange} value={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      <SelectItem value="vat_special">增值税专用发票</SelectItem>
                      <SelectItem value="vat_normal">增值税普通发票</SelectItem>
                      <SelectItem value="electronic">电子发票</SelectItem>
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="amount"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <Explained
                      title="开票金额（含税）"
                      content="这张发票的价税合计。下面一行是按当前税率拆出的不含税金额和税额。"
                    >
                      <FormLabel>开票金额（含税）</FormLabel>
                    </Explained>
                    <FormControl>
                      <Input
                        type="number"
                        min={0}
                        step="0.01"
                        value={String(field.value ?? '')}
                        onChange={field.onChange}
                        onBlur={field.onBlur}
                        name={field.name}
                        ref={field.ref}
                      />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">
                      {formatTaxSplitLine(Number(amount) || 0, Number(taxRate) || 0)}
                    </p>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="taxRate"
                render={({ field }) => (
                  <FormItem className="w-28">
                    <Explained
                      title="税率"
                      content="按合同所属纳税主体的默认档位带出。小规模纳税人和一般纳税人可选档位不同。"
                    >
                      <FormLabel>税率 %</FormLabel>
                    </Explained>
                    <Select
                      value={String(field.value)}
                      onValueChange={(v) => field.onChange(Number(v))}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {rateOptions.map((r) => (
                          <SelectItem key={r} value={String(r)}>
                            {r}%
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            {direction === 'sales' ? (
              <FormField
                control={form.control}
                name="arId"
                render={({ field }) => (
                  <FormItem>
                    <Explained
                      title="关联应收"
                      content="把这张销项发票挂到一笔应收上，方便以后核销。可以不选。"
                    >
                      <FormLabel>关联应收（可选）</FormLabel>
                    </Explained>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="不关联" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="none">不关联</SelectItem>
                        {salesArs.map((a) => (
                          <SelectItem key={a.id} value={a.id}>
                            {a.code}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            ) : null}
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="invoiceNo"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>发票号码</FormLabel>
                    <FormControl>
                      <Input placeholder="可选" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="invoiceDate"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>开票日期</FormLabel>
                    <FormControl>
                      <Input type="date" {...field} />
                    </FormControl>
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
                    <Textarea placeholder="备注" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <StickyActionBar
              variant="card"
              hint="保存后进入详情，可继续上传发票附件"
            >
              <Button
                type="button"
                variant="outline"
                onClick={() => navigate('/finance?tab=invoices')}
              >
                取消
              </Button>
              <Button type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? '保存中' : '保存'}
              </Button>
            </StickyActionBar>
          </form>
        </Form>
        </div>
      </div>
    </PageShell>
  );
};

export default InvoiceCreatePage;







