import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Download, FileInput, FilePlus, Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import { DataState } from '@client/src/components/DataState';
import FilterBar from '@client/src/components/erp/FilterBar';
import ActionHelp from '@client/src/components/erp/ActionHelp';
import StatCard from '@client/src/components/erp/StatCard';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { extractErrorMessage } from '@client/src/components/excel/excel-utils';
import { contractsApi, financeApi, masterDataApi } from '@client/src/api';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { formatMoney } from '@client/src/utils/format';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import type {
  ArItem,
  Contract,
  InvoiceItem,
  Supplier,
  TaxEntity,
} from '@shared/api.interface';
import {
  VERIFY_STATUS_LABELS,
  buildInvoiceCsv,
  filterLinkableArs,
  isValidTaxPeriod,
  sumTaxAmountByDirection,
  type DirectionFilter,
} from './invoice-schemas';
import InvoiceFormDialog from './components/InvoiceFormDialog';
import InvoiceLinkDialog from './components/InvoiceLinkDialog';
import InvoiceEditDialog from './components/InvoiceEditDialog';
import { invoiceColumns } from './components/invoice-columns';
import InvoiceQuickViewDrawer from './components/InvoiceQuickViewDrawer';

/*
 * §5.9（F8）：本文件的**纯逻辑**已移到同目录 `./invoice-schemas`，
 * 并配有 `invoice-schemas.spec.ts`（37 条用例 / 121 条断言）。
 * 搬走的是四块零 React 依赖的声明：
 *
 *   ① 展示字典：方向 / 发票类型 / 发票状态 / 查验状态 / 认证状态（含 Badge variant）；
 *   ② 登记表单 `invoiceSchema` 与 `FORM_DEFAULTS`（含 `InvoiceFormData/Input` 别名）；
 *   ③ 台账 CSV 导出列表头与取值（`buildInvoiceCsv`，DOM 部分仍在本组件）；
 *   ④ 小工具：`toLocalDate`（用户选的日历日，**不是**时区口径）、
 *      `isValidTaxPeriod`（勾选认证所属期）、以及两个派生计算
 *      （可关联应收白名单、按方向汇总税额）。
 *
 * 搬走的理由与 `ap-schemas.ts` / `ar-schemas.ts` 相同：留在组件里既看不到组件本身，
 * 又只能靠人工发现错误 —— 而这几块的错误恰恰**在界面上看不出来**
 * （导出照样成功，只是「税额」列里放着开票金额；字典漏一个键只是表格里
 * 冒出一个英文 key；schema 的 min 改错只是放进一条脏数据）。
 *
 * ── 第二轮（同一 §5.9 / F8）：**JSX** 也搬走了 ──────────────────────────
 *
 * 上一轮只搬纯声明，文件仍有 854 行（审计口径：非空行）—— 占体量的从来不是声明，
 * 而是三块 JSX：登记弹窗 315 行、台账表格的 `columns` 160 行、关联应收弹窗 42 行。
 * 本轮按"每个弹窗 / 每张表一个模块"拆开：
 *
 *   · `./components/InvoiceFormDialog.tsx`：发票登记弹窗，自带 `useForm`
 *     （`invoiceSchema`）、合同/供应商 → 纳税主体 → 税率档位的联动与提交流程；
 *   · `./components/invoice-columns.tsx`：台账表格列定义（工厂函数，注入跳转与
 *     作废/查验/认证三个动作处理器 —— 与 `pages/hr/components/attendance-columns.tsx` 同形）；
 *   · `./components/InvoiceLinkDialog.tsx`：关联应收弹窗。
 *
 * 主文件保留：数据查询（`useAsyncData`）、两张税额合计卡、方向筛选区、导出按钮、
 * 表格本身与两个子组件 —— 也就是"页面级编排"。
 *
 * ⚠️ 三条必须保住的语义（搬迁时逐条核对过）：
 *   ① 两个弹窗**无条件挂载**（不能写成 `{open && <XxxDialog/>}`）：关联应收弹窗的
 *      `linkArId` 是父组件 state，条件挂载会连"打开时带出该发票已关联的应收"
 *      这一初始化一起丢掉；
 *   ② 重置时机逐字未变（详见两个子组件各自的文件头）：登记弹窗只在**提交成功之后**
 *      `form.reset(FORM_DEFAULTS)`（原实现没有"打开即清空"）；关联应收弹窗则是
 *      **打开时**由 `openLinkDialog` 带出 `record.arId ?? ''`，关闭或提交成功后清空；
 *   ③ JSX 文案、`invoiceSchema`、校验消息逐字未动，`invoice-schemas.ts` 仍是唯一定义处。
 */

const InvoicesTab: React.FC = () => {
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all');
  const [linkTarget, setLinkTarget] = useState<InvoiceItem | null>(null);
  const [linkArId, setLinkArId] = useState('');
  /** 编辑发票的目标；`null` 表示弹窗关闭（与 `linkTarget` 同一约定） */
  const [editTarget, setEditTarget] = useState<InvoiceItem | null>(null);
  const [quickViewInvoice, setQuickViewInvoice] = useState<InvoiceItem | null>(null);

  const { data, loading, error, reload } = useAsyncData<InvoiceItem[]>(
    () =>
      financeApi.listInvoices(
        undefined,
        directionFilter === 'all' ? undefined : directionFilter,
      ),
    [directionFilter],
  );
  const { data: contracts } = useAsyncData<Contract[]>(() => contractsApi.listContracts(), []);
  const { data: suppliers } = useAsyncData<Supplier[]>(
    () => masterDataApi.listSuppliers(),
    [],
  );
  const { data: taxEntities } = useAsyncData<TaxEntity[]>(
    () => masterDataApi.listTaxEntities(),
    [],
  );
  const { data: ars } = useAsyncData<ArItem[]>(() => financeApi.listArs(), []);

  const invoices: InvoiceItem[] = data ?? [];
  const salesTaxTotal: number = sumTaxAmountByDirection(invoices, 'sales');
  const purchaseTaxTotal: number = sumTaxAmountByDirection(invoices, 'purchase');
  const linkableArs: ArItem[] = filterLinkableArs(ars);

  const handleVoid = async (invoice: InvoiceItem) => {
    const ok = await confirmDanger(
      `确认作废发票 ${invoice.code}（${invoice.invoiceNo ?? '系统编号'}）？作废后不可恢复`,
      { title: '作废发票', confirmLabel: '确认作废' },
    );
    if (!ok) return;
    try {
      await financeApi.voidInvoice(invoice.id);
      toast.success('发票已作废');
      await reload();
    } catch (err) {
      toast.error(extractErrorMessage(err, '发票作废失败'));
    }
  };

  /* ===================== C-01 发票查验与勾选认证 ===================== */

  const handleVerify = async (invoice: InvoiceItem) => {
    try {
      const res = await financeApi.verifyInvoice(invoice.id);
      const label = VERIFY_STATUS_LABELS[res.verifyStatus] ?? res.verifyStatus;
      if (res.source === 'none') {
        /*
         * P1-5：none 模式下接口 201 成功但状态仍为「未查验」。
         * 只说「未查验」，用户会以为功能坏了；这里必须把原因和下一步说清楚。
         */
        toast.info(
          '当前未配置查验服务商（none 模式），发票保持未查验状态；请在设置中配置 INVOICE_VERIFY_PROVIDER',
        );
      } else if (res.verifyStatus === 'verified') {
        toast.success(`查验通过：${label}`);
      } else if (res.verifyStatus === 'failed') {
        // 查验失败仅标记，不阻断；把失败原因透出给用户便于处理
        toast.warning(`查验未通过：${res.message}`);
      } else {
        toast.info(res.message || label);
      }
      await reload();
    } catch (err) {
      toast.error(extractErrorMessage(err, '发票查验失败'));
    }
  };

  const handleCertify = async (invoice: InvoiceItem) => {
    const input = window.prompt('请输入勾选所属税款所属期（YYYY-MM，如 2026-03）', '');
    if (input === null) return;
    const period = input.trim();
    if (!isValidTaxPeriod(period)) {
      toast.error('税款所属期格式必须为 YYYY-MM');
      return;
    }
    try {
      await financeApi.certifyInvoice(invoice.id, period);
      toast.success('勾选认证已记录');
      await reload();
    } catch (err) {
      toast.error(extractErrorMessage(err, '勾选认证失败'));
    }
  };

  const handleExportCsv = () => {
    if (invoices.length === 0) {
      toast.error('当前列表为空，无可导出数据');
      return;
    }
    // 台账文本（表头 + 逐行，含 BOM）由纯模块生成，便于逐列单测；此处只负责落盘
    const blob = new Blob([buildInvoiceCsv(invoices)], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = '发票台账.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  const openLinkDialog = (record: InvoiceItem) => {
    setLinkArId(record.arId ?? '');
    setLinkTarget(record);
  };

  /*
   * C-01：查验 / 认证状态展示映射（`BadgeVariant` + `VERIFY_STATUS_*` /
   * `CERT_STATUS_*` 四张表）已移到 `./invoice-schemas` —— 它们原先是每次 render
   * 重建的组件内常量，如今是模块常量，并被"每个白名单值都有非空标签 / 颜色"
   * 的断言钉住。
   */

  const columns: TableColumnsType<InvoiceItem> = invoiceColumns({
    navigate,
    openLinkDialog,
    onEdit: setEditTarget,
    handleVoid,
    handleVerify,
    handleCertify,
    onQuickView: setQuickViewInvoice,
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <StatCard
          label="销项税额合计"
          value={formatMoney(salesTaxTotal)}
          icon={FilePlus}
          tone="primary"
          hint="当前列表销项发票税额合计"
        />
        <StatCard
          label="进项可抵扣税额合计"
          value={formatMoney(purchaseTaxTotal)}
          icon={FileInput}
          tone="info"
          hint="当前列表进项发票税额合计"
        />
      </div>
      <div className="flex items-center justify-between">
        <FilterBar>
          <Select
            value={directionFilter}
            onValueChange={(v) => setDirectionFilter(v as DirectionFilter)}
          >
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="发票方向" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              <SelectItem value="sales">销项</SelectItem>
              <SelectItem value="purchase">进项</SelectItem>
            </SelectContent>
          </Select>
        </FilterBar>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleExportCsv}>
            <Download className="h-4 w-4" />
            导出 CSV
          </Button>
          <CanCapabilityWrite capability="finance_write">
            <Button onClick={() => navigate('/finance/invoices/new')}>
              <Plus className="h-4 w-4" />
              发票登记
            </Button>
          </CanCapabilityWrite>
          <ActionHelp title="作废、查验与认证">
            作废会释放可开票金额且不可恢复；查验/认证是税务状态动作，未配置查验服务商时只记录状态。
          </ActionHelp>
        </div>
      </div>
      <DataState
        loading={loading}
        error={error}
        onRetry={() => void reload()}
        skeleton="table"
      >
        <Table
          columns={columns}
          dataSource={invoices}
          rowKey="id"
          scroll={{ x: 1500, y: 500 }}
          pagination={{
            pageSize: 10,
            showTotal: (t: number) => `共 ${t} 条`,
          }}
          locale={{ emptyText: '暂无发票，点击右上角「发票登记」创建' }}
        />
      </DataState>

      <InvoiceFormDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        contracts={contracts}
        suppliers={suppliers}
        taxEntities={taxEntities}
        linkableArs={linkableArs}
        onSaved={reload}
      />

      <InvoiceEditDialog
        target={editTarget}
        setTarget={setEditTarget}
        onSaved={reload}
      />

      <InvoiceLinkDialog
        linkTarget={linkTarget}
        setLinkTarget={setLinkTarget}
        linkArId={linkArId}
        setLinkArId={setLinkArId}
        linkableArs={linkableArs}
        onSaved={reload}
      />

      <InvoiceQuickViewDrawer
        invoice={quickViewInvoice}
        onOpenChange={(open) => {
          if (!open) setQuickViewInvoice(null);
        }}
      />
    </div>
  );
};

export default InvoicesTab;


