/**
 * 发票台账表格（`InvoicesTab.tsx`）的列定义（§5.9 / F8）。
 *
 * ## 为什么是工厂函数而不是常量
 *
 * 「操作」列的每个按钮都闭包了组件层的东西：跳详情页的 `navigate`、打开关联应收
 * 弹窗的 `openLinkDialog`，以及作废 / 查验 / 认证三个提交处理器（它们要
 * `await reload()` 重取台账）。常量数组无法持有这些，故由父组件在渲染时调用
 * `invoiceColumns({...})` 取列定义 —— 与 `pages/hr/components/attendance-columns.tsx` 同形。
 *
 * ⚠️ 列定义数组本身是**逐字搬运**：列头文案、宽度、`fixed`、`dataIndex`、
 * `render` 全未动，参数名也刻意沿用父组件的标识符（`navigate` / `openLinkDialog` /
 * `handleVoid` / `handleVerify` / `handleCertify`），因此搬过来的 JSX 一个字都不用改。
 * 唯一的两处改动是「作废 / 认证」按钮的**可操作性判据**（见下），文案未动。
 *
 * ## 本轮修掉的两个「点了必然报错」按钮
 *
 * 四个动作按钮原先只按 `record.status === 'issued'` 渲染，但服务端在这两个动作上
 * 还有更严的闸门，而契约已把判据透出到 `InvoiceItem` 上：
 *
 * ① **「认证」对销项发票必然失败**。`invoice-verify.service.ts` 的 `certifyInvoice`
 *    有 P0-A 闸门（该文件 246–254 行专门记录了这条修正）：
 *      `if ((row.direction ?? 'sales') !== 'purchase') throw new BadRequestException(`
 *      `'仅进项发票（direction=purchase）可勾选认证；销项发票的抵扣凭证是购买方取得后自行勾选')`；
 *    同处还拒绝红字票（`amount < 0 || sourceRef?.startsWith('red-letter:')`）。
 *    而本列对所有 `issued` 行都渲染「认证」—— 销项发票占了台账一半，
 *    点它必定只换来一条报错（还要先手输所属期）。
 *    修法：按契约字段收窄渲染条件（`direction === 'purchase' && !isRedLetter`），
 *    与同列「关联应收」已有的 `record.direction === 'sales'` 方向判据同形。
 *    `isRedLetter` = `amount < 0 && Boolean(sourceRef)`（服务端 `toInvoiceItem`），
 *    而负数金额只可能由红字路径写入（`CreateInvoiceDto.amount` 是 `@Min(0.01)`，
 *    红字路径强制 `sourceRef` 非空且落负数）—— 该判据不会藏掉服务端允许的动作。
 *
 * ② **「作废」在已申报所属期上必然失败**。`invoice.service.ts` 的 `voidInvoice`
 *    有 P0-C 闸门：
 *      `if (period && (await isVatPeriodDeclared(tx, period))) throw new BadRequestException(`
 *      `'发票所属期 … 的增值税申报底稿已确认，跨月不得作废…请改用「开具红字发票」冲减')`；
 *    而契约 `InvoiceItem.declaredPeriodConfirmed` 的注释明确要求
 *    「**前端据此禁用「作废」按钮**并提示改走红字流程 —— 而不是让用户点了才报错」。
 *    列表接口已批量标注该字段（`declaredVatPeriodSet`，与作废闸门同一条件 ——
 *    `server/common/utils/vat-declaration-period.ts` 注明"两条路径不得分叉"）。
 *    修法：`disabled={record.declaredPeriodConfirmed}` + `title` 说明改走红字发票。
 *
 * 两处都只改**可操作性**，不改任何文案（「作废」「认证」四个字逐字未动）；
 * 也刻意没有扩大范围去动「查验」（服务端只拒绝 `voided`，与本列判据一致）
 * 与「关联应收」（`updateInvoice` 无状态闸门，作废票也允许补充关联）。
 */
import { TableColumnsType } from 'antd';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import { Badge } from '@client/src/components/ui/badge';
import { Button } from '@client/src/components/ui/button';
import { ColumnHelpTitle } from '@client/src/components/erp/ItemHelp';
import { formatMoney } from '@client/src/utils/format';
import { STATUS_VARIANTS } from '@client/src/utils/biz-labels';
import { formatTaxSplitLine } from '@client/src/utils/tax-display';
import {
  CERT_STATUS_LABELS,
  CERT_STATUS_VARIANTS,
  DIRECTION_LABELS,
  INVOICE_STATUS_LABELS,
  INVOICE_TYPE_LABELS,
  VERIFY_STATUS_LABELS,
  VERIFY_STATUS_VARIANTS,
} from '../invoice-schemas';
import type { InvoiceDirection, InvoiceItem } from '@shared/api.interface';

interface InvoiceColumnsArgs {
  /** 跳转发票详情（`navigate(`/finance/invoices/${record.id}`)`），由父组件注入 react-router 的 navigate */
  navigate: (path: string) => void;
  /** 打开「关联应收」弹窗，并带出该发票当前已关联的应收（父组件 `openLinkDialog`） */
  openLinkDialog: (record: InvoiceItem) => void;
  /** 打开「编辑发票」弹窗（父组件 `openEditDialog`） */
  onEdit: (record: InvoiceItem) => void;
  /** 作废发票（含二次确认与失败 toast），由父组件注入 */
  handleVoid: (invoice: InvoiceItem) => Promise<void>;
  /** 单张查验，由父组件注入 */
  handleVerify: (invoice: InvoiceItem) => Promise<void>;
  /** 勾选认证（`window.prompt` 输所属期），由父组件注入 */
  handleCertify: (invoice: InvoiceItem) => Promise<void>;
  /** 快速查看抽屉 */
  onQuickView: (invoice: InvoiceItem) => void;
}

export function invoiceColumns({
  navigate,
  openLinkDialog,
  onEdit,
  handleVoid,
  handleVerify,
  handleCertify,
  onQuickView,
}: InvoiceColumnsArgs): TableColumnsType<InvoiceItem> {
  const columns: TableColumnsType<InvoiceItem> = [
    { title: '申请编号', dataIndex: 'code', fixed: 'left', width: 130, ellipsis: true },
    {
      title: '方向',
      dataIndex: 'direction',
      width: 80,
      render: (v: InvoiceDirection) => (
        <Badge variant={v === 'sales' ? 'info' : 'secondary'}>{DIRECTION_LABELS[v] ?? v}</Badge>
      ),
    },
    {
      title: '往来方',
      dataIndex: 'customerName',
      width: 140,
      ellipsis: true,
      render: (v: string, record: InvoiceItem) =>
        record.direction === 'sales' ? record.customerName : (record.supplierName ?? '-'),
    },
    { title: '合同', dataIndex: 'contractName', width: 160, responsive: ['xxl'], ellipsis: true, render: (v: string) => v ?? '-' },
    {
      title: '发票类型',
      dataIndex: 'invoiceType',
      width: 130,
      responsive: ['xxl'],
      render: (t: string) => INVOICE_TYPE_LABELS[t] ?? t,
    },
    {
      title: '发票号码',
      dataIndex: 'invoiceNo',
      width: 150,
      ellipsis: true,
      render: (v: string | null, record: InvoiceItem) =>
        v ? (
          record.status === 'voided' ? (
            <span className="text-muted-foreground line-through">{v}</span>
          ) : (
            v
          )
        ) : (
          '-'
        ),
    },
    {
      title: '关联应收',
      dataIndex: 'arCode',
      width: 140,
      responsive: ['xxl'],
      render: (v: string | null) => v ?? '-',
    },
    {
      title: '开票金额（含税）',
      dataIndex: 'amount',
      width: 160,
      align: 'right',
      render: (v: number, record) => (
        <div className="text-right">
          <div>{formatMoney(v)}</div>
          <div className="text-xs text-muted-foreground">
            {formatTaxSplitLine(v, record.taxRate)}
          </div>
        </div>
      ),
    },
    {
      title: '税额',
      dataIndex: 'taxAmount',
      width: 110,
      responsive: ['xxl'],
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    { title: '开票日期', dataIndex: 'invoiceDate', width: 110, responsive: ['xxl'], render: (v: string) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => (
        <Badge variant={STATUS_VARIANTS[s] ?? 'secondary'}>
          {INVOICE_STATUS_LABELS[s] ?? s}
        </Badge>
      ),
    },
    {
      title: (
        <ColumnHelpTitle
          title="查验状态"
          content="查验只改变这张发票的税务状态。没有配置查验服务商时，系统只记录状态，不会连到税局。"
        />
      ),
      dataIndex: 'verifyStatus',
      width: 100,
      responsive: ['xxl'],
      render: (v: string, record: InvoiceItem) => (
        <div className="flex flex-col gap-0.5">
          <Badge variant={VERIFY_STATUS_VARIANTS[v] ?? 'secondary'}>
            {VERIFY_STATUS_LABELS[v] ?? v}
          </Badge>
          {record.verifyError ? (
            <span className="text-[11px] text-destructive leading-tight">{record.verifyError}</span>
          ) : null}
        </div>
      ),
    },
    {
      title: (
        <ColumnHelpTitle
          title="认证状态"
          content="认证只对进项发票有意义，用来勾选抵扣。销项发票不能认证。没有配置服务时，只记录状态。"
        />
      ),
      dataIndex: 'certificationStatus',
      width: 110,
      responsive: ['xxl'],
      render: (v: string, record: InvoiceItem) => (
        <div className="flex flex-col gap-0.5">
          <Badge variant={CERT_STATUS_VARIANTS[v] ?? 'secondary'}>
            {CERT_STATUS_LABELS[v] ?? v}
          </Badge>
          {record.certificationPeriod ? (
            <span className="text-[11px] text-muted-foreground leading-tight">
              {record.certificationPeriod}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      title: '操作',
      key: 'actions',
      width: 220,
      fixed: 'right',
      render: (_: unknown, record: InvoiceItem) => (
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onQuickView(record)}
          >
            查看
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate(`/finance/invoices/${record.id}`)}
          >
            详情
          </Button>
          {/*
            * 「编辑」只在**已开具**的发票上渲染。
            *
            * 已作废的票不给入口：它的冲回凭证已生成，改发票本身会让"已作废"
            * 失去意义（服务端也会拒，见 `server/modules/finance/invoice-edit-guard.ts`）。
            *
            * ⚠️ 有意**不**在这里判断"凭证是否已过账" —— 那要多查一次凭证状态，
            * 且把服务端的判据复制到前端（两份真相必然漂移）。金额确已过账时
            * 服务端会拒绝，并把「先作废该发票再重新登记」的下一步写在错误文案里。
            */}
          {record.status === 'issued' ? (
            <CanCapabilityWrite capability="finance_write">
              <Button variant="ghost" size="sm" onClick={() => onEdit(record)}>
                编辑
              </Button>
            </CanCapabilityWrite>
          ) : null}
          {record.direction === 'sales' ? (
            <CanCapabilityWrite capability="finance_write">
              <Button variant="ghost" size="sm" onClick={() => openLinkDialog(record)}>
                关联应收
              </Button>
            </CanCapabilityWrite>
          ) : null}
          {record.status === 'issued' ? (
            <CanCapabilityWrite capability="finance_write">
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                disabled={record.declaredPeriodConfirmed}
                title={
                  record.declaredPeriodConfirmed
                    ? '所属期增值税申报底稿已确认，不可作废；请改开红字发票冲减'
                    : undefined
                }
                onClick={() => void handleVoid(record)}
              >
                作废
              </Button>
            </CanCapabilityWrite>
          ) : null}
          {record.status === 'issued' ? (
            <CanCapabilityWrite capability="finance_write">
              <Button variant="ghost" size="sm" onClick={() => void handleVerify(record)}>
                查验
              </Button>
            </CanCapabilityWrite>
          ) : null}
          {record.status === 'issued' &&
          record.direction === 'purchase' &&
          !record.isRedLetter ? (
            <CanCapabilityWrite capability="finance_write">
              <Button variant="ghost" size="sm" onClick={() => void handleCertify(record)}>
                认证
              </Button>
            </CanCapabilityWrite>
          ) : null}
        </div>
      ),
    },
  ];

  return columns;
}





