/**
 * 项目详情页「应收 / 应付」区块的纯逻辑（§5.9 / F8）。
 *
 * ## 从 `ArApSection.tsx` 里搬出来的是什么
 *
 * 按拆分判据的第 1 条（**零耦合的纯函数先搬**）与第 2 条（**列定义单独成文件**），
 * 本模块只装三类**零 React 依赖**的声明：
 *   ① 四份 zod schema（应收 / 回款 / 应付 / 付款登记）与它们的 `z.output` 类型；
 *   ② 四张表的状态标签表；
 *   ③ 四张表的**列结构**（表头 / 取数字段 / 列宽 / 对齐 / 固定列）。
 *
 * 合计约 190 行，搬走前它们占满了 899 行组件文件的开头（打开文件先看到 60 行
 * 声明才看到组件），且**完全无法单测** —— 而这三类恰恰是"改错了界面上看不出来"
 * 的重灾区：
 *   · schema 是财务数据的入口闸门，改错一个 `min` 就放进脏数据；
 *   · 状态标签漏一个键，界面上那一个状态直接显示成英文码；
 *   · 列定义取错字段（例如「已核销」取 `amount`），表格照样渲染、数字照样显示，
 *     只是金额落在了错的列里 —— 不逐列断言就发现不了。
 *
 * ## ⚠️ 为什么只搬"列结构"，不搬 `TableColumnsType` 本身
 *
 * 四张表的列定义里各有一列 `render` 返回 JSX（状态用 `StatusBadge`、
 * 责任人用 `UserDisplay`）。**这些不能搬进本模块**，理由不是风格而是硬约束：
 *
 * `UserDisplay` → `business-ui/api/users/queries` → `business-ui/api/users/service`
 * → `platform/services.ts` → 文件末尾 `export { getAssetsUrl } from './env'`
 * → `platform/env.ts` 的 `import.meta.env.MODE`。
 *
 * 而 `jest.config.cjs` 对 `client/**\/*.ts` 用的是 `tsconfig.test.json`（`module: CommonJS`），
 * `import.meta` 在 CJS 下直接编译失败：
 *
 * ```
 * client/src/platform/env.ts:2:10 - error TS1343: The 'import.meta' meta-property
 * is only allowed when the '--module' option is 'es2020', …（实测复现）
 * ```
 *
 * 也就是说：**本模块一旦 import `UserDisplay`，它的 spec 就一行都跑不起来** ——
 * 而"能单测"正是这次拆分的全部收益。所以这里保留纯数据（本模块），
 * JSX 渲染留在组件里按 `kind` 挂载（见 `ArApSection.tsx` 的 `RENDERS`）。
 * 这样 spec 能逐列断言"哪一列取哪个字段"，而渲染细节仍由组件负责。
 *
 * 同理，那四列 `render` 里也没有任何**文字内容**：表头、中文标签全部在本模块，
 * 因此组件里剩下的 render 只是 `formatMoney` / 组件挂载，不含业务判断。
 *
 * ## 两处**有意不对称**（不要在"统一"时抹掉）
 *
 * | | 应收（AR） | 应付（AP） |
 * |---|---|---|
 * | 单据主体 | 项目 → 合同（`contractId`） | 供应商（`supplierId`） |
 * | 冗余字段名 | `settledAmount`（已**核销**） | `paidAmount`（已**付**） |
 * | 责任人列 | 有（`ownerUserId`，回款责任人） | 无 |
 *
 * 命名不同不是笔误：应收侧的钱是**回款核销**掉的（可能分多次、跨多张回款单），
 * 应付侧是**付款**掉的。`shared/api.interface.ts` 里 `ChainArItem` 与
 * `ChainApItem` 就是这么定义的，规格里各有用例钉住。
 */
import {
  AP_STATUS_LABELS,
  AR_STATUS_LABELS,
  PAYMENT_STATUS_LABELS,
  RECEIPT_STATUS_LABELS,
} from '@client/src/utils/biz-labels';
import { round2 } from '@shared/number';
import type {
  ChainApItem,
  ChainArItem,
  PaymentItem,
  ReceiptItem,
} from '@shared/api.interface';

/* §5.9 二次拆分：四份表单 schema 已移到 `./ar-ap-schemas`（入口闸门与展示/列结构分开） */
export {
  arSchema,
  apSchema,
  receiptSchema,
  paymentSchema,
} from './ar-ap-schemas';
export type {
  ArFormData,
  ArFormInput,
  ApFormData,
  ApFormInput,
  ReceiptFormData,
  ReceiptFormInput,
  PaymentFormData,
  PaymentFormInput,
} from './ar-ap-schemas';

/* ── 状态标签表 ──────────────────────────────────────────────────────────── */

/**
 * 回款状态标签（`ReceiptStatus = 'unmatched' | 'partial' | 'matched' | 'voided'`）。
 *
 * ## ⚠️ 本轮修复的真实缺陷：这里原先是一份**残缺的本地字面量**
 *
 * 原代码自带 `RECEIPT_STATUS_LABELS_FALLBACK = { matched, unmatched }`，
 * 而 `StatusBadge` 的兜底链是 `labels[status] ?? status` —— 字典表里没有的键
 * **原样显示英文码**。于是本项目唯一的回款列表（项目详情页）上：
 *   · `partial`（部分核销）显示 `partial`；
 *   · `voided`（已作废）显示 `voided`。
 *
 * 两条都真实可达（**不是"理论上"**）：
 *   ① `ar.service.ts:353 listReceipts()` **不带 status 过滤**，
 *      只按 customerId 过滤；`ReceiptStatus` 契约里 `voided` 与 `partial` 都是正式取值；
 *   ② `ar.service.ts:438 voidReceipt()` 明确把状态写成 `'voided'`
 *      （迁移 `2026-10-16-fix02-ar-ap-void-and-indexes.sql:24` 注明
 *      `erp_receipt.status` 是自由 varchar，与 `erp_ar` 同一策略）。
 *
 * 同一处缺陷在 `pages/finance/ArTab.tsx:68` / `ApTab.tsx:75` **已经修过**
 * （两处都留了注释说明"本地映射绕过了字典版"），本文件是当时漏掉的第三个点。
 * 因此这里不再是本地字面量，而是引用 `utils/biz-labels.ts` 的
 * `RECEIPT_STATUS_LABELS`（字典 `receipt_status` 为唯一权威，字面量仅兜底，
 * 字典一旦配置即生效 —— 即 B-05）。
 */
export const RECEIPT_STATUS_LABELS_FALLBACK: Record<string, string> =
  RECEIPT_STATUS_LABELS;

/**
 * 付款状态标签 —— 同上，改为引用字典版（`PAYMENT_STATUS_LABELS`）。
 *
 * ## ⚠️ 本轮修复的第二处缺陷：`paid` 的文案与原实现**不一致**
 *
 * 原本地表写 `paid: '已支付'`；字典种子
 * （`2026-10-15-upgrade-batch1z-b05-biz-labels-dict.sql:178`）与
 * `utils/biz-labels.ts:168` 都是 `paid: '已核销'`。
 * 也就是说：**业务方在「设置 → 字典」改了 `payment_status` 也不会生效**，
 * 因为本地字面量在读取那一刻就把它覆盖了（这正是 B-05 要消除的"两套数据源"）。
 *
 * 采用字典口径而不是本地口径，依据是业务流程而不是"字典优先"这一条形式规则：
 * 付款单的 `paid` 状态由**核销**动作写入（`ap.service.ts` 的 `apWriteoff`），
 * 不是由"付款动作"写入 —— 所以「已核销」描述的是实际发生的事。
 * 另外 `PaymentStatus` 含 `voided`，本地表同样缺这个键（同 `receipt_status`）。
 */
export const AR_AP_PAYMENT_STATUS_LABELS: Record<string, string> =
  PAYMENT_STATUS_LABELS;

/**
 * 应收 / 应付状态标签 —— 原实现已经是引用字典版，此处只是把引用集中到本模块，
 * 让"四张表分别用哪份标签"这件事可被单测断言（组件里改错一份标签不会报错）。
 *
 * 转出而不是 `export { … } from '…'`：这两份标签本模块内部也要用，
 * 而 `export … from` 不建立本地绑定。
 */
export { AR_STATUS_LABELS, AP_STATUS_LABELS };

/* ── 列结构（表头 / 取数字段 / 列宽 / 对齐 / 固定列） ───────────────────── */

/**
 * 列的稳定标识。组件用它把 JSX 渲染挂到列上（见 `ArApSection.tsx` 的 `RENDERS`），
 * 规格用它把"某一列"与"某个取值函数"对上 —— 避免用列下标硬编码，
 * 那样插一列就会让断言全部错位、且**看起来仍然通过**。
 */
export type ColumnKind =
  /* 应收表 */
  | 'arCode'
  | 'arAmount'
  | 'arSettled'
  | 'arUnsettled'
  | 'arDueDate'
  | 'arOwner'
  | 'arStatus'
  /* 回款表 */
  | 'receiptCode'
  | 'receiptCustomer'
  | 'receiptAmount'
  | 'receiptDate'
  | 'receiptMethod'
  | 'receiptStatus'
  /* 应付表 */
  | 'apCode'
  | 'apSupplier'
  | 'apAmount'
  | 'apPaid'
  | 'apUnpaid'
  | 'apDueDate'
  | 'apStatus'
  /* 付款表 */
  | 'paymentCode'
  | 'paymentSupplier'
  | 'paymentAmount'
  | 'paymentDate'
  | 'paymentStatus';

/**
 * 一列的**纯结构**：标题、取数字段、宽度、对齐、固定列。
 *
 * 刻意用 `dataIndex`（而不是在 render 里手写 `record.xxx`）表述取数来源：
 * `dataIndex` 是可以被规格**直接断言**的（`列 → 字段`），
 * 而 render 闭包里的字段名只能靠渲染后看输出，漏看一个就漏一个。
 */
export interface ColumnMeta {
  kind: ColumnKind;
  /** Excel / 表格列头（中文） */
  title: string;
  /** 取数字段；`undefined` 表示这一列是**现算**的（见 `key`） */
  dataIndex?: string;
  /** 现算列（无 `dataIndex`）的稳定 key，原实现即有，保持原样 */
  key?: string;
  width: number;
  align?: 'left' | 'right' | 'center';
  fixed?: 'left' | 'right';
}

/** 应收列表 */
export const arTableMeta: ReadonlyArray<ColumnMeta> = [
  { kind: 'arCode', title: '应收编号', dataIndex: 'code', fixed: 'left', width: 150 },
  { kind: 'arAmount', title: '应收金额', dataIndex: 'amount', width: 120, align: 'right' },
  { kind: 'arSettled', title: '已核销', dataIndex: 'settledAmount', width: 120, align: 'right' },
  /*
   * 「未核销」是**现算**列：`ChainArItem` 没有 `unsettledAmount` 字段
   * （服务端 `projects.service.ts:612` 的 `arOpenAmount` 也是同一算法现算的）。
   * `key: 'unsettled'` 是原实现就有的，改掉会丢掉列身份，故保留。
   */
  { kind: 'arUnsettled', title: '未核销', key: 'unsettled', width: 120, align: 'right' },
  { kind: 'arDueDate', title: '到期日', dataIndex: 'dueDate', width: 110 },
  { kind: 'arOwner', title: '责任人', dataIndex: 'ownerUserId', width: 110 },
  { kind: 'arStatus', title: '状态', dataIndex: 'status', width: 100 },
];

/** 回款列表 */
export const receiptTableMeta: ReadonlyArray<ColumnMeta> = [
  { kind: 'receiptCode', title: '回款编号', dataIndex: 'code', fixed: 'left', width: 150 },
  { kind: 'receiptCustomer', title: '客户', dataIndex: 'customerName', width: 140 },
  { kind: 'receiptAmount', title: '金额', dataIndex: 'amount', width: 120, align: 'right' },
  { kind: 'receiptDate', title: '回款日期', dataIndex: 'receiptDate', width: 110 },
  { kind: 'receiptMethod', title: '方式', dataIndex: 'method', width: 90 },
  { kind: 'receiptStatus', title: '状态', dataIndex: 'status', width: 90 },
];

/** 应付列表 */
export const apTableMeta: ReadonlyArray<ColumnMeta> = [
  { kind: 'apCode', title: '应付编号', dataIndex: 'code', fixed: 'left', width: 150 },
  { kind: 'apSupplier', title: '供应商', dataIndex: 'supplierName', width: 150 },
  { kind: 'apAmount', title: '应付金额', dataIndex: 'amount', width: 120, align: 'right' },
  { kind: 'apPaid', title: '已付', dataIndex: 'paidAmount', width: 110, align: 'right' },
  // 现算列，理由同「未核销」：`ChainApItem` 无 unpaidAmount 字段
  { kind: 'apUnpaid', title: '未付', key: 'unpaid', width: 110, align: 'right' },
  { kind: 'apDueDate', title: '到期日', dataIndex: 'dueDate', width: 110 },
  { kind: 'apStatus', title: '状态', dataIndex: 'status', width: 100 },
];

/** 付款列表 */
export const paymentTableMeta: ReadonlyArray<ColumnMeta> = [
  { kind: 'paymentCode', title: '付款编号', dataIndex: 'code', fixed: 'left', width: 150 },
  { kind: 'paymentSupplier', title: '供应商', dataIndex: 'supplierName', width: 150 },
  { kind: 'paymentAmount', title: '金额', dataIndex: 'amount', width: 120, align: 'right' },
  { kind: 'paymentDate', title: '付款日期', dataIndex: 'payDate', width: 110 },
  { kind: 'paymentStatus', title: '状态', dataIndex: 'status', width: 90 },
];

/* ── 纯计算 ─────────────────────────────────────────────────────────────── */

/**
 * 应收未核销金额 = `amount − settledAmount`（**现算**，契约无该字段）。
 *
 * ## 为什么必须 `round2`
 *
 * 两个字段都是 `numeric(18,2)`，但服务端经 `Number(...)` 转成 JS 数字后再相减，
 * IEEE-754 会留下尾数：`Number('1000.10') - Number('0.10')` 这类组合可能得到
 * `999.9999999999999`。原实现把裸减法直接交给 `formatMoney`（内部 `toLocaleString`
 * 只保留 2 位小数），**显示上恰好被四舍五入掩盖**，所以一直没人发现；
 * 但同一个数在 `Math.max(a - b, 0)`、比较大小、或将来做求和时会暴露。
 *
 * 这里统一走 `@shared/number` 的 `round2` —— 它与服务端落库口径**同源**
 * （该模块文件头记录了红冲取整方向不对称的真实账务缺陷）。
 * 行为上的可见差异只有一处：`-0` 被规范成 `0`（`round2(0 - 0)` 返回 `-0`，
 * 而 `formatMoney(-0)` 会显示 `-¥0.00`）。
 *
 * 入参允许 `null | undefined`：历史上 `settledAmount` 缺失时按 0 处理
 * （服务端也是 `Number(row.settledAmount ?? 0)`），不能因为字段缺失整行崩掉。
 *
 * ⚠️ **不 clamp**：`settledAmount > amount`（脏数据 / 过度核销）时返回负数，
 * 让异常**显示出来**而不是被 `Math.max(0, …)` 藏起来。这是原行为。
 */
export function arUnsettledAmount(
  row: Pick<ChainArItem, 'amount' | 'settledAmount'>,
): number {
  return round2(Number(row.amount ?? 0) - Number(row.settledAmount ?? 0));
}

/** 应付未付金额 = `amount − paidAmount`，规则同 {@link arUnsettledAmount} */
export function apUnpaidAmount(
  row: Pick<ChainApItem, 'amount' | 'paidAmount'>,
): number {
  return round2(Number(row.amount ?? 0) - Number(row.paidAmount ?? 0));
}

/**
 * 回款登记里可选的应收单 = **未结清且未作废**的应收。
 *
 * ## 为什么必须同时排除 `voided`（本轮修复）
 *
 * 原实现只写 `status !== 'settled'`，于是**已作废**的应收单也进了下拉。
 * 这与同一仓库里已经修过的两处**不一致**：
 *   · `ArTab.tsx` 的 `openArItems` 排除 `'settled'` 与 `'voided'`；
 *   · `ApTab.tsx` 的 `unpaidAps` 排除 `'paid'` 与 `'voided'`。
 *
 * 三条理由说明这不是"风格统一"而是缺陷：
 *   ① 作废单在**链式查询里真的会被返回** —— `projects.service.ts` 的链式
 *      查询不过滤状态，所以作废行确实出现在下拉里（不是理论情形）；
 *   ② 作废的应收单 `amount − settledAmount` 通常**仍为正数**，所以"未核销"
 *      这个直觉判据拦不住它，下拉里也**不显示状态**，使用者无法分辨；
 *   ③ 即使服务端会拒绝，**让人先选到再报错**也是坏体验 ——
 *      下拉本该只列可操作的候选。
 *
 * 保留"用状态而不是用金额"这个判据（状态是服务端的权威口径），
 * 只是把 `voided` 一并纳入排除。
 */
export function openArItems(
  items: ReadonlyArray<ChainArItem> | null | undefined,
): ChainArItem[] {
  return (items ?? []).filter(
    (a: ChainArItem) => a.status !== 'settled' && a.status !== 'voided',
  );
}

/**
 * 付款登记里可选的应付单 = **未付清且未作废**的应付。
 *
 * 数量为 0 时组件把「登记付款」按钮置灰 —— 所以这个过滤同时是**交互前提**，
 * 不能改成"不过滤"。
 *
 * `voided` 的排除理由同 `openArItems`（本轮修复）：作废单会被链式查询返回、
 * 其 `amount − reserved` 通常仍为正数、下拉不显示状态。服务端
 * `ApService.createPayment` 已有守卫会拒绝，但下拉不该列出不可操作的候选。
 */
export function payableApItems(
  items: ReadonlyArray<ChainApItem> | null | undefined,
): ChainApItem[] {
  return (items ?? []).filter(
    (a: ChainApItem) => a.status !== 'paid' && a.status !== 'voided',
  );
}

/**
 * 「登记应收」弹窗顶部只读输入框的文案：`合同号 - 客户名`。
 *
 * 三级降级（原 JSX 里的嵌套三元，逐字搬出，含 `'项目未关联合同'` 兜底文案）：
 *   ① 合同 + 客户 → `CTR001 - 客户甲`
 *   ② 只有合同   → `CTR001`
 *   ③ 都没有     → `项目未关联合同`
 *
 * 注意第 ② 级**不拼接分隔符** —— 原实现如此，若改成 `CTR001 - ` 会让
 * 输入框看起来像加载中。
 */
export function contractCustomerLabel(
  chain:
    | {
        contract?: { code: string | null } | null;
        customer?: { name: string | null } | null;
      }
    | null
    | undefined,
): string {
  const contract = chain?.contract;
  const customer = chain?.customer;
  if (contract && customer) return `${contract.code} - ${customer.name}`;
  /*
   * `?? ''` 是对契约类型（`code: string`，但本函数为了可测而放宽成 `string | null`）
   * 的收窄，不是行为改动：`code` 为空时原实现会用模板串渲染出字面量 `"null"`，
   * 这里得到空串。真实数据里 `ChainContractSummary.code` 是 `notNull` 列，
   * 且该分支只在"有合同"时进入，所以这一级实际不可达。
   */
  if (contract) return contract.code ?? '';
  return '项目未关联合同';
}

/* ── 下拉项文案里的金额格式 ─────────────────────────────────────────────── */

/**
 * 登记回款 / 付款的下拉项文案用的金额格式（`¥1,234.50`）。
 *
 * 单独抽一层是为了让「下拉项文案 = 编号 + 现算余额」这条**可断言**，
 * 同时避免本模块 import `utils/format.ts` —— 那会让"本模块只依赖
 * zod / biz-labels / shared"这条依赖边界变模糊，而边界正是它能被单测的前提。
 * 实现与 `formatMoney` 一致（`zh-CN` + `CNY` + 固定 2 位小数），
 * 规格里有断言钉住两者输出相同，避免两处格式漂移。
 */
function formatMoneyForLabel(value: number): string {
  return Number(value ?? 0).toLocaleString('zh-CN', {
    style: 'currency',
    currency: 'CNY',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * 下拉项文案里的金额格式（导出名带前缀，避免与 `utils/format` 的 `formatMoney` 混淆）。
 *
 * 规格用它断言"界面文案里的金额格式"与 `formatMoney` 一致。
 */
export const arApLabelMoney = formatMoneyForLabel;

/**
 * 回款登记下拉项主文案：`{应收编号} - 未回款 {金额}`。
 *
 * 抽出来的目的是**让这段文字可被单测**：它是使用者决定"回款冲哪张单"的依据，
 * 而原实现里它是内联在 `<SelectItem>` 内的模板串 —— 一个 `{a.code}` 写成
 * `{a.id}` 的笔误在界面上完全看不出来（uuid 也照样显示成一串字符）。
 */
export function arReceiptOptionLabel(row: ChainArItem): string {
  return `${row.code} - 未回款 ${formatMoneyForLabel(arUnsettledAmount(row))}`;
}

/** 付款登记下拉项主文案：`{应付编号} - 未付 {金额}`，理由同上 */
export function apPaymentOptionLabel(row: ChainApItem): string {
  return `${row.code} - 未付 ${formatMoneyForLabel(apUnpaidAmount(row))}`;
}

/* ── 表格行的取数契约（列 → 字段） ─────────────────────────────────────── */

/**
 * 四张表的「列 kind → 该列的值」，**组件与规格读的是同一份**。
 *
 * 这是本次拆分里最值得单测的一块：表格列的取数错误**在界面上完全看不出来**
 * —— 表格照样渲染、数字照样显示、分页照样工作，只是金额落在了错的列里。
 * 例如「已核销」误取 `amount`：表格显示的和金额上限一模一样，对账的人会据此
 * 以为"款已全部核销"，而实际上什么都没收回来。
 *
 * ## 为什么写在这里而不是留在组件的 render 里
 *
 * 组件原先用 `dataIndex` + `render(_ , record)` 取数，本模块无法断言 `record.xxx`。
 * 现在组件改为**从这张表取数**（见 `ArApSection.tsx` 的 `buildColumns`），
 * 于是"哪一列取哪个字段"只有一处定义，规格可以直接喂行数据断言输出。
 *
 * 返回类型收窄到 `string`（不是 `unknown`）：四张表的每一列最终都渲染成**文本**
 * （金额走 `formatMoney`、状态走标签表），因此规格对每一列都能直接写
 * `expect(value(row)).toBe('…')`，不需要为每列单独转型。
 */
type ColumnValues<T> = { [K in ColumnKind]?: (row: T) => string };

export const AR_AP_COLUMN_VALUES: {
  ar: ColumnValues<ChainArItem>;
  receipt: ColumnValues<ReceiptItem>;
  ap: ColumnValues<ChainApItem>;
  payment: ColumnValues<PaymentItem>;
} = {
  ar: {
    arCode: (row) => row.code,
    arAmount: (row) => formatMoneyForLabel(row.amount),
    arSettled: (row) => formatMoneyForLabel(row.settledAmount),
    arUnsettled: (row) => formatMoneyForLabel(arUnsettledAmount(row)),
    // `dueDate` 契约上是 `string | null`：空值显示 '-' 而不是空白格
    arDueDate: (row) => row.dueDate ?? '-',
    // `ownerUserId` 为空时原实现渲染 '-'（不渲染 UserDisplay）
    arOwner: (row) => row.ownerUserId ?? '-',
    arStatus: (row) => AR_STATUS_LABELS[row.status ?? ''] ?? row.status,
  },
  receipt: {
    receiptCode: (row) => row.code,
    /*
     * ⚠️ 本轮修复的真实缺陷：原实现这一列写成 `{ title: '客户',
     * dataIndex: 'customerName', width: 140 }` —— **没有空值兜底**。
     *
     * 依据（不是猜测）：
     *   · 契约 `ReceiptItem.customerName: string`，但服务端
     *     `ar.service.ts:364` 明确回落 `row.customerName ?? ''`，
     *     且它是 `leftJoin(mdCustomer, …)` —— 客户行缺失时 join 出 NULL；
     *   · 更关键的是 `erp_receipt.customer_id` 本身**可为空**
     *     （`schema.ts:1807`，列无 `.notNull()`）。
     * 于是这一格会渲染成**空白**，而同一张表的「回款日期」「方式」都有 `?? '-'`、
     * 应付表的「供应商」也有 `?? '-'`。空白格与"客户真的没填"无法区分，
     * 而同行其它列显示 '-' —— 空值兜底在同一个文件里不一致。
     */
    receiptCustomer: (row) => row.customerName ?? '-',
    receiptAmount: (row) => formatMoneyForLabel(row.amount),
    receiptDate: (row) => row.receiptDate ?? '-',
    receiptMethod: (row) => row.method ?? '-',
    receiptStatus: (row) => RECEIPT_STATUS_LABELS_FALLBACK[row.status] ?? row.status,
  },
  ap: {
    apCode: (row) => row.code,
    apSupplier: (row) => row.supplierName ?? '-',
    apAmount: (row) => formatMoneyForLabel(row.amount),
    apPaid: (row) => formatMoneyForLabel(row.paidAmount),
    apUnpaid: (row) => formatMoneyForLabel(apUnpaidAmount(row)),
    apDueDate: (row) => row.dueDate ?? '-',
    apStatus: (row) => AP_STATUS_LABELS[row.status ?? ''] ?? row.status,
  },
  payment: {
    paymentCode: (row) => row.code,
    /*
     * ⚠️ 与「回款」表的「客户」列**刻意不对称**：这里原实现**有** `?? '-'`
     * （`render: (v) => v ?? '-'`）。同一次拆分里只补了缺的那个，
     * 没有顺手把已有的删掉 —— 规格里两条断言都在，改任何一边都会失败。
     */
    paymentSupplier: (row) => row.supplierName ?? '-',
    paymentAmount: (row) => formatMoneyForLabel(row.amount),
    paymentDate: (row) => row.payDate ?? '-',
    paymentStatus: (row) => AR_AP_PAYMENT_STATUS_LABELS[row.status] ?? row.status,
  },
};
