import React, { useState } from 'react';
import { toast } from 'sonner';
import { Download, Plus } from 'lucide-react';
import { Table, TableColumnsType } from 'antd';
import { CanCapability, CanCapabilityWrite } from '@client/src/platform/auth';
import { DataState } from '@client/src/components/DataState';
import { SectionTitle } from '@client/src/components/SectionTitle';
import StatusBadge from '@client/src/components/erp/StatusBadge';
import { Button } from '@client/src/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { financeApi, masterDataApi, projectsApi } from '@client/src/api';
import { PrintButton } from '@client/src/components/print';
import { compactFields, metaField } from '@client/src/components/print';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import { formatMoney } from '@client/src/utils/format';
import { apExportColumns as AP_EXPORT_COLUMNS } from './ap-schemas';
import ApFormDialog from './components/ApFormDialog';
import PaymentApplyDialog from './components/PaymentApplyDialog';
import VendorSettlementDialog from './components/VendorSettlementDialog';
import WriteoffDialog from './components/WriteoffDialog';
import {
  exportRowsToXlsx,
} from '@client/src/components/excel/excel-utils';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type {
  ApItem,
  PaymentItem,
  Project,
  Supplier,
} from '@shared/api.interface';

// 修复：这里原先自带 AP_STATUS_LABELS / PAYMENT_STATUS_LABELS 两份**本地**映射，
// 与 `utils/biz-labels.ts` 的字典版并存且文案不一致 —— 同一个 `payment_status=paid`
// 在本页显示「已支付」、在字典里是「已核销」，于是 B-05 字典编辑对这两个主要财务页
// 完全无效（改字典不生效，且没人看得出来）。统一改为引用字典版（唯一真源）。
import {
  AP_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
} from '@client/src/utils/biz-labels';

/*
 * §5.9（F8）：`AP_EXPORT_COLUMNS` 与四个表单 schema 已移到 `./ap-schemas`。
 *
 * 搬走的两块都是**零 React 依赖的纯声明**，合计约 70 行 —— 原先占满了文件
 * 开头，打开 `ApTab.tsx` 先看到 140 行声明才看到组件。更重要的收益是它们
 * 现在**可被单测**（`ap-schemas.spec.ts`，17 条断言）：
 *   · schema 是财务数据的入口闸门，改错一个 `min` 就会放进脏数据；
 *   · 导出列定义的错误在界面上看不出来（导出照样成功，只是数字落在错的列里）。
 *
 * 特别地，`apSchema.amount` 的 `min(1)` 与 `writeoffSchema.amount` 的
 * `min(0.01)` 是**两个不同的业务门槛**（0 元负债无含义 vs 1 分钱尾差必须能核销），
 * 规格里各有一条断言防止有人为了"统一"把它们改成同一个数。
 */

/*
 * §5.9（F8）：四个弹窗已各自拆成 `./components/` 下的组件。
 *
 * 上一轮只搬走了**纯声明**（schema / 导出列），文件仍然 990 行 —— 因为占体量的
 * 从来不是声明，而是本文件末尾 441 行的四段 `<Dialog>` JSX（登记应付 /
 * 付款申请 / 付款核销 / 外协结算）。本轮把这四段**整体**搬走，每个组件自带
 * `useForm`、`useState` 与提交处理器：
 *
 *   · 主文件保留：数据查询（`useAsyncData`）、两个表格的列定义与操作列、
 *     筛选区与导出按钮 —— 也就是"页面级编排"；
 *   · 子组件只拿**数据**与 `onSaved`（写成功后由主文件重取列表），不再由主文件
 *     传入 setter。
 *
 * ⚠️ 三个必须保住的语义（搬迁时逐条核对）：
 *   ① 四个组件**无条件挂载**，不能写成 `{open && <XxxDialog/>}` —— 外协结算弹窗
 *      的预览 `useEffect` 与三个 state 原先是常驻的，条件挂载会改变副作用触发
 *      时机并在每次打开时丢掉 `settlementPreview`；
 *   ② 表单重置时机不变：都在**提交成功之后**重置（原实现没有"打开即清空"）；
 *   ③ JSX 文案、schema、校验消息逐字未动，`ap-schemas.ts` 仍是唯一定义处。
 */

const ApTab: React.FC = () => {
  const [statusFilter, setStatusFilter] = useState('all');
  const [apOpen, setApOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [writeoffOpen, setWriteoffOpen] = useState(false);
  const [vendorSettlementOpen, setVendorSettlementOpen] = useState(false);

  const { data: aps, loading, error, reload } = useAsyncData<ApItem[]>(
    () => financeApi.listAps(undefined, statusFilter !== 'all' ? statusFilter : undefined),
    [statusFilter],
  );
  const { data: payments, reload: reloadPayments } = useAsyncData<PaymentItem[]>(
    () => financeApi.listPayments(),
    []
  );
  const { data: suppliers } = useAsyncData<Supplier[]>(
    () => masterDataApi.listSuppliers(),
    [],
  );
  const { data: projects } = useAsyncData<Project[]>(() => projectsApi.listProjects(), []);

  const approvePayment = async (p: PaymentItem, action: 'approve' | 'reject') => {
    try {
      await financeApi.approvePayment(p.id, action);
      toast.success(action === 'approve' ? '付款已批准' : '付款已驳回');
      await reload();
    } catch (err) {
      toast.error(getApiErrorMessage(err, '操作失败'));
    }
  };

  /*
   * ⚠️ 必须**同时**排除 `voided`，不能只排 `paid`。
   *
   * 作废的应付单 `amount − reserved` 通常仍是正数，所以"未付"这个直觉判据
   * 会把它当成可付款候选。而 `ApStatus` 契约含 `'voided'`、`voidAp` 会真的写
   * 它、`listAps()` 在不传 status 时也不过状态 —— 所以作废单真的会出现在
   * 列表与下拉里。这份数据同时喂给**付款申请**与**核销**两个下拉，且选项文案
   * （`{code} - {supplier}（未付 …）`）**不显示状态**，因此作废单与正常单
   * 在下拉里无法区分。
   *
   * 服务端也已补上权威守卫（`ApService.createPayment` / `apWriteoff` 拒绝
   * `voided`），但客户端仍要过滤：下拉本该只列**可操作**的候选，
   * 让人先选到再报错是坏体验。
   *
   * 与 `ArTab` 的 `openArItems` 是同一处修复，两边保持一致。
   */
  const unpaidAps = (aps ?? []).filter(
    (a) => a.status !== 'paid' && a.status !== 'voided',
  );
  const paidPayments = (payments ?? []).filter((p) => p.status === 'approved');

  const handleExport = () => {
    const rows: ApItem[] = aps ?? [];
    if (rows.length === 0) {
      toast.error('当前列表为空，无可导出数据');
      return;
    }
    exportRowsToXlsx('应付列表.xlsx', '应付', AP_EXPORT_COLUMNS, rows);
  };

  const apColumns: TableColumnsType<ApItem> = [
    { title: '应付编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '供应商', dataIndex: 'supplierName', width: 160 },
    { title: '项目', dataIndex: 'projectName', width: 160, render: (v) => v ?? '-' },
    {
      title: '应付金额（含税）',
      dataIndex: 'amount',
      width: 140,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '已付',
      dataIndex: 'paidAmount',
      width: 120,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '未付',
      key: 'unpaid',
      width: 120,
      align: 'right',
      render: (_, record) => formatMoney(record.amount - record.paidAmount),
    },
    { title: '到期日', dataIndex: 'dueDate', width: 110, render: (v) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => <StatusBadge status={s} labels={AP_STATUS_LABELS} />,
    },
  ];

  const paymentColumns: TableColumnsType<PaymentItem> = [
    { title: '付款编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '供应商', dataIndex: 'supplierName', width: 160 },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 120,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    { title: '付款日期', dataIndex: 'payDate', width: 110, render: (v) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => <StatusBadge status={s} labels={PAYMENT_STATUS_LABELS} />,
    },
    { title: '审批人', dataIndex: 'approver', width: 100, render: (v) => v ?? '-' },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 220,
      render: (_, record) => (
        <div className="flex gap-1">
          {/* C-06：付款单（付款申请单）打印 */}
          <PrintButton
            variant="ghost"
            label="打印"
            stopPropagation
            build={() => ({
              kind: 'payment',
              code: record.code,
              title: '付款申请单',
              subtitle: `付款编号：${record.code}`,
              meta: compactFields([
                metaField('供应商', record.supplierName),
                metaField('关联应付单', record.apCode),
                metaField('付款日期', record.payDate),
                metaField('付款方式', record.method),
                metaField(
                  '状态',
                  PAYMENT_STATUS_LABELS[record.status] ?? record.status,
                ),
                metaField('审批人', record.approver),
              ]),
              totals: [
                {
                  label: '付款金额（小写）',
                  amount: record.amount,
                  inWords: true,
                  emphasize: true,
                },
              ],
              clauses: [
                record.remark ? `备注：${record.remark}` : '',
                '本付款单经审批后方可付款，付款后请将银行回单归档。',
              ].filter(Boolean),
              signatures: [
                { slot: 'prepared', label: '经办人', signer: null },
                { slot: 'reviewed', label: '财务复核', signer: null },
                { slot: 'chief_accountant', label: '财务主管', signer: null },
                { slot: 'approved', label: '批准', signer: record.approver ?? null },
              ],
              sourceNote: '数据来源：应付付款台账',
            })}
          />
          <CanCapabilityWrite capability="finance_write">
            <div className="flex gap-1">
              {record.status === 'pending' ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void approvePayment(record, 'approve')}
                  >
                    批准
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void approvePayment(record, 'reject')}
                  >
                    驳回
                  </Button>
                </>
              ) : null}
              {record.status !== 'voided' && record.status !== 'rejected' ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    void (async () => {
                      const ok = await confirmDanger(
                        `确认作废付款 ${record.code ?? record.id}？此操作不可恢复。`,
                      );
                      if (!ok) return;
                      try {
                        await financeApi.voidPayment(record.id);
                        toast.success('付款已作废');
                        await Promise.all([reload(), reloadPayments()]);
                      } catch (err: unknown) {
                        toast.error(getApiErrorMessage(err, '作废失败'));
                      }
                    })();
                  }}
                >
                  作废
                </Button>
              ) : null}
            </div>
          </CanCapabilityWrite>
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm">状态</span>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-32" aria-label="应付状态筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              {Object.entries(AP_STATUS_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
        <CanCapabilityWrite capability="finance_write">
          <Button onClick={() => setApOpen(true)}>
            <Plus className="h-4 w-4" />
            登记应付
          </Button>
        </CanCapabilityWrite>
        <CanCapabilityWrite capability="finance_write">
          <Button variant="outline" onClick={() => setPaymentOpen(true)}>
            <Plus className="h-4 w-4" />
            付款申请
          </Button>
        </CanCapabilityWrite>
        <CanCapabilityWrite capability="finance_write">
          <Button variant="outline" onClick={() => setWriteoffOpen(true)}>
            付款核销
          </Button>
        </CanCapabilityWrite>
        <CanCapabilityWrite capability="finance_write">
          <Button variant="outline" onClick={() => setVendorSettlementOpen(true)}>
            <Plus className="h-4 w-4" />
            外协结算
          </Button>
        </CanCapabilityWrite>
          <Button variant="outline" onClick={handleExport}>
            <Download className="h-4 w-4" />
            导出 Excel
          </Button>
        </div>
      </div>
      <DataState
        loading={loading}
        error={error}
        onRetry={() => void reload()}
        skeleton="table"
      >
        <div className="flex flex-col gap-3">
          <SectionTitle>应付账款</SectionTitle>
          <Table
            columns={apColumns}
            dataSource={aps ?? []}
            rowKey="id"
            scroll={{ x: 1200, y: 400 }}
            pagination={{
              pageSize: 10,
              showTotal: (t: number) => `共 ${t} 条`,
            }}
            locale={{ emptyText: '暂无应付，点击右上角「登记应付」创建' }}
          />
        </div>
        <div className="flex flex-col gap-3">
          <SectionTitle>付款记录</SectionTitle>
          <Table
            columns={paymentColumns}
            dataSource={payments ?? []}
            rowKey="id"
            scroll={{ x: 1000, y: 300 }}
            pagination={{
              pageSize: 10,
              showTotal: (t: number) => `共 ${t} 条`,
            }}
            locale={{ emptyText: '暂无付款记录，点击右上角「付款申请」创建' }}
            size="small"
          />
        </div>
      </DataState>

      <ApFormDialog open={apOpen} onOpenChange={setApOpen} suppliers={suppliers} onSaved={reload} />

      <PaymentApplyDialog
        open={paymentOpen}
        onOpenChange={setPaymentOpen}
        unpaidAps={unpaidAps}
        onSaved={reload}
      />

      <WriteoffDialog
        open={writeoffOpen}
        onOpenChange={setWriteoffOpen}
        unpaidAps={unpaidAps}
        paidPayments={paidPayments}
        onSaved={reload}
      />

      <VendorSettlementDialog
        open={vendorSettlementOpen}
        onOpenChange={setVendorSettlementOpen}
        suppliers={suppliers}
        projects={projects}
        onSaved={reload}
      />
    </div>
  );
};

export default ApTab;

