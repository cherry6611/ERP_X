import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Download, MoreHorizontal, Plus, Upload } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import PageShell from '@client/src/components/PageShell';
import { DataState } from '@client/src/components/DataState';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import TaxEntityBanner from '@client/src/components/erp/TaxEntityBanner';
import { CanRole } from '@client/src/platform/auth';
import {
  coerceTaxRate,
  resolveRateOptions,
} from '@client/src/utils/tax-rate-options';
import { VAT_RATES } from '@shared/tax';
import ContactsDialog from './ContactsDialog';
import CreditDialog from './CreditDialog';
import { Button } from '@client/src/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@client/src/components/ui/dropdown-menu';
import { useDebouncedValue } from '@client/src/hooks/useDebouncedValue';
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
import { Textarea } from '@client/src/components/ui/textarea';
import { ExcelImportDialog } from '@client/src/components/excel/ExcelImportDialog';
import type {
  ExcelImportColumnDef,
  ParsedRowResult,
} from '@client/src/components/excel/ExcelImportDialog';
import {
  exportRowsToXlsx,
  type ExcelSheetColumn,
} from '@client/src/components/excel/excel-utils';
import { masterDataApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type {
  CreateCustomerDto,
  Customer,
  PagedResult,
  UpdateCustomerDto,
} from '@shared/api.interface';

const CUSTOMER_STATUS_LABELS: Record<string, string> = {
  active: '合作中',
  inactive: '停用',
  prospect: '潜在客户',
};

const CUSTOMER_STATUS_TO_CODE: Record<string, string> = {
  active: 'active',
  inactive: 'inactive',
  prospect: 'prospect',
  合作中: 'active',
  停用: 'inactive',
  潜在客户: 'prospect',
};

const CUSTOMER_IMPORT_COLUMNS: ExcelImportColumnDef[] = [
  { header: '名称', required: true },
  { header: '统一社会信用代码' },
  { header: '行业' },
  { header: '信用等级' },
  { header: '信用额度' },
  { header: '账期（天）' },
  { header: '状态' },
  { header: '备注' },
];

const CUSTOMER_EXPORT_COLUMNS: ExcelSheetColumn<Customer>[] = [
  { header: '编号', value: (row: Customer) => row.code },
  { header: '名称', value: (row: Customer) => row.name },
  { header: '统一社会信用代码', value: (row: Customer) => row.uscc ?? '' },
  { header: '行业', value: (row: Customer) => row.industry ?? '' },
  { header: '信用等级', value: (row: Customer) => row.creditLevel ?? '' },
  { header: '信用额度', value: (row: Customer) => row.creditLimit },
  { header: '账期（天）', value: (row: Customer) => row.termsDays },
  {
    header: '状态',
    value: (row: Customer) => CUSTOMER_STATUS_LABELS[row.status] ?? row.status,
  },
  { header: '备注', value: (row: Customer) => row.remark ?? '' },
];

function parseCustomerRow(raw: Record<string, string>): ParsedRowResult<CreateCustomerDto> {
  const errors: string[] = [];
  const name: string = (raw['名称'] ?? '').trim();
  if (!name) errors.push('名称不能为空');
  const uscc: string = (raw['统一社会信用代码'] ?? '').trim();
  const industry: string = (raw['行业'] ?? '').trim();
  const creditLevelRaw: string = (raw['信用等级'] ?? '').trim();
  let creditLevel: string = 'B';
  if (creditLevelRaw) {
    const upper: string = creditLevelRaw.toUpperCase();
    if (upper === 'A' || upper === 'B' || upper === 'C') {
      creditLevel = upper;
    } else {
      errors.push(`信用等级「${creditLevelRaw}」无效，只能为 A、B、C`);
    }
  }
  const creditLimitRaw: string = (raw['信用额度'] ?? '').trim();
  let creditLimit: number = 0;
  if (creditLimitRaw) {
    const parsed: number = Number(creditLimitRaw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      errors.push('信用额度需为不小于 0 的数字');
    } else {
      creditLimit = parsed;
    }
  }
  const termsDaysRaw: string = (raw['账期（天）'] ?? '').trim();
  let termsDays: number = 30;
  if (termsDaysRaw) {
    const parsed: number = Number(termsDaysRaw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 365) {
      errors.push('账期需为 0-365 的整数');
    } else {
      termsDays = parsed;
    }
  }
  const statusRaw: string = (raw['状态'] ?? '').trim();
  let status: string = 'prospect';
  if (statusRaw) {
    const mapped: string | undefined = CUSTOMER_STATUS_TO_CODE[statusRaw];
    if (mapped) {
      status = mapped;
    } else {
      errors.push(`状态「${statusRaw}」无效，应为 合作中/停用/潜在客户`);
    }
  }
  const remark: string = (raw['备注'] ?? '').trim();
  if (errors.length > 0) return { dto: null, errors };
  return {
    dto: {
      name,
      uscc: uscc || undefined,
      industry: industry || undefined,
      creditLevel,
      creditLimit,
      termsDays,
      status,
      remark: remark || undefined,
    },
    errors: [],
  };
}

const customerSchema = z.object({
  name: z.string().min(1, '客户名称不能为空'),
  uscc: z.string(),
  industry: z.string(),
  creditLevel: z.string(),
  creditLimit: z.coerce.number().min(0),
  termsDays: z.coerce.number().min(0).max(365),
  status: z.string(),
  remark: z.string(),
  taxEntityId: z.string(),
  defaultTaxRate: z.string(),
});

type CustomerFormData = z.output<typeof customerSchema>;
type CustomerFormInput = z.input<typeof customerSchema>;

const CustomersPage: React.FC = () => {
  const [keyword, setKeyword] = useState('');
  const keywordQuery = useDebouncedValue(keyword);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [contactsCustomer, setContactsCustomer] = useState<Customer | null>(null);
  const [creditCustomer, setCreditCustomer] = useState<Customer | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const { data, loading, error, reload } = useAsyncData<PagedResult<Customer>>(
    () => masterDataApi.listCustomersPaged(page, pageSize, keywordQuery || undefined),
    [page, pageSize, keywordQuery],
  );

  const form = useForm<CustomerFormInput, unknown, CustomerFormData>({
    resolver: zodResolver(customerSchema),
    defaultValues: {
      name: '',
      uscc: '',
      industry: '',
      creditLevel: 'B',
      creditLimit: 0,
      termsDays: 30,
      status: 'prospect',
      remark: '',
      taxEntityId: '',
      defaultTaxRate: '',
    },
  });
  const { data: taxEntities } = useAsyncData(
    () => masterDataApi.listTaxEntities(),
    []
  );

  const handleExport = () => {
    const rows: Customer[] = data?.items ?? [];
    if (rows.length === 0) {
      toast.error('当前列表为空，无可导出数据');
      return;
    }
    exportRowsToXlsx('客户列表.xlsx', '客户', CUSTOMER_EXPORT_COLUMNS, rows);
  };

  const openCreate = () => {
    setEditing(null);
    form.reset({
      name: '',
      uscc: '',
      industry: '',
      creditLevel: 'B',
      creditLimit: 0,
      termsDays: 30,
      status: 'prospect',
      remark: '',
      taxEntityId: '',
      defaultTaxRate: '',
    });
    setDialogOpen(true);
  };

  const openEdit = (customer: Customer) => {
    setEditing(customer);
    form.reset({
      name: customer.name,
      uscc: customer.uscc ?? '',
      industry: customer.industry ?? '',
      creditLevel: customer.creditLevel ?? 'B',
      creditLimit: customer.creditLimit,
      termsDays: customer.termsDays,
      status: customer.status,
      remark: customer.remark ?? '',
      taxEntityId: customer.taxEntityId ?? '',
      defaultTaxRate:
        customer.defaultTaxRate != null ? String(customer.defaultTaxRate) : '',
    });
    setDialogOpen(true);
  };

  const onSubmit = form.handleSubmit(async (data) => {
    try {
      const taxPayload = {
        taxEntityId: data.taxEntityId || null,
        defaultTaxRate:
          data.defaultTaxRate === '' ? null : Number(data.defaultTaxRate),
      };
      if (editing) {
        const dto: UpdateCustomerDto = { ...data, ...taxPayload };
        await masterDataApi.updateCustomer(editing.id, dto);
        toast.success('客户已更新');
      } else {
        const dto: CreateCustomerDto = { ...data, ...taxPayload };
        await masterDataApi.createCustomer(dto);
        toast.success('客户已创建');
      }
      setDialogOpen(false);
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '保存失败'));
    }
  });

  const toggleStatus = async (customer: Customer) => {
    const next: 'active' | 'inactive' =
      customer.status === 'inactive' ? 'active' : 'inactive';
    try {
      await masterDataApi.setCustomerStatus(customer.id, next);
      toast.success(next === 'inactive' ? '客户已停用' : '客户已启用');
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '状态更新失败'));
    }
  };

  const columns: TableColumnsType<Customer> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 130 },
    { title: '名称', dataIndex: 'name', width: 200 },
    { title: '行业', dataIndex: 'industry', width: 120, render: (v) => v ?? '-' },
    {
      title: '信用等级',
      dataIndex: 'creditLevel',
      width: 100,
      render: (v) => v ?? '-',
    },
    {
      title: '信用额度',
      dataIndex: 'creditLimit',
      width: 130,
      render: (v: number) => formatMoney(v),
    },
    {
      title: '账期（天）',
      dataIndex: 'termsDays',
      width: 100,
    },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => <StatusBadge status={s} labels={CUSTOMER_STATUS_LABELS} />,
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 260,
      render: (_, record) => (
        <div className="flex gap-1">
          <CanRole roles={['admin']}>
            <Button size="sm" onClick={() => openEdit(record)}>
              编辑
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void toggleStatus(record)}
            >
              {record.status === 'inactive' ? '启用' : '停用'}
            </Button>
          </CanRole>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`${record.name} 的更多操作`}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <CanRole roles={['admin']}>
                <DropdownMenuItem onClick={() => setContactsCustomer(record)}>
                  联系人
                </DropdownMenuItem>
              </CanRole>
              <DropdownMenuItem onClick={() => setCreditCustomer(record)}>信用</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];

  return (
    <PageShell title="客户管理" description="客户档案、多联系人、信用额度与账期管理">
      <TaxEntityBanner />
      <div className="flex items-center gap-3">
        <Input
          aria-label="搜索客户"
          placeholder="搜索客户名称或编号"
          className="w-64"
          value={keyword}
          onChange={(e) => {
            setKeyword(e.target.value);
            setPage(1);
          }}
        />
        <CanRole roles={['admin']}>
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" />
            新建客户
          </Button>
        </CanRole>
        <Button variant="outline" onClick={handleExport}>
          <Download className="h-4 w-4" />
          导出 Excel
        </Button>
        <CanRole roles={['admin']}>
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="h-4 w-4" />
            导入 Excel
          </Button>
        </CanRole>
      </div>
      <DataState
        loading={loading}
        error={error}
        onRetry={() => void reload()}
        skeleton="table"
      >
        <Table
          columns={columns}
          dataSource={data?.items ?? []}
          rowKey="id"
          scroll={{ x: 1100, y: 500 }}
          pagination={{
            current: page,
            pageSize,
            total: data?.total ?? 0,
            showTotal: (t: number) => `共 ${t} 条`,
            onChange: (p: number, s: number) => {
              setPage(p);
              setPageSize(s);
            },
          }}
          locale={{ emptyText: '暂无客户，点击右上角「新建客户」创建' }}
        />
      </DataState>
      <ContactsDialog
        customer={contactsCustomer}
        open={contactsCustomer !== null}
        onOpenChange={(open) => {
          if (!open) setContactsCustomer(null);
        }}
        onChanged={() => void reload()}
      />
      <CreditDialog
        customer={creditCustomer}
        open={creditCustomer !== null}
        onOpenChange={(open) => {
          if (!open) setCreditCustomer(null);
        }}
      />
      <ExcelImportDialog<CreateCustomerDto>
        open={importOpen}
        onOpenChange={setImportOpen}
        entityName="客户"
        templateFilename="客户导入模板.xlsx"
        columns={CUSTOMER_IMPORT_COLUMNS}
        parseRow={parseCustomerRow}
        rowKey={(raw: Record<string, string>) => (raw['名称'] ?? '').trim()}
        existingKeys={(data?.items ?? []).map((row: Customer) => row.name.trim())}
        createRow={(dto: CreateCustomerDto) =>
          masterDataApi.createCustomer(dto).then(() => undefined)
        }
        onImportFinished={() => void reload()}
      />
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? '编辑客户' : '新建客户'}</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>
                        名称 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <FormControl>
                        <Input placeholder="请输入客户名称" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="industry"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>行业</FormLabel>
                      <FormControl>
                        <Input placeholder="如：金融、制造" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="uscc"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>统一社会信用代码</FormLabel>
                      <FormControl>
                        <Input placeholder="选填" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="creditLevel"
                  render={({ field }) => (
                    <FormItem className="w-32">
                      <FormLabel>信用等级</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="A">A</SelectItem>
                          <SelectItem value="B">B</SelectItem>
                          <SelectItem value="C">C</SelectItem>
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
                  name="creditLimit"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>信用额度（元）</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
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
                  name="termsDays"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>账期（天）</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
                          max={365}
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
                  name="status"
                  render={({ field }) => (
                    <FormItem className="w-36">
                      <FormLabel>状态</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="prospect">潜在客户</SelectItem>
                          <SelectItem value="active">合作中</SelectItem>
                          <SelectItem value="inactive">停用</SelectItem>
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
                  name="taxEntityId"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>关联纳税主体</FormLabel>
                      <Select
                        value={field.value || '__none__'}
                        onValueChange={(value) =>
                          field.onChange(value === '__none__' ? '' : value)
                        }
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="可选" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="__none__">不指定</SelectItem>
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
                  name="defaultTaxRate"
                  render={({ field }) => {
                    const entityId = form.watch('taxEntityId');
                    const entity = (taxEntities ?? []).find((row) => row.id === entityId);
                    const rates = resolveRateOptions(entity);
                    return (
                    <FormItem className="w-36">
                      <FormLabel>默认税率</FormLabel>
                      <Select
                        value={field.value || '__none__'}
                        onValueChange={(value) =>
                          field.onChange(value === '__none__' ? '' : value)
                        }
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="可选" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="__none__">不指定</SelectItem>
                          {rates.map((rate) => (
                            <SelectItem key={rate} value={String(rate)}>
                              {rate}%
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                    );
                  }}
                />
              </div>
              <FormField
                control={form.control}
                name="remark"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>备注</FormLabel>
                    <FormControl>
                      <Textarea placeholder="备注信息" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <DialogFooter>
                <Button type="submit">保存</Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
};

export default CustomersPage;
