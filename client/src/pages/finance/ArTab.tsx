import React, { useState } from 'react';
import { ColumnHelpTitle } from '@client/src/components/erp/ItemHelp';
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
import { contractsApi, financeApi, masterDataApi } from '@client/src/api';
import { PrintButton } from '@client/src/components/print';
import { compactFields, metaField } from '@client/src/components/print';
import { useAsyncData } from '@client/src/hooks/useAsyncData';
import { confirmDanger } from '@client/src/utils/confirmDanger';
import { formatMoney } from '@client/src/utils/format';
import { arExportColumns as AR_EXPORT_COLUMNS } from './ar-schemas';
import ArFormDialog from './components/ArFormDialog';
import ReceiptApplyDialog from './components/ReceiptApplyDialog';
import ArWriteoffDialog from './components/ArWriteoffDialog';
import {
  exportRowsToXlsx,
} from '@client/src/components/excel/excel-utils';
import { getApiErrorMessage } from '@client/src/utils/api-error-message';
import type {
  ArItem,
  Contract,
  Customer,
  ReceiptItem,
} from '@shared/api.interface';

// 修复：这里原先自带 AR_STATUS_LABELS / RECEIPT_STATUS_LABELS 两份**本地**映射，
// 绕过了 `utils/biz-labels.ts` 的字典版（B-05 字典编辑对本品类页不生效），
// 且 `receipt_status` 的 `voided` 键在本地缺失 → 作废回款单显示英文状态码。
// 统一改为引用字典版（唯一真源）。
import {
  AR_STATUS_LABELS,
  RECEIPT_STATUS_LABELS,
} from '@client/src/utils/biz-labels';

/*
 * §5.9（F8）：`AR_EXPORT_COLUMNS` 与三个表单 schema 已移到 `./ar-schemas`。
 *
 * 与 `ap-schemas.ts` 同一拆分理由：零 React 依赖的纯声明，搬出来后
 * **可被单测**（`ar-schemas.spec.ts`）。
 *
 * 规格里特别钉住了应收与应付的**有意不对称**：
 *   · 应收单挂**合同**（`contractId`）—— 收入按合同确认，需可追溯；
 *   · 回款单挂**客户**（`customerId`）—— 一个客户可能一次付多个合同，
 *     归属由「核销」分摊。
 * 若有人为了"统一"把它们改成与应付一致，规格会失败。
 */

/*
 * §5.9（F8）：三个弹窗已各自拆成 `./components/` 下的组件。
 *
 * 上一轮只搬走了**纯声明**（schema / 导出列），文件仍然 680+ 行 —— 因为占体量的
 * 从来不是声明，而是本文件末尾 280 余行的三段 `<Dialog>` JSX（登记应收 /
 * 登记回款 / 回款核销）。本轮把这三段**整体**搬走，每个组件自带 `useForm`
 * 与提交处理器：
 *
 *   · 主文件保留：数据查询（`useAsyncData`）、两个表格的列定义与操作列、
 *     筛选区与导出按钮、以及两个下拉的**候选过滤** —— 也就是"页面级编排"；
 *   · 子组件只拿**数据**与 `onSaved`（写成功后由主文件重取列表），不再由主文件
 *     传入 setter。
 *
 * 与应付侧（`ApTab.tsx` + `components/ApFormDialog.tsx` /
 * `PaymentApplyDialog.tsx` / `WriteoffDialog.tsx`）同一套结构；
 * 本页的核销弹窗文件名多一个 `Ar` 前缀（`ArWriteoffDialog.tsx`），
 * 以免与应付的 `WriteoffDialog.tsx` 同名 —— 两者的 DTO 与字段名都不同。
 *
 * ⚠️ 三个必须保住的语义（搬迁时逐条核对）：
 *   ① 三个组件**无条件挂载**，不能写成 `{open && <XxxDialog/>}` ——
 *      `useForm` 原先是 `ArTab` 函数体里的常驻实例，条件挂载会改变表单状态的
 *      生命周期（等价于"打开即清空"）；
 *   ② 表单重置时机不变：都在**提交成功之后**重置（原实现没有"打开即清空"）；
 *   ③ JSX 文案、schema、校验消息逐字未动，`ar-schemas.ts` 仍是唯一定义处。
 */

const ArTab: React.FC = () => {
  const [statusFilter, setStatusFilter] = useState('all');
  const [arOpen, setArOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [writeoffOpen, setWriteoffOpen] = useState(false);

  const { data: ars, loading, error, reload } = useAsyncData<ArItem[]>(
    () => financeApi.listArs(undefined, statusFilter !== 'all' ? statusFilter : undefined),
    [statusFilter],
  );
  const { data: receipts, reload: reloadReceipts } = useAsyncData<ReceiptItem[]>(
    () => financeApi.listReceipts(),
    []
  );
  const { data: contracts } = useAsyncData<Contract[]>(() => contractsApi.listContracts(), []);
  const { data: customers } = useAsyncData<Customer[]>(
    () => masterDataApi.listCustomers(),
    [],
  );

  /*
   * ⚠️ 必须**同时**排除 `voided`，不能只排 `settled`。
   *
   * 作废的应收单 `amount − settledAmount` 通常仍是正数，所以"未核销"这个
   * 直觉判据会把它当成可核销候选列进下拉。而 `ArStatus` 契约含 `'voided'`、
   * `voidAr` 会真的写这个值、`listArs()` 在不传 status 时也不过状态 ——
   * 所以作废单真的会出现在列表与下拉里。选中后核销会被服务端拒绝
   * （`ArService.writeoff` 新增了守卫），但**让人先选到再报错**是坏体验：
   * 下拉本该只列可操作的候选。
   *
   * 这与 `ApTab` 的 `unpaidAps` 是同一处修复，两边保持一致。
   */
  const openArItems = (ars ?? []).filter(
    (a) => a.status !== 'settled' && a.status !== 'voided',
  );

  const handleExport = () => {
    const rows: ArItem[] = ars ?? [];
    if (rows.length === 0) {
      toast.error('当前列表为空，无可导出数据');
      return;
    }
    exportRowsToXlsx('应收列表.xlsx', '应收', AR_EXPORT_COLUMNS, rows);
  };

  const arColumns: TableColumnsType<ArItem> = [
    { title: '应收编号', dataIndex: 'code', fixed: 'left', width: 130, ellipsis: true },
    { title: '客户', dataIndex: 'customerName', width: 140, ellipsis: true },
    { title: '合同', dataIndex: 'contractName', width: 150, ellipsis: true },
    {
      title: '应收金额（含税）',
      dataIndex: 'amount',
      width: 140,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: (
        <ColumnHelpTitle
          title="已核销"
          content="已经用回款冲掉的金额。未核销等于应收金额减去已核销。"
        />
      ),
      dataIndex: 'settledAmount',
      width: 120,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: (
        <ColumnHelpTitle
          title="未核销"
          content="还没被回款冲掉的余额，等于应收金额减去已核销。"
        />
      ),
      key: 'unsettled',
      width: 120,
      align: 'right',
      render: (_, record) => formatMoney(record.amount - record.settledAmount),
    },
    { title: '到期日', dataIndex: 'dueDate', width: 100, render: (v) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (s: string) => <StatusBadge status={s} labels={AR_STATUS_LABELS} />,
    },
    {
      title: (
        <ColumnHelpTitle
          title="逾期"
          content="到期日早于今天、并且还没核销完，就标为逾期。没有到期日的不算逾期。"
        />
      ),
      dataIndex: 'overdue',
      width: 70,
      responsive: ['xxl'],
      render: (v: boolean) =>
        v ? <span className="text-destructive font-medium">逾期</span> : '-',
    },
  ];

  const receiptColumns: TableColumnsType<ReceiptItem> = [
    { title: '回款编号', dataIndex: 'code', fixed: 'left', width: 150 },
    { title: '客户', dataIndex: 'customerName', width: 140, ellipsis: true },
    {
      title: '金额',
      dataIndex: 'amount',
      width: 120,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    { title: '回款日期', dataIndex: 'receiptDate', width: 110, render: (v) => v ?? '-' },
    { title: '方式', dataIndex: 'method', width: 100, render: (v) => v ?? '-' },
    { title: '来源', dataIndex: 'source', width: 140, render: (v) => v ?? '-' },
    {
      title: '操作',
      key: 'action',
      width: 150,
      render: (_, record) => (
        <div className="flex gap-1">
          {/* C-06：回款单（收据）打印；作废件仍可补打留档 */}
          <PrintButton
            variant="ghost"
            label="打印"
            stopPropagation
            build={() => ({
              kind: 'receipt',
              code: record.code,
              title: '回款单（收据）',
              subtitle: `回款编号：${record.code}`,
              meta: compactFields([
                metaField('客户', record.customerName),
                metaField('回款日期', record.receiptDate),
                metaField('回款方式', record.method),
                metaField('来源', record.source),
                metaField(
                  '状态',
                  RECEIPT_STATUS_LABELS[record.status] ?? record.status,
                ),
              ]),
              totals: [
                {
                  label: '回款金额（小写）',
                  amount: record.amount,
                  inWords: true,
                  emphasize: true,
                },
              ],
              clauses: [
                record.remark ? `备注：${record.remark}` : '',
                '本收据以银行到账为准，如有差异请于 7 个工作日内联系财务。',
              ].filter(Boolean),
              signatures: [
                { slot: 'prepared', label: '收款经办', signer: null },
                { slot: 'reviewed', label: '财务复核', signer: null },
                { slot: 'chief_accountant', label: '财务主管', signer: null },
              ],
              sourceNote: '数据来源：应收回款台账',
            })}
          />
          {record.status !== 'voided' ? (
            <CanCapabilityWrite capability="finance_write">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void (async () => {
                    const ok = await confirmDanger(
                      `确认作废回款 ${record.code ?? record.id}？此操作不可恢复。`,
                    );
                    if (!ok) return;
                    try {
                      await financeApi.voidReceipt(record.id);
                      toast.success('回款已作废');
                      await Promise.all([reload(), reloadReceipts()]);
                    } catch (err: unknown) {
                      toast.error(getApiErrorMessage(err, '作废失败'));
                    }
                  })();
                }}
              >
                作废
              </Button>
            </CanCapabilityWrite>
          ) : null}
        </div>
      ),
    },
  ];

  /*
   * ⚠️ 与上面的 `openArItems` 同一处缺陷、同一种修法：候选下拉必须**同时**
   * 排掉作废件，而不是只排"顺利走完流程"的那个终态。
   *
   * 原实现只排 `matched`（已核销完），漏了 `voided`。而 `voided` 是**真的
   * 会进候选**的：
   *   · 契约 `ReceiptStatus = 'unmatched' | 'partial' | 'matched' | 'voided'`
   *     （`shared/api.interface.ts`）；
   *   · `ArService.listReceipts()` 不按状态过滤，作废回款单照常出现在本页的
   *     「回款记录」表里；
   *   · 服务端 `ArService.writeoff` 对 `voided` 回款是**无条件拒绝**的
   *     （回「回款已作废，不可核销」），也就是说这个候选选了必然失败。
   *
   * 判据与 `openArItems`、`ApTab.unpaidAps` / `paidPayments` 保持一致：
   * 下拉本该只列**可操作**的候选（`paidPayments` 用的是白名单
   * `status === 'approved'`，所以应付侧本来就不受影响 —— 应收侧这里是漏网的一处）。
   */
  const receiptOptions = (receipts ?? []).filter(
    (r) => r.status !== 'matched' && r.status !== 'voided',
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-sm">状态</span>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger id="ar-status-filter" className="w-32" aria-label="应收状态筛选">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部</SelectItem>
              {Object.entries(AR_STATUS_LABELS).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <CanCapabilityWrite capability="finance_write">
            <Button onClick={() => setArOpen(true)}>
              <Plus className="h-4 w-4" />
              登记应收
            </Button>
          </CanCapabilityWrite>
          <CanCapabilityWrite capability="finance_write">
            <Button variant="outline" onClick={() => setReceiptOpen(true)}>
              <Plus className="h-4 w-4" />
              登记回款
            </Button>
          </CanCapabilityWrite>
          <CanCapabilityWrite capability="finance_write">
            <Button variant="outline" onClick={() => setWriteoffOpen(true)}>
              回款核销
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
          <SectionTitle>应收账款</SectionTitle>
          <Table
            columns={arColumns}
            dataSource={ars ?? []}
            rowKey="id"
            scroll={{ x: 1120, y: 400 }}
            pagination={{
              pageSize: 10,
              showTotal: (t: number) => `共 ${t} 条`,
            }}
            locale={{ emptyText: '暂无应收，点击右上角「登记应收」创建' }}
          />
        </div>
        <div className="flex flex-col gap-3">
          <SectionTitle>回款记录</SectionTitle>
          <Table
            columns={receiptColumns}
            dataSource={receipts ?? []}
            rowKey="id"
            scroll={{ x: 800, y: 300 }}
            pagination={{
              pageSize: 10,
              showTotal: (t: number) => `共 ${t} 条`,
            }}
            locale={{ emptyText: '暂无回款，点击右上角「登记回款」创建' }}
            size="small"
          />
        </div>
      </DataState>

      {/* ⚠️ 三个弹窗**无条件挂载**，不要改成 `{open && <XxxDialog/>}`：
          `useForm` 原先是本函数体里的常驻实例，条件挂载会改变其生命周期。 */}
      <ArFormDialog
        open={arOpen}
        onOpenChange={setArOpen}
        contracts={contracts}
        onSaved={reload}
      />

      <ReceiptApplyDialog
        open={receiptOpen}
        onOpenChange={setReceiptOpen}
        customers={customers}
        onSaved={reload}
      />

      <ArWriteoffDialog
        open={writeoffOpen}
        onOpenChange={setWriteoffOpen}
        openArItems={openArItems}
        receiptOptions={receiptOptions}
        onSaved={reload}
      />
    </div>
  );
};

export default ArTab;




