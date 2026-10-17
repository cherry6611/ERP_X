/**
 * 发票「登记后编辑」的**可编辑性判据**（纯函数，无 DB / 无 Nest 依赖）。
 *
 * ## 为什么需要这个模块
 *
 * 用户要求「发票登记后能编辑」。但发票不是孤立的数据 ——
 * `createInvoice` 在同一流程里会生成一张**记账凭证**
 * （`invoice.service.ts` 的 `generateVoucherDraft({ sourceType: 'invoice',
 * sourceRef: \`invoice:${invoiceNo ?? code}\` })`）。
 *
 * 因此"能不能改"取决于**凭证处于什么状态**，而凭证的状态机在本仓是明确的
 * （`voucher.service.ts:787`：`post` 仅 `draft→posted`；`void` 允许
 * `draft|posted→voided`），且 `voucher.controller.ts:317` 写着本仓的记账哲学：
 *
 * > **仅草稿凭证可改（已过账凭证的分录摘要属于已入账信息，改动需走红冲）**
 *
 * 所以发票编辑采用**同一口径**：
 *
 * | 凭证状态 | 允许改的发票字段 | 理由 |
 * |---|---|---|
 * | 无凭证 / `draft` / `voided` | 全部（含金额、税率、日期、归属） | 尚未入账，改了不产生账实差异 |
 * | `posted` | **仅备注、关联应收** | 凭证已入账；改金额会让明细账与发票台账永久对不上。要改必须先作废发票（会生成冲回凭证）再重开 |
 *
 * ## 为什么不"自动红冲再重开"
 *
 * 已过账凭证的红冲会**改变已结期间的账**。若允许通过"编辑发票"隐式触发，
 * 使用者以为自己只是改了张单子，实际却在已结账的期间里加了一对红蓝凭证 ——
 * 这正是审计反复强调的"隐式改账"风险。因此把这条路径留给**显式**的
 * 「作废发票」操作（它有跨月申报闸门、有冲回凭证、有审计留痕）。
 */

/** 会进入凭证计算的字段 —— 改动它们就必须重算凭证 */
export const VOUCHER_AFFECTING_FIELDS = [
  'amount',
  'taxRate',
  'invoiceDate',
  'invoiceType',
  'direction',
  'contractId',
  'supplierId',
  'projectId',
  'taxEntityId',
] as const;

export type VoucherAffectingField = (typeof VOUCHER_AFFECTING_FIELDS)[number];

/** 凭证状态（与 `fin_voucher.status` 一致） */
export type VoucherStatusForEdit = 'draft' | 'posted' | 'voided' | null;

export interface InvoiceEditGuardInput {
  /** 发票当前状态：只有 `issued` 可编辑 */
  invoiceStatus: string;
  /** 记账凭证状态；`null` 表示这张发票没有凭证（例如进项票未过账或历史数据） */
  voucherStatus: VoucherStatusForEdit;
  /** 本次请求是否试图修改**影响凭证**的字段 */
  touchesVoucherFields: boolean;
}

export type InvoiceEditDecision =
  | { ok: true; rebuildVoucher: boolean }
  | { ok: false; reason: string };

/**
 * 判定本次编辑是否允许，以及是否需要重建凭证。
 *
 * 返回值：
 * - `{ ok: true, rebuildVoucher: false }` —— 允许；凭证无需动（未触及影响字段）
 * - `{ ok: true, rebuildVoucher: true }`  —— 允许；调用方必须**先作废旧草稿凭证再重建**
 * - `{ ok: false, reason }`               —— 拒绝，`reason` 是可直接展示的中文
 *
 * ⚠️ `reason` 用**返回值**而不是在这里 throw：本模块要能被单测直接断言文案，
 * 也不想依赖 Nest 的异常类型。调用方负责把它包成 `BadRequestException`。
 */
export function decideInvoiceEdit(
  input: InvoiceEditGuardInput,
): InvoiceEditDecision {
  /* ① 只有已开具的发票能改。已作废的票改不了 —— 它的冲回凭证已经生成，
     再改发票本身会让"已作废"这个状态失去意义。 */
  if (input.invoiceStatus !== 'issued') {
    return {
      ok: false,
      reason: `只有已开具的发票可以修改，当前状态为 ${input.invoiceStatus}`,
    };
  }

  /* ② 不触及影响凭证的字段 → 直接放行（改备注、补关联应收都不该被挡） */
  if (!input.touchesVoucherFields) {
    return { ok: true, rebuildVoucher: false };
  }

  /* ③ 触及影响凭证的字段：看过账状态 */
  if (input.voucherStatus === 'posted') {
    return {
      ok: false,
      reason:
        '该发票的记账凭证已过账，金额/税率/日期等已入账信息不可直接修改；' +
        '如需更正请先作废该发票（会生成冲回凭证）再重新登记',
    };
  }

  /*
   * ④ 无凭证 / 草稿 / 已作废 → 可改，且需要重建凭证。
   *
   * `voided` 也要重建：`generateVoucherDraft` 的幂等判据是
   * `ne(finVoucher.status, 'voided')`（`voucher-hook.service.ts:118-127`），
   * 即**已作废的旧凭证不算"本业务已出凭证"**，所以能正常生成新的一张。
   * 这也正是"作废后重开"能work的原因。
   */
  return { ok: true, rebuildVoucher: true };
}

/**
 * 从一批字段名里挑出"影响凭证"的那些。
 *
 * 调用方通常这样用：先看 `dto` 里哪些键是 `!== undefined`，
 * 再把那个键集合交给本函数，避免在 service 里写一长串 `||`。
 */
export function pickVoucherAffectingFields(
  presentKeys: readonly string[],
): VoucherAffectingField[] {
  const set = new Set<string>(VOUCHER_AFFECTING_FIELDS);
  return presentKeys.filter((k): k is VoucherAffectingField => set.has(k));
}

/**
 * 编辑后是否真的应该重建凭证。
 *
 * `decideInvoiceEdit` 只能看到"有没有凭证"，看不到发票方向；而本仓方案 A 下
 * **销项发票按设计不生成凭证**（收入确认才是收入/销项税的唯一入账入口）。
 * 因此 `voucherStatus === null` 对销项票是正常状态，不是"缺凭证"。
 *
 * 这个判据单独抽出来，是为了防止回退：只有进项票才允许从 0 重建凭证。
 * 销项票即使历史上曾有过凭证，也不能在编辑时新建一张。
 */
export function shouldRebuildInvoiceVoucher(
  direction: string | null | undefined,
  decision: InvoiceEditDecision,
): boolean {
  if (!decision.ok || !decision.rebuildVoucher) return false;
  return (direction ?? 'sales') === 'purchase';
}
