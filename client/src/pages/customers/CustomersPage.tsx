import React, { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import { Download, MoreHorizontal, Plus, Upload } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import PageShell from '@client/src/components/PageShell';
import { DataState } from '@client/src/components/DataState';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import TaxEntityBanner from '@client/src/components/erp/TaxEntityBanner';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import { resolveFormTaxRate } from '@client/src/utils/tax-rate-options';
import { VAT_RATES } from '@shared/tax';
import ContactsDialog from './ContactsDialog';
import CreditDialog from './CreditDialog';
import CustomerFormDialog from './components/CustomerFormDialog';
import {
  CUSTOMER_EMPTY_FORM,
  CUSTOMER_EXPORT_COLUMNS,
  CUSTOMER_IMPORT_COLUMNS,
  CUSTOMER_STATUS_LABELS,
  customerImportRowKey,
  customerSchema,
  parseCustomerRow,
  type CustomerFormData,
  type CustomerFormInput,
} from './customer-import';
import { Button } from '@client/src/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@client/src/components/ui/dropdown-menu';
import { useListQuery } from '@client/src/hooks/useListQuery';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import { Input } from '@client/src/components/ui/input';
import { ExcelImportDialog } from '@client/src/components/excel/ExcelImportDialog';
import { exportRowsToXlsx } from '@client/src/components/excel/excel-utils';
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

/*
 * §5.9（F8）：本页的**零 React 依赖纯逻辑**已移到 `./customer-import`，组件只做布局编排：
 *   · `CUSTOMER_STATUS_LABELS` / `CUSTOMER_STATUS_TO_CODE` —— 状态字典（导出用中文、导入双认）；
 *   · `CUSTOMER_IMPORT_COLUMNS` / `CUSTOMER_EXPORT_COLUMNS` —— 模板列与导出列定义；
 *   · `parseCustomerRow` / `customerImportRowKey` —— 批量导入的单行解析与判重键
 *     （判重键必须与下面的 `existingKeys` 用同一个算法，否则同一个客户会被建两次）；
 *   · `customerSchema` + `CUSTOMER_EMPTY_FORM`（含 `CustomerFormData` / `CustomerFormInput` 类型）。
 *
 * 搬走的正是"错了也看不出来"的两块：解析器是**批量导入的唯一闸门**（拦不住的错误
 * 会几百行一起落库），导出列取错字段照样导出成功、只是数字落在错的列里。
 * 两者现在由 `customer-import.spec.ts` 逐条断言（默认值、取值边界、错误聚合、
 * 有错时 `dto: null`、导出→回导闭环）。
 *
 * ⚠️ 下面的 `columns` **有意不抽**：它是 `TableColumnsType<Customer>`，`render` 返回 JSX
 * 并闭包捕获 `openEdit` / `toggleStatus` / `setContactsCustomer` 与组件状态，
 * 属于"依赖 React 与 handler 的渲染配置"，搬出去只会把 props 打洞变多，且无法单测。
 */

const CustomersPage: React.FC = () => {
  const { q, setQ, debouncedQ, page, setPage, debouncing } = useListQuery();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [contactsCustomer, setContactsCustomer] = useState<Customer | null>(null);
  const [creditCustomer, setCreditCustomer] = useState<Customer | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [pageSize, setPageSize] = useState(20);

  const { data, loading, error, reload } = useAsyncData<PagedResult<Customer>>(
    () => masterDataApi.listCustomersPaged(page, pageSize, debouncedQ || undefined),
    [page, pageSize, debouncedQ],
  );

  const form = useForm<CustomerFormInput, unknown, CustomerFormData>({
    resolver: zodResolver(customerSchema),
    // 展开而不是直接传常量：react-hook-form 需要每次都是全新的对象（见 `CUSTOMER_EMPTY_FORM` 注释）
    defaultValues: { ...CUSTOMER_EMPTY_FORM },
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
    form.reset({ ...CUSTOMER_EMPTY_FORM });
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
    if (next === 'inactive') {
      const ok = await confirmDanger(
        `确认停用客户 ${customer.name}？停用后不可用于新合同。`,
        { title: '确认停用' },
      );
      if (!ok) return;
    }
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
          <CanCapabilityWrite capability="crm_write">
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
          </CanCapabilityWrite>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`${record.name} 的更多操作`}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <CanCapabilityWrite capability="crm_write">
                <DropdownMenuItem onClick={() => setContactsCustomer(record)}>
                  联系人
                </DropdownMenuItem>
              </CanCapabilityWrite>
              <DropdownMenuItem onClick={() => setCreditCustomer(record)}>信用</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      ),
    },
  ];

  return (
    <PageShell
      title="客户管理"
      description="客户档案、多联系人、信用额度与账期管理"
      actions={
        /*
         * 写操作（新建 / 导入）归页头 `actions`；「导出 Excel」是"对当前筛选结果的
         * 只读工具"，留在下方筛选行。判据见 `AGENTS.md` 与
         * `scripts/browser-walkthrough/ui-sweep.mjs` 的巡检口径。
         */
        <>
          <CanCapabilityWrite capability="crm_write">
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              新建客户
            </Button>
          </CanCapabilityWrite>
          <CanCapabilityWrite capability="crm_write">
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload className="h-4 w-4" />
              导入 Excel
            </Button>
          </CanCapabilityWrite>
        </>
      }
    >
      <TaxEntityBanner />
      <div className="flex items-center gap-3">
        <Input
          aria-label="搜索客户"
          placeholder="搜索客户名称或编号"
          className="w-64"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {debouncing ? (
          <span className="text-xs text-muted-foreground">筛选中…</span>
        ) : null}
        <Button variant="outline" onClick={handleExport}>
          <Download className="h-4 w-4" />
          导出 Excel
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
        rowKey={customerImportRowKey}
        existingKeys={(data?.items ?? []).map((row: Customer) => row.name.trim())}
        createRow={(dto: CreateCustomerDto) =>
          masterDataApi.createCustomer(dto).then(() => undefined)
        }
        onImportFinished={() => void reload()}
      />
      <CustomerFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editing={editing}
        form={form}
        taxEntities={taxEntities}
        onSubmit={onSubmit}
      />
    </PageShell>
  );
};

export default CustomersPage;
