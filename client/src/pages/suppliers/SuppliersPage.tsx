import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { z } from 'zod';
import { toast } from 'sonner';
import { Download, Plus, Upload } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import PageShell from '@client/src/components/PageShell';
import { DataState } from '@client/src/components/DataState';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { CanRole } from '@client/src/platform/auth';
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
import { useDebouncedValue } from '@client/src/hooks/useDebouncedValue';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import {
  resolveRateOptions,
} from '@client/src/utils/tax-rate-options';
import type { CreateSupplierDto, Supplier, UpdateSupplierDto } from '@shared/api.interface';

const SUPPLIER_TYPE_LABELS: Record<string, string> = {
  outsource: '外包服务',
  compute: '算力资源',
  storage: '存储资源',
  tool: '工具软件',
  travel: '差旅服务',
  other: '其他',
};

const SUPPLIER_STATUS_LABELS: Record<string, string> = {
  active: '合作中',
  inactive: '停用',
};

const SUPPLIER_TYPE_TO_CODE: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(SUPPLIER_TYPE_LABELS).map((
      entry: [string, string],
    ) => [entry[1], entry[0]]),
  ),
  outsource: 'outsource',
  compute: 'compute',
  storage: 'storage',
  tool: 'tool',
  travel: 'travel',
  other: 'other',
};

const SUPPLIER_STATUS_TO_CODE: Record<string, string> = {
  active: 'active',
  inactive: 'inactive',
  合作中: 'active',
  停用: 'inactive',
};

const SUPPLIER_IMPORT_COLUMNS: ExcelImportColumnDef[] = [
  { header: '名称', required: true },
  { header: '类型' },
  { header: '联系人' },
  { header: '联系电话' },
  { header: '银行账户' },
  { header: '评级' },
  { header: '状态' },
  { header: '备注' },
];

const SUPPLIER_EXPORT_COLUMNS: ExcelSheetColumn<Supplier>[] = [
  { header: '编号', value: (row: Supplier) => row.code },
  { header: '名称', value: (row: Supplier) => row.name },
  {
    header: '类型',
    value: (row: Supplier) =>
      row.type ? (SUPPLIER_TYPE_LABELS[row.type] ?? row.type) : '',
  },
  { header: '联系人', value: (row: Supplier) => row.contactName ?? '' },
  { header: '联系电话', value: (row: Supplier) => row.contactPhone ?? '' },
  { header: '银行账户', value: (row: Supplier) => row.bankAccount ?? '' },
  { header: '评级', value: (row: Supplier) => row.rating },
  {
    header: '状态',
    value: (row: Supplier) => SUPPLIER_STATUS_LABELS[row.status] ?? row.status,
  },
  { header: '备注', value: (row: Supplier) => row.remark ?? '' },
];

function parseSupplierRow(raw: Record<string, string>): ParsedRowResult<CreateSupplierDto> {
  const errors: string[] = [];
  const name: string = (raw['名称'] ?? '').trim();
  if (!name) errors.push('名称不能为空');
  const typeRaw: string = (raw['类型'] ?? '').trim();
  let type: string = 'outsource';
  if (typeRaw) {
    const mapped: string | undefined = SUPPLIER_TYPE_TO_CODE[typeRaw];
    if (mapped) {
      type = mapped;
    } else {
      errors.push(
        `类型「${typeRaw}」无效，应为 外包服务/算力资源/存储资源/工具软件/差旅服务/其他`,
      );
    }
  }
  const contactName: string = (raw['联系人'] ?? '').trim();
  const contactPhone: string = (raw['联系电话'] ?? '').trim();
  const bankAccount: string = (raw['银行账户'] ?? '').trim();
  const ratingRaw: string = (raw['评级'] ?? '').trim();
  let rating: number = 0;
  if (ratingRaw) {
    const parsed: number = Number(ratingRaw);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 5) {
      errors.push('评级需为 0-5 的数字');
    } else {
      rating = parsed;
    }
  }
  const statusRaw: string = (raw['状态'] ?? '').trim();
  let status: string = 'active';
  if (statusRaw) {
    const mapped: string | undefined = SUPPLIER_STATUS_TO_CODE[statusRaw];
    if (mapped) {
      status = mapped;
    } else {
      errors.push(`状态「${statusRaw}」无效，应为 合作中/停用`);
    }
  }
  const remark: string = (raw['备注'] ?? '').trim();
  if (errors.length > 0) return { dto: null, errors };
  return {
    dto: {
      name,
      type,
      contactName: contactName || undefined,
      contactPhone: contactPhone || undefined,
      bankAccount: bankAccount || undefined,
      rating,
      status,
      remark: remark || undefined,
    },
    errors: [],
  };
}

const supplierSchema = z.object({
  name: z.string().min(1, '供应商名称不能为空'),
  type: z.string().min(1, '请选择供应商类型'),
  contactName: z.string(),
  contactPhone: z.string(),
  bankAccount: z.string(),
  rating: z.coerce.number().min(0).max(5),
  status: z.string(),
  remark: z.string(),
  taxEntityId: z.string(),
  defaultTaxRate: z.string(),
});

type SupplierFormData = z.output<typeof supplierSchema>;
type SupplierFormInput = z.input<typeof supplierSchema>;

const SuppliersPage: React.FC = () => {
  const [keyword, setKeyword] = useState('');
  const keywordQuery = useDebouncedValue(keyword);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const { data, loading, error, reload } = useAsyncData<Supplier[]>(
    () => masterDataApi.listSuppliers(keywordQuery || undefined),
    [keywordQuery],
  );

  const form = useForm<SupplierFormInput, unknown, SupplierFormData>({
    resolver: zodResolver(supplierSchema),
    defaultValues: {
      name: '',
      type: 'outsource',
      contactName: '',
      contactPhone: '',
      bankAccount: '',
      rating: 0,
      status: 'active',
      remark: '',
      taxEntityId: '',
      defaultTaxRate: '',
    },
  });
  const { data: taxEntities } = useAsyncData(
    () => masterDataApi.listTaxEntities(),
    [],
  );

  const handleExport = () => {
    const rows: Supplier[] = data ?? [];
    if (rows.length === 0) {
      toast.error('当前列表为空，无可导出数据');
      return;
    }
    exportRowsToXlsx('供应商列表.xlsx', '供应商', SUPPLIER_EXPORT_COLUMNS, rows);
  };

  const openCreate = () => {
    setEditing(null);
    form.reset({
      name: '',
      type: 'outsource',
      contactName: '',
      contactPhone: '',
      bankAccount: '',
      rating: 0,
      status: 'active',
      remark: '',
      taxEntityId: '',
      defaultTaxRate: '',
    });
    setDialogOpen(true);
  };

  const openEdit = (supplier: Supplier) => {
    setEditing(supplier);
    form.reset({
      name: supplier.name,
      type: supplier.type ?? 'other',
      contactName: supplier.contactName ?? '',
      contactPhone: supplier.contactPhone ?? '',
      bankAccount: supplier.bankAccount ?? '',
      rating: supplier.rating,
      status: supplier.status,
      remark: supplier.remark ?? '',
      taxEntityId: supplier.taxEntityId ?? '',
      defaultTaxRate:
        supplier.defaultTaxRate != null ? String(supplier.defaultTaxRate) : '',
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
        const dto: UpdateSupplierDto = { ...data, ...taxPayload };
        await masterDataApi.updateSupplier(editing.id, dto);
        toast.success('供应商已更新');
      } else {
        const dto: CreateSupplierDto = { ...data, ...taxPayload };
        await masterDataApi.createSupplier(dto);
        toast.success('供应商已创建');
      }
      setDialogOpen(false);
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '保存失败'));
    }
  });

  const toggleStatus = async (supplier: Supplier) => {
    const next: 'active' | 'inactive' =
      supplier.status === 'inactive' ? 'active' : 'inactive';
    try {
      await masterDataApi.setSupplierStatus(supplier.id, next);
      toast.success(next === 'inactive' ? '供应商已停用' : '供应商已启用');
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '状态更新失败'));
    }
  };

  const columns: TableColumnsType<Supplier> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 130 },
    { title: '名称', dataIndex: 'name', width: 200 },
    {
      title: '类型',
      dataIndex: 'type',
      width: 110,
      render: (t: string | null) => (t ? (SUPPLIER_TYPE_LABELS[t] ?? t) : '-'),
    },
    { title: '联系人', dataIndex: 'contactName', width: 110 },
    { title: '联系电话', dataIndex: 'contactPhone', width: 130 },
    { title: '银行账户', dataIndex: 'bankAccount', width: 160 },
    { title: '评级', dataIndex: 'rating', width: 80 },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => <StatusBadge status={s} labels={SUPPLIER_STATUS_LABELS} />,
    },
    {
      title: '备注',
      dataIndex: 'remark',
      width: 160,
      render: (r: string | null) => r ?? '-',
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 160,
      render: (_, record) => (
        <CanRole roles={['admin']}>
          <div className="flex gap-1">
            <Button variant="ghost" size="sm" onClick={() => openEdit(record)}>
              编辑
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void toggleStatus(record)}
            >
              {record.status === 'inactive' ? '启用' : '停用'}
            </Button>
          </div>
        </CanRole>
      ),
    },
  ];

  return (
    <PageShell title="供应商管理" description="供应商登记、评级与合作状态管理">
      <div className="flex items-center gap-3">
        <Input
          aria-label="搜索供应商"
          placeholder="搜索供应商名称或编号"
          className="w-64"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <CanRole roles={['admin']}>
          <Button onClick={openCreate}>
            <Plus className="h-4 w-4" />
            新建供应商
          </Button>
        </CanRole>
        <Button variant="outline" onClick={handleExport}>
          <Download className="h-4 w-4" />
          导出 Excel
        </Button>
        <Button variant="outline" onClick={() => setImportOpen(true)}>
          <Upload className="h-4 w-4" />
          导入 Excel
        </Button>
      </div>
      <DataState
        loading={loading}
        error={error}
        onRetry={() => void reload()}
        skeleton="table"
      >
        <Table
          columns={columns}
          dataSource={data ?? []}
          rowKey="id"
          scroll={{ x: 1100, y: 500 }}
          pagination={{
            pageSize: 10,
            showTotal: (t: number) => `共 ${t} 条`,
          }}
          locale={{ emptyText: '暂无供应商，点击右上角「新建供应商」创建' }}
        />
      </DataState>
      <ExcelImportDialog<CreateSupplierDto>
        open={importOpen}
        onOpenChange={setImportOpen}
        entityName="供应商"
        templateFilename="供应商导入模板.xlsx"
        columns={SUPPLIER_IMPORT_COLUMNS}
        parseRow={parseSupplierRow}
        rowKey={(raw: Record<string, string>) => (raw['名称'] ?? '').trim()}
        existingKeys={(data ?? []).map((row: Supplier) => row.name.trim())}
        createRow={(dto: CreateSupplierDto) =>
          masterDataApi.createSupplier(dto).then(() => undefined)
        }
        onImportFinished={() => void reload()}
      />
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{editing ? '编辑供应商' : '新建供应商'}</DialogTitle>
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
                        <Input placeholder="请输入供应商名称" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="type"
                  render={({ field }) => (
                    <FormItem className="w-44">
                      <FormLabel>
                        类型 <span aria-hidden="true" className="text-destructive">*</span>
                      </FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue placeholder="请选择" />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {Object.entries(SUPPLIER_TYPE_LABELS).map(([value, label]) => (
                            <SelectItem key={value} value={value}>
                              {label}
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
                  name="contactName"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>联系人</FormLabel>
                      <FormControl>
                        <Input placeholder="请输入联系人" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="contactPhone"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>联系电话</FormLabel>
                      <FormControl>
                        <Input placeholder="请输入联系电话" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="flex gap-4">
                <FormField
                  control={form.control}
                  name="bankAccount"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>银行账户</FormLabel>
                      <FormControl>
                        <Input placeholder="请输入银行账户" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="rating"
                  render={({ field }) => (
                    <FormItem className="w-44">
                      <FormLabel>评级（0-5）</FormLabel>
                      <FormControl>
                        <Input
                          type="number"
                          min={0}
                          max={5}
                          step={0.5}
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
              </div>
              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <FormItem className="w-44">
                    <FormLabel>状态</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="请选择" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="active">合作中</SelectItem>
                        <SelectItem value="inactive">停用</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
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

export default SuppliersPage;
