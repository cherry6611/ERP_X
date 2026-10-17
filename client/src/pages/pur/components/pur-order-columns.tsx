/**
 * 采购订单表的列定义（§5.9 / F8）
 *
 * 从 `PurOrderPanel.tsx` 抽出的 `TableColumnsType<PurOrderItem>`（原文件 201-397 行）。
 * 列定义约 190 行，且**改错看不出来**：「操作」列的 `render` 里挂错处理函数时按钮
 * 照样能点，只是打到了错误的行；打印按钮 `build` 里取错字段时打印件照样能出，
 * 只是数字不对 —— 这两类都不会报错，只能靠逐列读。
 *
 * ## 为什么是工厂函数而不是常量数组
 *
 * 「操作」列的 `render` 闭包了父组件的两个处理函数（打开验收弹窗、取消订单），
 * 它们随父组件每次渲染而变，常量数组无法持有，故由父组件在渲染时调用本函数注入。
 * ⚠️ 数组字面量**逐字搬运（含缩进）**：只加了外层 `return`、`interface` 与两个入参，
 * 列头文案、宽度、`fixed` / `dataIndex` / `render` 与打印模板全部未动。
 * 两个入参按 `attendance-columns.tsx` 的既有写法在解构处绑回原变量名
 * （`onAccept: openAcceptDialog` / `onCancel: doCancel`），因此下面每一个字符都是原文。
 *
 * ## 验收单金额口径差异 —— ✅ 已修（原为"已知未修"）
 *
 * **问题**：验收单的「验收金额」原按
 * `Number((unitPrice * acceptedQuantity).toFixed(2))` **对合计数量一次性取整**，
 * 而服务端 `PurService.acceptOrder` 是**每次验收各自取整**后落
 * `erp_ap_bill.amount`（`round2(dto.quantity * unitPrice)`，口径见
 * `shared/number.ts`）。逐次取整之和 ≠ 合计取整，实测：
 *   · 单价 0.333、数量 3、分 3 次各验 1 —— 打印件 1.00（0.333×3 = 0.999），
 *     实际应付 = 0.33×3 = 0.99，差 0.01；
 *   · 单价 2.675、数量 1、一次验完 —— 打印件 2.67（`(2.675).toFixed(2)`），
 *     实际应付 = round2(2.675) = 2.68，差 0.01；同一行的「订单金额」列（落库值
 *     `record.amount`）也显示 2.68，即打印件与列表自相矛盾。
 *
 * **为什么客户端修不了**：`PurOrderItem` 原先只有 `acceptedQuantity` /
 * `acceptDate` 两个汇总字段，**拿不到每次验收的金额**，无法正确重算。
 *
 * **修法**（经业务确认后实施）：服务端在 `PurOrderItem` 上新增
 * **`acceptedAmount`** —— 由 `PurService.orderSelect()` 聚合真实落库的验收应付
 * （`erp_ap_bill` 里 `source_ref LIKE 'po-accept:{订单号}:%'` 且未作废）得到；
 * 打印件改为直接用它。非验收单打印的「订单金额」也改用落库的 `record.amount`。
 * 两者都与列表同源，不再有派生差异。
 *
 * ⚠️ 曾经的"根因判断"是**错的**，不要按它改：我一度以为根因是创建订单时
 * `unitPrice` 未限二位小数。核对 schema 后发现 `pur_order.unit_price` 是
 * **`numeric(18,6)`**（人天费率需要高于分的精度，而 `amount` 才是 `(18,2)`），
 * 给单价加 `maxDecimalPlaces: 2` 会把有效精度一刀切掉。
 */
import { TableColumnsType } from 'antd';
import { CanCapabilityWrite } from '@client/src/platform/auth';
import PurStatusBadge, {
  PUR_ORDER_CATEGORY_LABELS,
  PUR_ORDER_STATUS_LABELS,
} from './PurStatusBadge';
import { Button } from '@client/src/components/ui/button';
import { PrintButton } from '@client/src/components/print';
import { cellText, compactFields, metaField } from '@client/src/components/print';
import { formatMoney } from '@client/src/utils/format';
import type { PurOrderItem } from '@shared/api.interface';

interface PurOrderColumnsArgs {
  /** 打开「订单验收」弹窗（弹窗内的表单重置仍在父组件的行点击处同步执行，见 `PurOrderPanel.tsx` 文件头） */
  onAccept: (order: PurOrderItem) => void;
  /** 取消订单（父组件调 `purApi.cancelOrder`） */
  onCancel: (order: PurOrderItem) => void;
}

export function purOrderColumns({
  onAccept: openAcceptDialog,
  onCancel: doCancel,
}: PurOrderColumnsArgs): TableColumnsType<PurOrderItem> {
  const columns: TableColumnsType<PurOrderItem> = [
    { title: '编号', dataIndex: 'code', fixed: 'left', width: 140 },
    { title: '采购品名', dataIndex: 'itemName', width: 160 },
    {
      title: '类别',
      dataIndex: 'category',
      width: 90,
      render: (v: string) => PUR_ORDER_CATEGORY_LABELS[v] ?? v,
    },
    { title: '供应商', dataIndex: 'supplierName', width: 130 },
    { title: '合同', dataIndex: 'contractName', width: 140, render: (v: string | null) => v ?? '-' },
    { title: '项目', dataIndex: 'projectName', width: 130, render: (v: string | null) => v ?? '-' },
    {
      title: '数量',
      key: 'quantity',
      width: 110,
      render: (_: unknown, record: PurOrderItem) =>
        `${record.acceptedQuantity} / ${record.quantity}`,
    },
    {
      title: '单价（含税）',
      dataIndex: 'unitPrice',
      width: 100,
      align: 'right',
      render: (v: number) => formatMoney(v),
    },
    {
      title: '订单金额（含税）',
      dataIndex: 'amount',
      width: 120,
      align: 'right',
      render: (v: number) => <span className="font-medium">{formatMoney(v)}</span>,
    },
    { title: '下单日期', dataIndex: 'orderDate', width: 110, render: (v: string | null) => v ?? '-' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 90,
      render: (s: string) => (
        <PurStatusBadge status={s} labels={PUR_ORDER_STATUS_LABELS} />
      ),
    },
    {
      title: '操作',
      key: 'action',
      fixed: 'right',
      width: 260,
      render: (_: unknown, record: PurOrderItem) => (
        <div className="flex gap-1">
          {/*
            C-06：采购订单打印。
            已验收订单直接出「验收单」（含验收数量/日期），未验收订单出「采购订单」。
          */}
          <PrintButton
            variant="ghost"
            label={record.status === 'accepted' ? '验收单' : '打印'}
            stopPropagation
            build={() => {
              const acceptedQuantity = Number(record.acceptedQuantity ?? 0);
              const isAcceptance = record.status === 'accepted' && acceptedQuantity > 0;
              /*
               * 「验收金额」直接用**服务端算好的已验收金额**，不再客户端重算。
               *
               * 原先这里是 `Number((unitPrice * acceptedQuantity).toFixed(2))` ——
               * 对合计数量**一次性取整**，而服务端 `acceptOrder` 是**逐次验收
               * 各自 round2** 后落 `erp_ap_bill.amount`。单价超过两位小数时必然分叉：
               *   · 单价 0.333、分 3 次各验 1 → 打印件 1.00，实际应付 0.99；
               *   · 单价 2.675、一次验完 → 打印件 2.67，实际应付 2.68
               *     （同一列表格的「订单金额」列显示 2.68 → 打印件与列表自相矛盾）。
               *
               * `acceptedAmount` 由 `PurService.orderSelect()` 聚合真实落库的
               * 验收应付（且排除已作废）得到，因此与列表/应付**同源**。
               *
               * 非验收单（status 不是 accepted）打印的是**订单金额**，用
               * `record.amount`（同样是落库值），也不再由单价×数量推导 ——
               * 否则单价 2.675、数量 1 时打印件 2.67 而列表 2.68，仍会矛盾。
               */
              const acceptedAmount = isAcceptance
                ? Number(record.acceptedAmount ?? 0)
                : Number(record.amount ?? 0);
              /*
               * 打印的「验收数量」直接用订单头上落库的 `acceptedQuantity`。
               *
               * ⚠️ 这里**曾经**由金额反推数量（`acceptedAmount / unitPrice`），
               * 理由是"金额与数量必须同源"。走查实测该反推会印出**错的件数**：
               * 服务端每次验收各自 round2 后落应付，而 `unit_price` 是
               * `numeric(18,6)`（人天费率需要高于分的精度），两者相除不是整数 ——
               * 单价 0.333、分 3 次各验 1 件时 `acceptedAmount = 0.99`，
               * `0.99 / 0.333 = 2.97`，于是验收单印「已验收数量 2.97」「订单数量 3」，
               * 同一张单据内部自相矛盾，且与列表的「3 / 3」也不一致。
               *
               * `acceptedQuantity` 与 `acceptedAmount` 是**同一次验收事务里一起写的**
               * （`PurService.acceptOrder` 同一个 `tx` 内累加数量、插应付），
               * 不存在"两条路径读到不同批次"的现实场景；数量就该用数量字段。
               */
              const acceptedQtyForPrint = acceptedQuantity;
              const commonMeta = compactFields([
                metaField('供应商', record.supplierName),
                metaField('采购品名', record.itemName),
                metaField(
                  '采购类别',
                  PUR_ORDER_CATEGORY_LABELS[record.category] ?? record.category,
                ),
                metaField('关联合同', record.contractName),
                metaField('关联项目', record.projectName),
                metaField('关联采购申请', record.requestCode),
                metaField('下单日期', record.orderDate),
              ]);
              if (isAcceptance) {
                return {
                  kind: 'pur_acceptance',
                  code: record.code,
                  title: '采购验收单',
                  subtitle: `订单编号：${record.code}`,
                  meta: [
                    ...commonMeta,
                    ...compactFields([
                      metaField('验收日期', record.acceptDate),
                      metaField('订单数量', cellText(record.quantity)),
                      metaField('已验收数量', cellText(acceptedQtyForPrint)),
                    ]),
                  ],
                  tableTitle: '验收明细',
                  columns: [
                    { key: 'item', label: '采购品名' },
                    { key: 'unitPrice', label: '单价（含税）', widthMm: 26, align: 'right' },
                    { key: 'quantity', label: '订单数量', widthMm: 20, align: 'right' },
                    { key: 'accepted', label: '验收数量', widthMm: 20, align: 'right' },
                    { key: 'amount', label: '验收金额', widthMm: 28, align: 'right' },
                  ],
                  rows: [
                    {
                      cells: {
                        item: record.itemName,
                        unitPrice: cellText(record.unitPrice),
                        quantity: cellText(record.quantity),
                        accepted: cellText(acceptedQtyForPrint),
                        amount: cellText(acceptedAmount),
                      },
                    },
                  ],
                  totals: [
                    {
                      label: '验收金额（含税）',
                      amount: acceptedAmount,
                      inWords: true,
                      emphasize: true,
                    },
                  ],
                  clauses: [
                    record.remark ? `备注：${record.remark}` : '',
                    '验收结论：货物/服务符合订单要求，同意验收并作为应付确认依据。',
                  ].filter(Boolean),
                  signatures: [
                    { slot: 'prepared', label: '验收人', signer: null },
                    { slot: 'reviewed', label: '需求部门', signer: null },
                    { slot: 'approved', label: '批准', signer: null },
                  ],
                  sourceNote: '数据来源：采购管理模块',
                };
              }
              return {
                kind: 'pur_order',
                code: record.code,
                title: '采购订单',
                subtitle: `订单编号：${record.code}`,
                meta: commonMeta,
                tableTitle: '订单明细',
                columns: [
                  { key: 'item', label: '采购品名' },
                  { key: 'category', label: '类别', widthMm: 20, align: 'center' },
                  { key: 'quantity', label: '数量', widthMm: 18, align: 'right' },
                  { key: 'unitPrice', label: '单价（含税）', widthMm: 26, align: 'right' },
                  { key: 'amount', label: '订单金额', widthMm: 28, align: 'right' },
                ],
                rows: [
                  {
                    cells: {
                      item: record.itemName,
                      category: PUR_ORDER_CATEGORY_LABELS[record.category] ?? record.category,
                      quantity: cellText(record.quantity),
                      unitPrice: cellText(record.unitPrice),
                      amount: cellText(record.amount),
                    },
                  },
                ],
                totals: [
                  {
                    label: '订单金额（含税）',
                    amount: record.amount,
                    inWords: true,
                    emphasize: true,
                  },
                ],
                clauses: [record.remark ? `备注：${record.remark}` : ''].filter(Boolean),
                sourceNote: '数据来源：采购管理模块',
              };
            }}
          />
          <CanCapabilityWrite capability="pur_asset">
            <div className="flex gap-1">
              {record.status === 'pending' ? (
                <>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openAcceptDialog(record)}
                  >
                    验收
                  </Button>
                  {record.acceptedQuantity === 0 ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive"
                      onClick={() => void doCancel(record)}
                    >
                      取消
                    </Button>
                  ) : null}
                </>
              ) : null}
            </div>
          </CanCapabilityWrite>
        </div>
      ),
    },
  ];

  return columns;
}
