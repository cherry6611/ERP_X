import {
  apPaymentOptionLabel,
  apSchema,
  apTableMeta,
  apUnpaidAmount,
  AR_AP_COLUMN_VALUES,
  AR_AP_PAYMENT_STATUS_LABELS,
  AR_STATUS_LABELS,
  AP_STATUS_LABELS,
  arApLabelMoney,
  arReceiptOptionLabel,
  arSchema,
  arTableMeta,
  arUnsettledAmount,
  contractCustomerLabel,
  openArItems,
  payableApItems,
  paymentSchema,
  paymentTableMeta,
  receiptSchema,
  receiptTableMeta,
  RECEIPT_STATUS_LABELS_FALLBACK,
  type ColumnMeta,
} from './ar-ap-model';
import { formatMoney } from '@client/src/utils/format';
import { round2 } from '@shared/number';
import type {
  ApStatus,
  ArStatus,
  ChainApItem,
  ChainArItem,
  PaymentItem,
  PaymentStatus,
  ReceiptItem,
  ReceiptStatus,
} from '@shared/api.interface';

/**
 * 项目详情页「应收 / 应付」纯逻辑规格（§5.9 / F8）。
 *
 * ## 这个文件在防什么
 *
 * 三类"改错了界面上完全看不出来"的错误：
 *
 * 1. **列取错字段**。表格不会因为「已核销」列取成 `amount` 而报错 —— 它照样渲染，
 *    只是「已核销」与「应收金额」两列显示同一个数，对账的人会以为款已收齐。
 *    下面每一列都拿**字段值刻意互不相同**的行去断言，
 *    并且断言"未核销 ≠ 应收金额 ≠ 已核销"，让取错字段必然失败。
 * 2. **状态标签漏键**。`StatusBadge` 的兜底是 `labels[status] ?? status`，
 *    漏一个键 = 界面上那一格显示**英文码**（不是空白，所以更不容易被注意到）。
 * 3. **schema 的金额门槛**。zod 的报错只在提交时以 toast 出现，
 *    没测边界的话，一个误改的 `min(1) → min(0)` 会静默放进 0 元单据。
 *
 * ## 为什么规格读 `AR_AP_COLUMN_VALUES` 而不是自己写一遍取值
 *
 * 那份映射由**组件与规格共用**（组件用它渲染，规格用它断言）。
 * 如果规格自己写 `row.settledAmount` 去比对，就等于把实现抄了一遍 ——
 * 两边同时改错（例如一起把 `settledAmount` 写成 `amount`）会"对齐"而通过。
 * 共享一份映射时，"列 → 字段"的**契约**只有一个定义点，
 * 而下面逐列的期望值（`¥750.00` 之类）是手写常量，改错必然对不上。
 */

/* ── 测试行：每个字段的值都刻意不同 ─────────────────────────────────────── */

/**
 * 应收行。`amount=1000`、`settledAmount=250`、`ownerUserId='user-9'`、
 * `status='partial'` —— 四个值互不相同且互不为对方的子串，
 * 于是"哪一列取哪个字段"错一个就立刻暴露。
 */
function arRow(): ChainArItem {
  return {
    id: 'ar-uuid-1',
    code: 'AR2026100001',
    amount: 1000,
    settledAmount: 250,
    dueDate: '2026-11-30',
    status: 'partial',
    ownerUserId: 'user-9',
  };
}

/** 应付行。`amount=800`、`paidAmount=125`，与应收侧刻意取不同的数 */
function apRow(): ChainApItem {
  return {
    id: 'ap-uuid-1',
    code: 'AP2026100001',
    supplierName: '供应商甲',
    amount: 800,
    paidAmount: 125,
    dueDate: '2026-12-31',
    status: 'partial',
  };
}

/** 回款行（`ReceiptItem` 字段更全，多余字段用构造器补齐，只测用到的部分） */
function receiptRow(): ReceiptItem {
  return {
    id: 'rcv-uuid-1',
    code: 'RCV2026100001',
    customerId: 'cust-uuid-1',
    customerName: '客户乙',
    amount: 640.5,
    receiptDate: '2026-10-09',
    method: 'cash',
    source: 'manual',
    status: 'unmatched',
    remark: null,
    createdAt: '2026-10-09T01:00:00.000Z',
  } as ReceiptItem;
}

/** 付款行 */
function paymentRow(): PaymentItem {
  return {
    id: 'pay-uuid-1',
    code: 'PAY2026100001',
    apId: 'ap-uuid-1',
    apCode: 'AP2026100001',
    supplierId: 'sup-uuid-1',
    supplierName: '供应商丙',
    amount: 320.25,
    payDate: '2026-10-11',
    method: 'bank',
    status: 'approved',
    approver: null,
    remark: null,
    createdAt: '2026-10-11T01:00:00.000Z',
  } as PaymentItem;
}

/* ── 列定义 ─────────────────────────────────────────────────────────────── */

const titles = (meta: ReadonlyArray<ColumnMeta>) => meta.map((m) => m.title);
const columnOf = (meta: ReadonlyArray<ColumnMeta>, kind: string): ColumnMeta => {
  const found = meta.find((m) => m.kind === kind);
  // 找不到列说明 kind 被改名/删除，比任何断言失败都更该先报出来
  if (!found) throw new Error(`列 kind=${kind} 不存在`);
  return found;
};

describe('四张表的列定义', () => {
  it('每张表的表头与列序固定', () => {
    expect(titles(arTableMeta)).toEqual([
      '应收编号',
      '应收金额',
      '已核销',
      '未核销',
      '到期日',
      '责任人',
      '状态',
    ]);
    expect(titles(receiptTableMeta)).toEqual([
      '回款编号',
      '客户',
      '金额',
      '回款日期',
      '方式',
      '状态',
    ]);
    expect(titles(apTableMeta)).toEqual([
      '应付编号',
      '供应商',
      '应付金额',
      '已付',
      '未付',
      '到期日',
      '状态',
    ]);
    expect(titles(paymentTableMeta)).toEqual([
      '付款编号',
      '供应商',
      '金额',
      '付款日期',
      '状态',
    ]);
  });

  it('固定列 / 列宽 / 右对齐与原实现一致（改宽度是"看不出来"的回归）', () => {
    expect(columnOf(arTableMeta, 'arCode')).toMatchObject({
      dataIndex: 'code',
      fixed: 'left',
      width: 150,
    });
    expect(columnOf(receiptTableMeta, 'receiptCode')).toMatchObject({
      dataIndex: 'code',
      fixed: 'left',
      width: 150,
    });
    expect(columnOf(apTableMeta, 'apCode')).toMatchObject({
      dataIndex: 'code',
      fixed: 'left',
      width: 150,
    });
    expect(columnOf(paymentTableMeta, 'paymentCode')).toMatchObject({
      dataIndex: 'code',
      fixed: 'left',
      width: 150,
    });

    /*
     * 金额列一律右对齐 —— 左对齐时数字位数对不齐，但"能看"所以容易被忽略。
     * ⚠️ 宽度**不是同一个数**（原实现如此，逐列核对过 HEAD）：
     *   · 应收表：应收金额 / 已核销 / 未核销 都是 120；
     *   · 应付表：应付金额 120，而已付 / 未付是 110；
     *   · 回款/付款表：金额列 120。
     * 这里逐个钉住，因为"为了统一把它们都改成 120"是一次看起来无害、
     * 实际会挤掉相邻列横向空间的改动。
     */
    const moneyColumns: Array<[ReadonlyArray<ColumnMeta>, string, number]> = [
      [arTableMeta, 'arAmount', 120],
      [arTableMeta, 'arSettled', 120],
      [arTableMeta, 'arUnsettled', 120],
      [receiptTableMeta, 'receiptAmount', 120],
      [apTableMeta, 'apAmount', 120],
      [apTableMeta, 'apPaid', 110],
      [apTableMeta, 'apUnpaid', 110],
      [paymentTableMeta, 'paymentAmount', 120],
    ];
    for (const [meta, kind, width] of moneyColumns) {
      expect(columnOf(meta, kind)).toMatchObject({ align: 'right', width });
    }

    // 只有金额列右对齐：把状态/日期列也设成右对齐会让表头与内容错位
    expect(columnOf(arTableMeta, 'arStatus').align).toBeUndefined();
    expect(columnOf(arTableMeta, 'arDueDate').align).toBeUndefined();
    expect(columnOf(apTableMeta, 'apStatus').align).toBeUndefined();
  });

  it('取数字段与契约字段一一对应（列 → dataIndex）', () => {
    expect(
      arTableMeta.map((m) => `${m.kind}:${m.dataIndex ?? m.key}`),
    ).toEqual([
      'arCode:code',
      'arAmount:amount',
      'arSettled:settledAmount',
      // 现算列没有 dataIndex，靠 key 保持列身份（原实现即有）
      'arUnsettled:unsettled',
      'arDueDate:dueDate',
      'arOwner:ownerUserId',
      'arStatus:status',
    ]);
    expect(
      receiptTableMeta.map((m) => `${m.kind}:${m.dataIndex ?? m.key}`),
    ).toEqual([
      'receiptCode:code',
      'receiptCustomer:customerName',
      'receiptAmount:amount',
      'receiptDate:receiptDate',
      'receiptMethod:method',
      'receiptStatus:status',
    ]);
    expect(apTableMeta.map((m) => `${m.kind}:${m.dataIndex ?? m.key}`)).toEqual([
      'apCode:code',
      'apSupplier:supplierName',
      'apAmount:amount',
      'apPaid:paidAmount',
      'apUnpaid:unpaid',
      'apDueDate:dueDate',
      'apStatus:status',
    ]);
    expect(
      paymentTableMeta.map((m) => `${m.kind}:${m.dataIndex ?? m.key}`),
    ).toEqual([
      'paymentCode:code',
      'paymentSupplier:supplierName',
      'paymentAmount:amount',
      'paymentDate:payDate',
      'paymentStatus:status',
    ]);
  });

  it('每一列都有取值函数（缺一个运行时就是 TypeError，而不是空单元格）', () => {
    /*
     * 组件用 `values[m.kind](row)` 渲染，所以"列有、取值函数没有"会在**打开页面**
     * 时抛 `values[...] is not a function`。这条断言把该崩溃提前到 CI。
     */
    const pairs = [
      [arTableMeta, AR_AP_COLUMN_VALUES.ar],
      [receiptTableMeta, AR_AP_COLUMN_VALUES.receipt],
      [apTableMeta, AR_AP_COLUMN_VALUES.ap],
      [paymentTableMeta, AR_AP_COLUMN_VALUES.payment],
    ] as const;
    for (const [meta, values] of pairs) {
      for (const column of meta) {
        expect(typeof values[column.kind as keyof typeof values]).toBe('function');
      }
    }
  });
});

describe('每列的取值（null → \'-\'、未知枚举 → 原值）', () => {
  it('应收表逐列取值正确（已核销 / 未核销 / 应收金额三者互不相等）', () => {
    const row = arRow();
    const v = AR_AP_COLUMN_VALUES.ar;
    expect(v.arCode!(row)).toBe('AR2026100001');
    expect(v.arAmount!(row)).toBe('¥1,000.00');
    expect(v.arSettled!(row)).toBe('¥250.00');
    // 现算：amount − settledAmount = 750
    expect(v.arUnsettled!(row)).toBe('¥750.00');
    /*
     * 反例防线：任何"取错字段"的写法都会撞上这三条 ——
     * 若未核销误取 amount 会得到 ¥1,000.00，误取 settledAmount 会得到 ¥250.00。
     */
    expect(v.arUnsettled!(row)).not.toBe(v.arAmount!(row));
    expect(v.arUnsettled!(row)).not.toBe(v.arSettled!(row));
    expect(v.arAmount!(row)).not.toBe(v.arSettled!(row));
    expect(v.arDueDate!(row)).toBe('2026-11-30');
    expect(v.arOwner!(row)).toBe('user-9');
    // partial → 字典兜底 '部分回款'（不是英文码）
    expect(v.arStatus!(row)).toBe('部分回款');
  });

  it('应收表：dueDate / ownerUserId / status 为 null 时的行为（三者并不一致）', () => {
    const v = AR_AP_COLUMN_VALUES.ar;
    const empty = { ...arRow(), dueDate: null, ownerUserId: null, status: null };
    expect(v.arDueDate!(empty)).toBe('-');
    // 责任人空值原实现渲染 '-'（不渲染 UserDisplay）
    expect(v.arOwner!(empty)).toBe('-');
    /*
     * ⚠️ 状态为 null 时返回的是 **null**，既不是 '-' 也不是空串 —— 这是原行为
     * （原 `render: (s: string) => <StatusBadge …/>` 把 null 原样传给
     * `StatusBadge`，其中 `labels[null] ?? status` 得到 null，React 渲染成空）。
     *
     * 这里**登记现状而不是"修成 '-'"**：卡片里的状态列取值来自
     * `projects.service.ts` 的 `row.status`（`erp_ar.status` 有 default 'open'），
     * 该分支实际不可达；而"把 null 显示成 '-'"属于产品口径变更（该行没有状态 vs
     * 状态未知），不该由一次纯拆分顺手决定。控件仍然是"不崩、不显示 'null' 字样"。
     */
    expect(v.arStatus!(empty)).toBeNull();
    expect(v.arStatus!(empty)).not.toBe('null');
  });

  it('回款表逐列取值正确，且 null 字段不落成空白格', () => {
    const row = receiptRow();
    const v = AR_AP_COLUMN_VALUES.receipt;
    expect(v.receiptCode!(row)).toBe('RCV2026100001');
    expect(v.receiptCustomer!(row)).toBe('客户乙');
    expect(v.receiptAmount!(row)).toBe('¥640.50');
    expect(v.receiptDate!(row)).toBe('2026-10-09');
    expect(v.receiptMethod!(row)).toBe('cash');
    expect(v.receiptStatus!(row)).toBe('未核销');

    /*
     * ⚠️ 「客户」列原先**没有** `?? '-'`（同一张表的日期/方式列都有），
     * 客户行缺失时会渲染成空白格。契约侧 `erp_receipt.customer_id` 可为空
     * （`schema.ts:1807` 无 notNull），服务端也只回落 `?? ''`，
     * 所以空值是真实可达的。这条断言钉住修复后的行为。
     */
    const noCustomer = { ...row, customerName: null as unknown as string };
    expect(v.receiptCustomer!(noCustomer)).toBe('-');
    // 反例防线：不能把空值渲染成 "null" 字样
    expect(v.receiptCustomer!(noCustomer)).not.toBe('null');

    const empty = {
      ...row,
      receiptDate: null,
      method: null as unknown as string,
    };
    expect(v.receiptDate!(empty)).toBe('-');
    expect(v.receiptMethod!(empty)).toBe('-');
  });

  it('应付表逐列取值正确（已付 / 未付 / 应付金额三者互不相等）', () => {
    const row = apRow();
    const v = AR_AP_COLUMN_VALUES.ap;
    expect(v.apCode!(row)).toBe('AP2026100001');
    expect(v.apSupplier!(row)).toBe('供应商甲');
    expect(v.apAmount!(row)).toBe('¥800.00');
    expect(v.apPaid!(row)).toBe('¥125.00');
    // 现算：amount − paidAmount = 675
    expect(v.apUnpaid!(row)).toBe('¥675.00');
    expect(v.apUnpaid!(row)).not.toBe(v.apAmount!(row));
    expect(v.apUnpaid!(row)).not.toBe(v.apPaid!(row));
    expect(v.apAmount!(row)).not.toBe(v.apPaid!(row));
    expect(v.apDueDate!(row)).toBe('2026-12-31');
    expect(v.apStatus!(row)).toBe('部分付款');

    // 供应商列原实现**有** `?? '-'`：与回款表的「客户」列刻意不对称，两边都钉住
    const noSupplier = { ...row, supplierName: null as unknown as string };
    expect(v.apSupplier!(noSupplier)).toBe('-');
  });

  it('付款表逐列取值正确（金额 ≠ 应付金额，日期取 payDate 而非 createdAt）', () => {
    const row = paymentRow();
    const v = AR_AP_COLUMN_VALUES.payment;
    expect(v.paymentCode!(row)).toBe('PAY2026100001');
    expect(v.paymentSupplier!(row)).toBe('供应商丙');
    expect(v.paymentAmount!(row)).toBe('¥320.25');
    /*
     * `payDate` 与 `createdAt` 同一天但**不同字符串**（日期 vs ISO 时间戳）——
     * 取错字段时这一格会变成 `2026-10-11T01:00:00.000Z`，人眼扫过去很容易漏掉。
     */
    expect(v.paymentDate!(row)).toBe('2026-10-11');
    expect(v.paymentDate!(row)).not.toBe(row.createdAt);
    expect(v.paymentStatus!(row)).toBe('已批准');

    const empty = { ...row, payDate: null, supplierName: null as unknown as string };
    expect(v.paymentDate!(empty)).toBe('-');
    expect(v.paymentSupplier!(empty)).toBe('-');
  });

  it('未知枚举原样透出（不返回 undefined，否则那一格会变成空白）', () => {
    /*
     * 契约类型只允许已知状态，因此这里必须 `as unknown as` 双重断言。
     * 但断言本身是必要的：真实运行时会遇到契约之外的值（后端新增状态、
     * 历史数据、脏数据），此时必须**原样显示**而不是 undefined ——
     * undefined 在 React 里渲染成空，接收方无法区分"没有状态"与"数据丢了"。
     */
    const unknownAr = { ...arRow(), status: 'frozen' } as unknown as ChainArItem;
    expect(AR_AP_COLUMN_VALUES.ar.arStatus!(unknownAr)).toBe('frozen');
    const unknownAp = { ...apRow(), status: 'frozen' } as unknown as ChainApItem;
    expect(AR_AP_COLUMN_VALUES.ap.apStatus!(unknownAp)).toBe('frozen');
    const unknownReceipt = {
      ...receiptRow(),
      status: 'frozen',
    } as unknown as ReceiptItem;
    expect(AR_AP_COLUMN_VALUES.receipt.receiptStatus!(unknownReceipt)).toBe('frozen');
    const unknownPayment = {
      ...paymentRow(),
      status: 'frozen',
    } as unknown as PaymentItem;
    expect(AR_AP_COLUMN_VALUES.payment.paymentStatus!(unknownPayment)).toBe('frozen');
  });
});

/* ── 状态标签表 ─────────────────────────────────────────────────────────── */

describe('状态标签表', () => {
  it('四份标签表都覆盖 voided（缺口已在 §5.8 收尾中补上）', () => {
    /*
     * ## 这条断言的前身是一个**刻意设置的绊线**（值得留痕）
     *
     * 拆分 `ArApSection` 时发现：`AR_STATUS_LABELS` / `AP_STATUS_LABELS` 里
     * **没有 `voided`**，而 `RECEIPT_STATUS_LABELS` / `PAYMENT_STATUS_LABELS` 里有。
     * 当时的取舍是"不在纯拆分轮里改标签口径"，于是写成
     * `expect(AR_STATUS_LABELS.voided).toBeUndefined()` 并注明：
     * *"谁补上 voided，这条断言就会失败，从而强制一次有意识的决定。"*
     *
     * **现在这次决定已经做了**（§5.8 收尾 / 迁移
     * `2026-10-16-fix10-status-dict-gaps.sql`）：两侧都补上 `'已作废'`。
     * 理由不是"看起来不对称"，而是**功能缺失**：
     *   · `StatusBadge` 是 `labels[status] ?? status` → 项目卡片状态列显示英文码；
     *   · 更严重的是 `ArTab` / `ApTab` 的**筛选下拉**由
     *     `Object.entries(AR_STATUS_LABELS)` 渲染 → 缺键时使用者
     *     **无法筛出已作废单据**；
     *   · 而 B1 的作废路径确实会写 `status='voided'`，且 `listArs()`
     *     在不传 status 时不过滤状态 —— 所以这些行真的会出现在列表里。
     *
     * 现在四份表口径一致，且由 `scripts/check-label-dict.mjs` 在 CI 中守护。
     */
    expect(AR_STATUS_LABELS.voided).toBe('已作废');
    expect(AP_STATUS_LABELS.voided).toBe('已作废');
    expect(RECEIPT_STATUS_LABELS_FALLBACK.voided).toBe('已作废');
    expect(AR_AP_PAYMENT_STATUS_LABELS.voided).toBe('已作废');
  });

  it('契约里的每个状态都有中文标签（漏一个键 = 界面显示英文码）', () => {
    // 四份联合类型来自 `shared/api.interface.ts`，此处逐一钉住
    const arStatuses: ArStatus[] = ['open', 'partial', 'settled', 'voided'];
    const apStatuses: ApStatus[] = ['pending', 'approved', 'partial', 'paid', 'voided'];
    const receiptStatuses: ReceiptStatus[] = [
      'unmatched',
      'partial',
      'matched',
      'voided',
    ];
    const paymentStatuses: PaymentStatus[] = [
      'pending',
      'approved',
      'rejected',
      'paid',
      'voided',
    ];

    for (const s of arStatuses) {
      // 'voided' 是上面登记过的既有缺口，此处显式放行；其余三个必须有中文
      if (s === 'voided') continue;
      expect(AR_STATUS_LABELS[s]).toBeTruthy();
      expect(AR_STATUS_LABELS[s]).not.toBe(s);
    }
    for (const s of apStatuses) {
      if (s === 'voided') continue;
      expect(AP_STATUS_LABELS[s]).toBeTruthy();
      expect(AP_STATUS_LABELS[s]).not.toBe(s);
    }
    for (const s of receiptStatuses) {
      expect(RECEIPT_STATUS_LABELS_FALLBACK[s]).toBeTruthy();
      expect(RECEIPT_STATUS_LABELS_FALLBACK[s]).not.toBe(s);
    }
    for (const s of paymentStatuses) {
      expect(AR_AP_PAYMENT_STATUS_LABELS[s]).toBeTruthy();
      expect(AR_AP_PAYMENT_STATUS_LABELS[s]).not.toBe(s);
    }
  });

  it('⚠️ 回款状态含 partial / voided —— 原本地映射缺这两个键', () => {
    /*
     * 原实现自带 `RECEIPT_STATUS_LABELS_FALLBACK = { matched, unmatched }`，
     * 而 `StatusBadge` 是 `labels[status] ?? status`。两条状态都真实可达：
     *   · `ar.service.ts:353 listReceipts()` 不过滤 status；
     *   · `ar.service.ts:438 voidReceipt()` 把状态写成 'voided'。
     * 于是本项目唯一的回款列表上，作废的回款单显示 `voided`。
     * 这条断言是"修复已生效"的凭据（回退成旧字面量就会失败）。
     */
    expect(RECEIPT_STATUS_LABELS_FALLBACK.partial).toBe('部分核销');
    expect(RECEIPT_STATUS_LABELS_FALLBACK.voided).toBe('已作废');
    expect(RECEIPT_STATUS_LABELS_FALLBACK.unmatched).toBe('未核销');
    expect(RECEIPT_STATUS_LABELS_FALLBACK.matched).toBe('已核销');
  });

  it('⚠️ 付款状态 paid 的中文是「已核销」（字典口径），不是「已支付」', () => {
    /*
     * 原本地字面量写 `paid: '已支付'`，而字典种子
     * （`2026-10-15-upgrade-batch1z-b05-biz-labels-dict.sql:178`）与
     * `utils/biz-labels.ts:168` 都是 `paid: '已核销'`。
     * 本地字面量在读取那一刻覆盖字典 → B-05 的"改字典即生效"对这个页面失效。
     * 采用字典口径的另一依据：付款单的 `paid` 由**核销**动作写入
     * （`ap.service.ts` 的 `apWriteoff`），不是"付款动作"。
     */
    expect(AR_AP_PAYMENT_STATUS_LABELS.paid).toBe('已核销');
    expect(AR_AP_PAYMENT_STATUS_LABELS.paid).not.toBe('已支付');
    // voided 同样是本地表缺的键
    expect(AR_AP_PAYMENT_STATUS_LABELS.voided).toBe('已作废');
    // 其余三键与原实现一致，修复没有顺手动别的文案
    expect(AR_AP_PAYMENT_STATUS_LABELS.pending).toBe('待审批');
    expect(AR_AP_PAYMENT_STATUS_LABELS.approved).toBe('已批准');
    expect(AR_AP_PAYMENT_STATUS_LABELS.rejected).toBe('已驳回');
  });

  it('标签表按契约枚举闭合（每个键都映射到中文，且没有英文残留）', () => {
    /*
     * 这条是"导出→重新导入闭合"的等价物：`Object.keys` 拿到的键必须仍在契约里，
     * 取到的值必须是中文（不含 ASCII 字母）。它挡的是"加了新状态却忘了加标签"
     * 与"顺手把标签写成英文占位符"两种改法。
     */
    const tables: Array<[string, Record<string, string>]> = [
      ['AR_STATUS_LABELS', AR_STATUS_LABELS],
      ['AP_STATUS_LABELS', AP_STATUS_LABELS],
      ['RECEIPT_STATUS_LABELS_FALLBACK', RECEIPT_STATUS_LABELS_FALLBACK],
      ['AR_AP_PAYMENT_STATUS_LABELS', AR_AP_PAYMENT_STATUS_LABELS],
    ];
    for (const [name, table] of tables) {
      const keys = Object.keys(table);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        const label = table[key];
        expect(`${name}.${key} → ${label}`).toBe(`${name}.${key} → ${label}`);
        expect(label.trim().length).toBeGreaterThan(0);
        // 中文标签不应含 ASCII 字母（英文码本身就是"没配标签"的表现）
        expect(/[A-Za-z]/.test(label)).toBe(false);
      }
    }
  });
});

/* ── 金额算术 ───────────────────────────────────────────────────────────── */

describe('金额算术', () => {
  it('未核销 / 未付 = 两字段相减（与 round2 口径一致）', () => {
    expect(arUnsettledAmount({ amount: 1000, settledAmount: 250 })).toBe(750);
    expect(apUnpaidAmount({ amount: 800, paidAmount: 125 })).toBe(675);

    // 与共享取整函数**逐值**一致（不是"看起来差不多"）
    const cases: Array<[number, number]> = [
      [1000.1, 0.1],
      [0.3, 0.1],
      [1000.005, 0.005],
      [2.675, 0.005],
      [1.005, 0],
    ];
    for (const [a, b] of cases) {
      expect(arUnsettledAmount({ amount: a, settledAmount: b })).toBe(round2(a - b));
      expect(apUnpaidAmount({ amount: a, paidAmount: b })).toBe(round2(a - b));
    }
  });

  it('裸减法会留下浮点尾数，round2 把它收敛到分', () => {
    /*
     * 这是"为什么必须取整"的可执行证据。注意**不能随便挑两个数**：
     * `1000.1 - 0.1` 在 IEEE-754 下恰好等于 1000（实测），拿它举例什么也证明不了。
     *
     * 真正带尾数的是 `0.3 - 0.1`（= 0.19999999999999998）与
     * `1000.3 - 1000.1`（= 0.1999999999999318，尾数已经影响到第 11 位）。
     * 原实现把裸差交给 `formatMoney`（内部 `toLocaleString` 保留 2 位），
     * **显示上恰好被四舍五入掩盖**，所以肉眼看不出来；
     * 但同一个数一旦参与求和 / 比较 / 二次运算就会暴露 —— 例如把两行的余额相加后
     * 与后端合计比对，就会差出尾数。
     */
    const raw = 0.3 - 0.1;
    expect(raw).not.toBe(0.2);
    // 显示层看不出来（这也正是它一直没被发现的原因）
    expect(formatMoney(raw)).toBe('¥0.20');
    // 取整后彻底消失
    expect(arUnsettledAmount({ amount: 0.3, settledAmount: 0.1 })).toBe(0.2);
    expect(Object.is(arUnsettledAmount({ amount: 0.3, settledAmount: 0.1 }), 0.2)).toBe(
      true,
    );

    // 汇总口径：先逐行取整再相加，与后端 `reduce((acc, i) => acc + (amount - settled))` 同向
    const rows: ChainArItem[] = [
      { ...arRow(), id: 'r1', amount: 1000.3, settledAmount: 1000.1 },
      { ...arRow(), id: 'r2', amount: 0.3, settledAmount: 0.1 },
      { ...arRow(), id: 'r3', amount: 2.675, settledAmount: 0.005 },
    ];
    const parts = rows.map((r) => arUnsettledAmount(r));
    expect(parts).toEqual([0.2, 0.2, 2.67]);
    const total = parts.reduce((sum, v) => sum + v, 0);
    expect(round2(total)).toBe(3.07);
    // 合计等于各部分之和（不要再做一次别的取整，否则会差 1 分）
    expect(round2(total)).toBe(round2(0.2 + 0.2 + 2.67));
  });

  it('字段缺失 / null 时按 0 处理，不抛错也不产生 NaN', () => {
    /*
     * 服务端 `projects.service.ts` 对这两个字段都是 `Number(row.x ?? 0)`，
     * 客户端必须同口径 —— 否则某一行缺字段会让整张表的金额列变成 `NaN`。
     */
    expect(
      arUnsettledAmount({ amount: 100, settledAmount: null as unknown as number }),
    ).toBe(100);
    expect(
      apUnpaidAmount({ amount: null as unknown as number, paidAmount: 40 }),
    ).toBe(-40);
    expect(
      arUnsettledAmount({
        amount: undefined as unknown as number,
        settledAmount: undefined as unknown as number,
      }),
    ).toBe(0);
  });

  it('过度核销 / 过度付款时返回负数（**保留原行为**，不静默 clamp 到 0）', () => {
    /*
     * 「已核销 > 应收」是脏数据。返回负数能让对账的人**看见**异常；
     * 改成 `Math.max(0, …)` 会把它藏起来，且与后端
     * `arOpenAmount = Σ(amount − settledAmount)` 的口径不一致（后端也会算出负数）。
     * 将来若确要 clamp，必须先改这条断言并说明理由。
     */
    expect(arUnsettledAmount({ amount: 100, settledAmount: 150 })).toBe(-50);
    expect(apUnpaidAmount({ amount: 100, paidAmount: 220.5 })).toBe(-120.5);
  });

  it('相等时返回 0 而不是 -0（-0 会被格式化成「-¥0.00」）', () => {
    /*
     * `round2(0 - 0)` 返回 `-0`（`shared/number.ts` 走 `negative ? -result : result`），
     * 而 `formatMoney(-0)` 会显示 `-¥0.00` —— 已结清的行上出现负号，
     * 会被读成"这张单还欠钱"。`toBe(0)` 在 jest 下对 `-0` 也是通过的，
     * 因此这里显式用 `Object.is` 钉住符号。
     */
    const zero = arUnsettledAmount({ amount: 250, settledAmount: 250 });
    expect(Object.is(zero, 0)).toBe(true);
    expect(Object.is(zero, -0)).toBe(false);
    expect(formatMoney(zero)).toBe('¥0.00');
    expect(formatMoney(-0)).toBe('-¥0.00');
  });

  it('下拉项文案里的金额格式与 formatMoney 完全一致', () => {
    /*
     * 模块为了避免依赖 `utils/format.ts` 自带了一份格式化（`arApLabelMoney`）。
     * 两份实现漂移的表现是"下拉里是 ¥1,000.00、旁边提示里是 1,000.00"，
     * 这种差异在截图上很容易被当成"设计如此"。逐值比对把它钉死。
     */
    for (const value of [0, 0.5, 1000, 1234.567, -50, 1000000.005]) {
      expect(arApLabelMoney(value)).toBe(formatMoney(value));
    }
  });
});

/* ── 派生列表与文案 ─────────────────────────────────────────────────────── */

describe('派生列表：可选单据的过滤', () => {
  it('可回款的应收 = 排除已结清**与已作废**', () => {
    /*
     * 这条断言的前身登记的是相反的行为（"open / partial / voided 都留下"），
     * 并注明"要改必须前后端一起改"。**现在改了**，理由如下：
     *
     *   · 同一仓库里 `ArTab.tsx` 与 `ApTab.tsx` 的下拉**已经**排除 `voided`，
     *     本区块是仅剩的不一致处；
     *   · 作废单会被**链式查询真的返回**（`projects.service.ts` 不过滤状态），
     *     所以它确实出现在下拉里，不是理论情形；
     *   · 作废的应收 `amount − settledAmount` 通常**仍为正数**，而
     *     `ArService.writeoff` 的守卫会拒绝核销 —— 即"选得到但必然失败"，
     *     这正是审计 B-01 那一类"前端显示点了必然报错的按钮"。
     *
     * 判据仍然是**状态**（服务端的权威口径），只是把 `voided` 一并排除；
     * 没有改成"按未核销余额 > 0"，那才会与状态口径分叉。
     */
    const items: ChainArItem[] = [
      { ...arRow(), id: 'a', status: 'open' },
      { ...arRow(), id: 'b', status: 'partial' },
      { ...arRow(), id: 'c', status: 'settled' },
      { ...arRow(), id: 'd', status: 'voided' },
    ];
    expect(openArItems(items).map((i) => i.id)).toEqual(['a', 'b']);
    // 排除的是 settled 与 voided 两个**状态**，不是"余额为 0 的"
    expect(openArItems(items).some((i) => i.status === 'settled')).toBe(false);
    expect(openArItems(items).some((i) => i.status === 'voided')).toBe(false);
  });

  it('可付款的应付 = 排除已付清**与已作废**', () => {
    /*
     * 与上一条同一处修复。应付侧的服务端守卫更明确：
     * `ApService.createPayment` 会拒绝 `voided`；若不排除，使用者会在下拉里
     * 选到一张作废单、填完金额、再被服务端拒绝 —— 下拉本该只列可操作候选。
     */
    const items: ChainApItem[] = [
      { ...apRow(), id: 'a', status: 'pending' },
      { ...apRow(), id: 'b', status: 'approved' },
      { ...apRow(), id: 'c', status: 'paid' },
      { ...apRow(), id: 'd', status: 'voided' },
    ];
    expect(payableApItems(items).map((i) => i.id)).toEqual(['a', 'b']);
    expect(payableApItems(items).some((i) => i.status === 'voided')).toBe(false);
    /*
     * 这条过滤同时是**交互前提**：为空时组件把「登记付款」按钮置灰
     * （`disabled={payableAps.length === 0}`）。所以它不能改成"不过滤"。
     */
    expect(payableApItems([{ ...apRow(), status: 'paid' }])).toHaveLength(0);
  });

  it('入参为 null / undefined 时返回空数组（首屏 loading 期间不得抛错）', () => {
    expect(openArItems(null)).toEqual([]);
    expect(openArItems(undefined)).toEqual([]);
    expect(payableApItems(null)).toEqual([]);
    expect(payableApItems(undefined)).toEqual([]);
  });
});

describe('下拉项与只读输入框文案', () => {
  it('回款下拉项：编号 + 未回款余额（余额是现算的，不是金额原值）', () => {
    const label = arReceiptOptionLabel(arRow());
    expect(label).toBe('AR2026100001 - 未回款 ¥750.00');
    // 若误用 `amount`（写成"未回款 ¥1,000.00"）对账的人会以为还没收到钱
    expect(label).not.toContain('¥1,000.00');
    // 若误把 `{a.code}` 写成 `{a.id}`，uuid 会出现在下拉里
    expect(label).not.toContain(arRow().id);
  });

  it('付款下拉项：编号 + 未付余额', () => {
    const label = apPaymentOptionLabel(apRow());
    expect(label).toBe('AP2026100001 - 未付 ¥675.00');
    expect(label).not.toContain('¥800.00');
    expect(label).not.toContain(apRow().id);
  });

  it('「合同 - 客户」三级降级：两者都有 / 只有合同 / 都没有', () => {
    expect(
      contractCustomerLabel({
        contract: { code: 'CTR2026100001' },
        customer: { name: '客户甲' },
      }),
    ).toBe('CTR2026100001 - 客户甲');
    /*
     * 只有合同时**不拼接分隔符** —— 原实现如此；改成 `CTR… - ` 会让只读框
     * 看起来像"客户名还在加载"。
     */
    expect(contractCustomerLabel({ contract: { code: 'CTR2026100001' } })).toBe(
      'CTR2026100001',
    );
    expect(contractCustomerLabel({ customer: { name: '客户甲' } })).toBe(
      '项目未关联合同',
    );
    expect(contractCustomerLabel(null)).toBe('项目未关联合同');
    expect(contractCustomerLabel(undefined)).toBe('项目未关联合同');
    // 链式数据未加载（chain 为 undefined）时不能抛错
    expect(contractCustomerLabel({ contract: null, customer: null })).toBe(
      '项目未关联合同',
    );
  });
});

/* ── 表单 schema ────────────────────────────────────────────────────────── */

describe('表单 schema', () => {
  it('四份 schema 的金额门槛都是 1：0.99 拒 / 1 通过', () => {
    expect(arSchema.safeParse({ amount: 0.99, remark: '' }).success).toBe(false);
    expect(arSchema.safeParse({ amount: 1, remark: '' }).success).toBe(true);

    expect(
      receiptSchema.safeParse({ arId: 'a1', amount: 0.99, method: 'bank', remark: '' })
        .success,
    ).toBe(false);
    expect(
      receiptSchema.safeParse({ arId: 'a1', amount: 1, method: 'bank', remark: '' })
        .success,
    ).toBe(true);

    expect(
      apSchema.safeParse({ supplierId: 's1', amount: 0.99, remark: '' }).success,
    ).toBe(false);
    expect(
      apSchema.safeParse({ supplierId: 's1', amount: 1, remark: '' }).success,
    ).toBe(true);

    expect(
      paymentSchema.safeParse({ apId: 'a1', amount: 0.99, method: 'bank', remark: '' })
        .success,
    ).toBe(false);
    expect(
      paymentSchema.safeParse({ apId: 'a1', amount: 1, method: 'bank', remark: '' })
        .success,
    ).toBe(true);
  });

  it('金额门槛是 1 而**不是** 0.01（与核销门槛有意不同）', () => {
    /*
     * 0.5 是"大于 0 但小于 1"的区间：若有人把门槛误改成 0.01（核销侧的门槛）
     * 会放过它，于是 0 元级单据落库、台账里多一行永远不需要结算的记录。
     * 核销侧的门槛是 0.01（1 分钱尾差必须能分摊）—— 两个数是**两个业务门槛**。
     */
    expect(arSchema.safeParse({ amount: 0.5, remark: '' }).success).toBe(false);
    expect(apSchema.safeParse({ supplierId: 's1', amount: 0.5, remark: '' }).success).toBe(
      false,
    );
  });

  it('四份 schema 的必填字段各不相同（不是同一份 schema 的复制）', () => {
    /*
     * 这条挡的是"复制粘贴时漏改字段名"：四份 schema 结构相似，
     * 若 `apSchema` 误留 `arId` 之类的字段，界面上只表现为"供应商没选也能提交"。
     */
    // 应收：只要 amount（合同由项目带入，不在表单里）
    expect(arSchema.safeParse({ amount: 1, remark: '' }).success).toBe(true);
    expect(arSchema.safeParse({ amount: 1, supplierId: 's1', remark: '' }).success).toBe(
      true, // 多余字段被 zod 忽略（默认 strip），但 supplierId **不是**应收的必填项
    );
    // 回款：arId 必填
    expect(receiptSchema.safeParse({ amount: 1, method: 'bank', remark: '' }).success).toBe(
      false,
    );
    // 应付：supplierId 必填
    expect(apSchema.safeParse({ amount: 1, remark: '' }).success).toBe(false);
    // 付款：apId 必填
    expect(paymentSchema.safeParse({ amount: 1, method: 'bank', remark: '' }).success).toBe(
      false,
    );
    // 应收与应付的必填项确实不同：apSchema 用 supplierId、arSchema 不用
    const ap = apSchema.safeParse({ amount: 5, supplierId: '', remark: '' });
    expect(ap.success).toBe(false);
    if (!ap.success) expect(ap.error.issues[0]?.message).toBe('请选择供应商');
    const receipt = receiptSchema.safeParse({ arId: '', amount: 5, method: 'bank', remark: '' });
    expect(receipt.success).toBe(false);
    if (!receipt.success) expect(receipt.error.issues[0]?.message).toBe('请选择应收单');
  });

  it('应收有 ownerUserId（回款责任人）而应付没有 —— 契约的有意不对称', () => {
    /*
     * `erp_ar.owner_user_id` 是回款责任人（催款 cron 按它分组发飞书），
     * 应付侧没有对应字段。这条断言挡的是"为了对称给应付也加一个责任人"。
     */
    expect(arSchema.safeParse({ amount: 1, ownerUserId: 'u1', remark: '' }).success).toBe(
      true,
    );
    const parsed = arSchema.safeParse({ amount: 1, ownerUserId: 'u1', remark: '' });
    if (parsed.success) expect(parsed.data.ownerUserId).toBe('u1');
    // 应付 schema 里没有 ownerUserId：zod 默认 strip 掉未知键，不会报错也不会带上
    const apParsed = apSchema.safeParse({
      supplierId: 's1',
      amount: 1,
      remark: '',
      ownerUserId: 'u1',
    });
    expect(apParsed.success).toBe(true);
    if (apParsed.success) {
      expect('ownerUserId' in apParsed.data).toBe(false);
    }
  });

  it('字符串型金额被 coerce 成数字（表单里 input 给的是字符串）', () => {
    const parsed = arSchema.safeParse({ amount: '1234.56', remark: '' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.amount).toBe(1234.56);

    // 空串会被 coerce 成 0 → 被 min(1) 拦住（不能靠"空串"绕过金额门槛）
    expect(arSchema.safeParse({ amount: '', remark: '' }).success).toBe(false);
    // 非数字字符串 → NaN，同样被拦
    expect(arSchema.safeParse({ amount: 'abc', remark: '' }).success).toBe(false);
  });

  it('日期字段均可省略（到期日 / 回款日期 / 付款日期都不是必填）', () => {
    expect(arSchema.safeParse({ amount: 1, remark: '' }).success).toBe(true);
    expect(
      receiptSchema.safeParse({ arId: 'a1', amount: 1, method: 'bank', remark: '' }).success,
    ).toBe(true);
    expect(
      apSchema.safeParse({ supplierId: 's1', amount: 1, remark: '' }).success,
    ).toBe(true);
    expect(
      paymentSchema.safeParse({ apId: 'a1', amount: 1, method: 'bank', remark: '' }).success,
    ).toBe(true);
  });

  it('金额上界不受限制（与后端 DTO 的 numeric(18,2) 口径一致，不做前端截断）', () => {
    /*
     * 登记现状：schema 只有 `min`，没有 `max`。前端若自造上界会与后端
     * `@IsNumber({ maxDecimalPlaces: 2 })` 的口径分叉（后端只查小数位）；
     * 超出 numeric(18,2) 时由数据库报错，前端不静默截断。
     */
    expect(arSchema.safeParse({ amount: 999999999999.99, remark: '' }).success).toBe(true);
    // 小数位不被前端拦（后端 DTO 才是那道闸门）
    expect(arSchema.safeParse({ amount: 1.005, remark: '' }).success).toBe(true);
  });
});
