import type { BadgeProps } from '@client/src/components/ui/badge';
import { withDictionaryFallback } from '@client/src/utils/dict-labels';
import type { ReturnAction } from '@shared/api.interface';

/**
 * 业务状态标签（B-05：`sys_dict` 为唯一权威，此处的字面量是**兜底值**）。
 *
 * ## 这个文件现在是什么
 *
 * 每个常量都用 `withDictionaryFallback(dictType, {...})` 包了一层：
 * **读取时**先查字典，字典缺该项才用这里的字面量。因此：
 * - 调用点完全不用改（仍是 `LABELS[value]`），也不会有异步问题；
 * - 业务方在「设置 → 字典」改 `dict_label` 即生效，无需发版 —— 这正是 B-05 的目的；
 * - 字典尚未加载（首屏、网络失败）时界面显示不变，不会退化成英文 key。
 *
 * 兜底值必须与迁移 `2026-10-15-upgrade-batch1z-b05-biz-labels-dict.sql`
 * 种入的文案**保持一致**，否则"是否已加载字典"会表现为界面文案跳变。
 *
 * ## 为什么 `COST_TYPE_LABELS` 没有接管字典
 *
 * 既有 `cost_type` 字典（由 `batch1-system-config.sql` 种入）的键集与这里的常量
 * **不一致**：字典有 `outsourcing/purchase/software/data/other`，
 * 常量有 `outsource/compute/storage/tool/flex_labor`。
 * 强行接管会导致界面出现常量里没有的键，或反过来显示原始英文 key。
 * 这属于**既有数据不一致**，需业务确认统一口径后再接管 —— 此处如实保留，
 * 不用"看起来已统一"的方式掩盖。已知会产生的表现：
 * 成本类型下拉（取自字典）与成本列表标签（取自常量）在个别类型上文案不同。
 */

export const LEAD_STATUS_LABELS: Record<string, string> = withDictionaryFallback(
  'lead_status',
  {
    new: '新建',
    following: '跟进中',
    converted: '已转化',
    lost: '已流失',
  },
);

export const OPP_STAGE_LABELS: Record<string, string> = withDictionaryFallback(
  'opp_stage',
  {
    new: '新建',
    following: '跟进中',
    quoting: '方案报价',
    negotiating: '谈判',
    won: '赢单',
    lost: '输单',
  },
);

export const QUOTATION_STATUS_LABELS: Record<string, string> =
  withDictionaryFallback('quotation_status', {
    draft: '草稿',
    pending_approval: '待审批',
    approved: '已生效',
    converted: '已转合同',
    void: '已作废',
  });

export const VOUCHER_STATUS_LABELS: Record<string, string> =
  withDictionaryFallback('voucher_status', {
    draft: '草稿',
    posted: '已过账',
    voided: '已作废',
  });

export const AR_SOURCE_LABELS: Record<string, string> = withDictionaryFallback(
  'ar_source',
  {
    manual: '手工登记',
    revenue: '收入确认',
  },
);

export const CONTRACT_STATUS_LABELS: Record<string, string> =
  withDictionaryFallback('contract_status', {
    draft: '草稿',
    approving: '审批中',
    active: '已生效',
    performing: '履约中',
    completed: '已完成',
    closed: '已关闭',
    terminated: '已终止',
  });

export const PROJECT_STATUS_LABELS: Record<string, string> =
  withDictionaryFallback('project_status', {
    initiating: '立项中',
    executing: '执行中',
    delivering: '交付中',
    accepting: '验收中',
    closed: '已结项',
    // B6：新增终态。缺了这一行会让界面直接显示英文 key `cancelled`
    // —— 字典兜底链的最后一环是"返回原值"，所以不会空白，但那是英文。
    cancelled: '已取消',
  });

export const BILLING_MODEL_LABELS: Record<string, string> =
  withDictionaryFallback('billing_model', {
    project: '项目制',
    quantity: '按量计费',
    subscription: '订阅制',
    framework: '框架合同',
  });

/**
 * 成本类型标签 —— **未接管字典**，原因见文件头注释。
 * 保留为普通常量，避免出现"部分键来自字典、部分来自常量"的混合映射。
 */
export const COST_TYPE_LABELS: Record<string, string> = {
  labor: '人力成本',
  outsource: '外包成本',
  compute: '算力成本',
  storage: '存储成本',
  tool: '工具成本',
  travel: '差旅成本',
  flex_labor: '灵活用工',
};

export const TIMESHEET_STATUS_LABELS: Record<string, string> =
  withDictionaryFallback('timesheet_status', {
    draft: '草稿',
    submitted: '已提交',
    confirmed: '已确认',
  });

export const AR_STATUS_LABELS: Record<string, string> = withDictionaryFallback(
  'ar_status',
  {
    open: '待回款',
    partial: '部分回款',
    settled: '已结清',
    /*
     * §5.8 / B1 收尾：**必须补 `voided`**。
     *
     * `ArStatus` 契约含 `'voided'`，B1 加的作废路径会写这个值
     * （`ar.service.ts:442` `set({ status: 'voided' })`），而
     * `listArs()` 在不传 status 时**不过滤状态**，所以作废单会出现在列表里。
     * 缺这个键的后果有两层：
     *   ① `StatusBadge` 的 `labels[status] ?? status` 显示英文码 `voided`；
     *   ② `ArTab` 的状态筛选下拉是 `Object.entries(AR_STATUS_LABELS)` 渲染的，
     *      所以**使用者无法筛出已作废单据** —— 下拉里没有这一项。
     * 字典种子同步补于 `2026-10-16-fix10-status-dict-gaps.sql`。
     */
    voided: '已作废',
  },
);

export const RECEIPT_STATUS_LABELS: Record<string, string> =
  withDictionaryFallback('receipt_status', {
    unmatched: '未核销',
    partial: '部分核销',
    matched: '已核销',
    // `ReceiptStatus` 含 'voided'，但字典种子（receipt_status）只有三个键。
    // 缺这一个兜底，作废的回款单会在列表/打印里直接显示英文状态码。
    voided: '已作废',
  });

/**
 * 应付单状态标签。
 *
 * `approved` 是字典种子（ap_status：pending/partial/paid）**缺**的键，
 * 而 `shared/api.interface.ts` 的 `ApStatus` 含 `'approved'`。
 * 不补兜底文案，已批准的应付单会显示成原始英文状态码。
 */
export const AP_STATUS_LABELS: Record<string, string> = withDictionaryFallback(
  'ap_status',
  {
    pending: '待付款',
    approved: '已批准',
    partial: '部分付款',
    paid: '已付清',
    /*
     * §5.8 / B1 收尾：补 `voided`，理由同 `AR_STATUS_LABELS`
     * （`ApStatus` 含它、作废路径会写它、`ApTab` 的下拉按本表渲染）。
     */
    voided: '已作废',
  },
);

export const PAYMENT_STATUS_LABELS: Record<string, string> =
  withDictionaryFallback('payment_status', {
    pending: '待审批',
    approved: '已批准',
    rejected: '已驳回',
    paid: '已核销',
    // 同 RECEIPT_STATUS_LABELS：`PaymentStatus` 含 'voided'，字典未含此键。
    voided: '已作废',
  });

/**
 * 发票类型标签 —— **未接管字典**。
 * 既有 `invoice_type` 字典的键（`vat_special` / `vat_normal`）与常量一致，
 * 但该字典还有 `electronic` 等额外键，接管后行为变化需业务确认。
 * 保留为常量并在台账登记。
 */
export const INVOICE_TYPE_LABELS: Record<string, string> = {
  vat_special: '增值税专用发票',
  vat_normal: '增值税普通发票',
};

export const REVENUE_METHOD_LABELS: Record<string, string> =
  withDictionaryFallback('revenue_method', {
    progress: '进度法',
    milestone: '里程碑',
    quantity: '按量交付',
    subscription: '分期确认',
  });

/**
 * F7（§5.8）：**退货单状态标签** —— 并入字典权威。
 *
 * 原先 `ReturnsPage.tsx` 自带一份 `STATUS_LABELS` 字面量，于是业务方在
 * 「设置 → 字典」改了文案，这个页面**不生效** —— 正是 B-05 想解决的问题。
 * 这里按本仓既有模式（`withDictionaryFallback('return_status', ...)`）收敛：
 * 调用点仍是 `RETURN_STATUS_LABELS[status]`，字典一旦配置即自动生效。
 */
export const RETURN_STATUS_LABELS: Record<string, string> =
  withDictionaryFallback('return_status', {
    draft: '草稿',
    submitted: '待审批',
    approved: '已批准',
    completed: '已完成',
    void: '已作废',
  });

/**
 * 退货**动作**的文案（提交审批 / 批准 / 驳回 / 完成退货 / 作废）。
 *
 * ## 为什么需要它 —— 本轮修复的一处"提示与按钮相反"
 *
 * `ReturnsPage` 的 `runAction(kind, id, action, label)` 把第 4 个参数直接拼成
 * 成功提示：`toast.success(\`${label}成功\`)`。而两个表格的调用点传的是
 * **状态**标签（`RETURN_STATUS_LABELS[row.status]`），于是：
 *
 * | 点的按钮 | 实际提示 |
 * |---|---|
 * | 草稿行「提交」 | **「草稿成功」** |
 * | 待审批行「批准」 | **「待审批成功」** |
 * | 待审批行「驳回」 | **「待审批成功」** |
 * | 已批准行「完成」 | **「已批准成功」** |
 * | 任意行「作废」 | 「草稿/待审批/已批准成功」 |
 *
 * 即提示说的是**动作发生前的状态**，与刚点的按钮**相互矛盾** ——
 * 使用者无法据此确认究竟发生了什么（"草稿成功"是什么意思？）。
 * 这不是文案风格问题，是把「状态」当「动作」用。
 *
 * ## 文案来源：与服务端状态机同源
 *
 * 键与文案对齐 `server/common/tax/return-rules.ts` 的 `RETURN_ACTION_LABELS`
 * （服务端是动作的权威，且 `RETURN_TRANSITIONS` 定义了每个动作允许的前置状态）。
 * 这里**不 import 服务端模块**（客户端不该依赖 server 目录），因此靠
 * `check:label-dict` 的同名机制与规格断言保持同步 —— 若服务端新增动作，
 * `ReturnAction` 联合类型会变，下面对应的 `Record<ReturnAction, string>`
 * 会**编译失败**，从而强制同步。
 *
 * ## 为什么不用 `withDictionaryFallback`
 *
 * 动作不是"业务状态"，管理员改它的收益低、误改风险高（把「批准」改成
 * 「驳回」会让提示与实际动作相反）。因此这里是**硬编码 + 类型穷尽检查**，
 * 与状态字典有意区别。
 */
export const RETURN_ACTION_LABELS: Record<ReturnAction, string> = {
  submit: '提交审批',
  approve: '批准',
  reject: '驳回',
  complete: '完成退货',
  void: '作废',
};

/**
 * F7：**票据状态标签**（`NotesPage`）。
 *
 * 同样从页面内联常量收敛到这里 —— 这是"状态文案的唯一权威入口"这个约定的
 * 一部分；只要还有页面自带字面量，就不能说字典是唯一权威。
 */
/*
 * §5.8 收尾：键集合原先与契约 `NoteStatus` 不符（同 `ASSET_DISPOSAL` 的问题）。
 *
 * 原键 `draft / registered / settled / void` 里，只有 `endorsed / discounted / settled`
 * 是契约值；契约的 `received / held / dishonored` 缺失。
 * `NotesPage` 同样自带一份正确的本地 `STATUS_LABELS`（穷尽性检查保证完整），
 * 本表则无人引用。现统一到本表并删除本地副本。
 */
export const NOTE_STATUS_LABELS: Record<string, string> =
  withDictionaryFallback('note_status', {
    received: '已收到',
    held: '持有中',
    endorsed: '已背书',
    discounted: '已贴现',
    settled: '已结清',
    dishonored: '已拒付',
  });

/**
 * F7：**对账单行核对状态标签**（`StatementTab`）。
 *
 * 注意与 `STATEMENT_STATUS` 区分：后者是后端 `statement.logic.ts` 的
 * 机器状态（reconciled/partial/open/voided/informational），用于核算；
 * 这里是**展示文案**，允许按业务口径调整措辞。
 */
export const STATEMENT_ROW_STATUS_LABELS: Record<string, string> = {
  reconciled: '已核销',
  partial: '部分核销',
  open: '未核销',
  voided: '已作废',
  informational: '备查',
};

/**
 * F7：**资产处置状态标签**（`AssetDisposalPanel`）。
 *
 * 处置单有独立状态机（申请→审批→处置→入账），与资产主状态不同，
 * 因此单列一个字典类型，避免与 `asset_status` 互相污染。
 */
/*
 * §5.8 收尾：**这张表的键原先整套都是错的**。
 *
 * 原键为 `draft / submitted / approved / completed / void` —— 那是
 * **单据审批流**的键集合（与变更单/处置单的审批状态同形），
 * 而契约 `AssetDisposalStatus = 'disposing' | 'disposed' | 'scrapped' | 'rejected'`
 * 里**一个都没有**。服务端实际写入的是 `'disposing'`
 * （`asset-lifecycle.service.ts:504`）、`'disposed'`、`'scrapped'`（:468/:612）
 * 与 `'rejected'`（:554）。
 *
 * 之所以一直没暴露：`AssetDisposalPanel` 自带一份**正确的本地** `STATUS_LABELS`
 * （`Record<AssetDisposalItem['status'], string>`，靠穷尽性检查保证完整），
 * 而本表**全仓 0 处引用** —— 一张没人用的表，键写错了也没人发现。
 * 现在把两边统一到本表（字典可编辑），并删除那份本地副本，
 * 使 B-05「改字典即生效」对这些状态真正成立。
 */
export const ASSET_DISPOSAL_STATUS_LABELS: Record<string, string> =
  withDictionaryFallback('asset_disposal_status', {
    disposing: '处置中',
    disposed: '已处置',
    scrapped: '已报废',
    rejected: '已驳回',
  });

type BadgeVariant = NonNullable<BadgeProps['variant']>;

export const STATUS_VARIANTS: Record<string, BadgeVariant> = {
  draft: 'secondary',
  new: 'secondary',
  pending: 'secondary',
  unmatched: 'secondary',
  submitted: 'warning',
  initiating: 'warning',
  following: 'warning',
  quoting: 'warning',
  negotiating: 'warning',
  approving: 'warning',
  pending_approval: 'warning',
  executing: 'warning',
  delivering: 'warning',
  accepting: 'warning',
  performing: 'warning',
  partial: 'warning',
  open: 'info',
  active: 'info',
  void: 'destructive',
  completed: 'success',
  closed: 'success',
  settled: 'success',
  matched: 'success',
  paid: 'success',
  confirmed: 'success',
  reached: 'success',
  approved: 'info',
  won: 'success',
  converted: 'success',
  recognized: 'success',
  issued: 'success',
  lost: 'destructive',
  rejected: 'destructive',
  overdue: 'destructive',
  /*
   * F7（§5.8）：退货单 / 票据 / 对账单行的状态色，从各页面内联色表收敛到这里。
   *
   * 原先 `ReturnsPage` 用 `bg-emerald-100 text-emerald-700` 这类**固定色阶**，
   * 两层后果：
   *   ① 不跟随主题（那几处没有 `dark:` 变体）→ **暗色模式下是刺眼的浅色块**；
   *   ② 与同语义的 `STATUS_VARIANTS` 取色不同（语义 token `bg-success/10`
   *      vs 固定色阶 `bg-emerald-100`）→ 同一状态在不同页面长得不一样。
   *
   * 收敛到语义 variant 后两者同时解决。语义映射沿用本表既有约定：
   * 进行中=warning、已生效/待回款=info、终态成功=success、驳回/作废=destructive、
   * 草稿/未核销=secondary。
   */
  /** 票据：已登记/已背书是"在流转中"的中间态，用 info 而非 warning */
  registered: 'info',
  endorsed: 'info',
  /** 票据：已贴现属于"进行中的资金动作"，与其它进行中状态一致用 warning */
  discounted: 'warning',
  /** 退货单：已批准 = 已生效（终态前的成功态），与合同/报销口径一致 */
  voided: 'destructive',
  /** 对账单备查行：不参与余额，用中性色避免与"未核销"混淆 */
  informational: 'secondary',
  /**
   * B6：项目取消/终止。
   *
   * 用 `destructive` 而不是 `secondary`：取消是一个**需要被看见**的终态
   * —— 同合同下只要有项目被取消，合同就永远不会回写 `completed`
   * （`tryCompleteContract` 要求全部项目 closed），使用者需要立刻意识到这件事。
   * 灰色会被当成"待处理"。
   */
  cancelled: 'destructive',
  /** B6 配套：已结项但被反结项回到 `accepting` 时，仍按"进行中"呈现 */
  reopened: 'warning',
};
