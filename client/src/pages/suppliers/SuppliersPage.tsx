import React, { useState } from 'react';
import { toast } from 'sonner';
import { Download, Plus, Upload } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import PageShell from '@client/src/components/PageShell';
import { DataState } from '@client/src/components/DataState';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import { Button } from '@client/src/components/ui/button';
import { Input } from '@client/src/components/ui/input';
import { ExcelImportDialog } from '@client/src/components/excel/ExcelImportDialog';
import { exportRowsToXlsx } from '@client/src/components/excel/excel-utils';
import {
  parseSupplierRow,
  SUPPLIER_EXPORT_COLUMNS,
  SUPPLIER_IMPORT_COLUMNS,
  SUPPLIER_STATUS_LABELS,
  SUPPLIER_TYPE_LABELS,
} from './supplier-import';
import SupplierFormDialog, {
  type SupplierFormDialogHandle,
} from './components/SupplierFormDialog';
import { masterDataApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { useListQuery } from '@client/src/hooks/useListQuery';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import type { CreateSupplierDto, Supplier } from '@shared/api.interface';

/*
 * ── 已抽出的零 React 依赖逻辑（§5.9 / F8） ─────────────────────────────
 *
 * 下面这些声明原本就写在组件上方，但它们与 React 状态无关：4 张标签/映射表、
 * 导入列、导出列、`parseSupplierRow`（批量导入的唯一闸门）、`supplierSchema`
 * 与表单空值。它们全部搬到了同目录的 `./supplier-import`，并在那里有了
 * `supplier-import.spec.ts`（见文件头的理由）。
 *
 * 搬迁方式是**原样搬运 + 加 `export`**：标识符名字一个都没改，所以下面
 * 按名字 import 进来之后，组件体（列定义、表单、导入对话框）**一行都不用改**，
 * 从而保证行为零变更。唯一消掉的是重复：`defaultValues` 与 `openCreate` 里
 * 各写了一遍的空表单字面量，现在共用 `EMPTY_FORM`。
 *
 * ⚠️ 仍留在本文件的 `columns: TableColumnsType<Supplier>` **不可抽出**：
 * 它的 `render` 返回 JSX 且闭包捕获了 `openEdit` / `toggleStatus` ——
 * 属于组件状态与交互，不是纯逻辑。
 */
const SuppliersPage: React.FC = () => {
  const { q, setQ, debouncedQ, debouncing } = useListQuery();
  const [importOpen, setImportOpen] = useState(false);
  const { data, loading, error, reload } = useAsyncData<Supplier[]>(
    () => masterDataApi.listSuppliers(debouncedQ || undefined),
    [debouncedQ],
  );

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

  const dialogRef = React.useRef<SupplierFormDialogHandle | null>(null);
  const openCreate = () => dialogRef.current?.open();

  const openEdit = (supplier: Supplier) => dialogRef.current?.open(supplier);


  const toggleStatus = async (supplier: Supplier) => {
    const next: 'active' | 'inactive' =
      supplier.status === 'inactive' ? 'active' : 'inactive';
    if (next === 'inactive') {
      const ok = await confirmDanger(
        `确认停用供应商 ${supplier.name}？停用后不可用于新采购。`,
        { title: '确认停用' },
      );
      if (!ok) return;
    }
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
        <CanCapabilityWrite capability="crm_write">
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
        </CanCapabilityWrite>
      ),
    },
  ];

  return (
    <PageShell
      title="供应商管理"
      description="供应商登记、评级与合作状态管理"
      actions={
        /* 写操作归页头；「导出 Excel」是对当前筛选结果的只读工具，留在筛选行 */
        <>
          <CanCapabilityWrite capability="crm_write">
            <Button onClick={openCreate}>
              <Plus className="h-4 w-4" />
              新建供应商
            </Button>
          </CanCapabilityWrite>
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="h-4 w-4" />
            导入 Excel
          </Button>
        </>
      }
    >
      <div className="flex items-center gap-3">
        <Input
          aria-label="搜索供应商"
          placeholder="搜索供应商名称或编号"
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
      {/* §5.9：表单弹窗已抽到 ./components/SupplierFormDialog（自闭环状态整体搬走） */}
      <SupplierFormDialog ref={dialogRef} taxEntities={taxEntities} onSaved={reload} />
    </PageShell>
  );
};

export default SuppliersPage;
