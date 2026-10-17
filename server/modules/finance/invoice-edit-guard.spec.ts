import {
  VOUCHER_AFFECTING_FIELDS,
  decideInvoiceEdit,
  pickVoucherAffectingFields,
  shouldRebuildInvoiceVoucher,
} from './invoice-edit-guard';

/**
 * 规格锚定本仓的记账哲学：**仅草稿凭证可改，已过账的改动须走红冲**
 * （`voucher.controller.ts:317`、`voucher.service.ts:787`）。
 *
 * 发票编辑只是把同一口径应用到"发票"这一层，所以断言的核心是
 * 「凭证一过账，影响金额的字段就锁死」。
 */
describe('decideInvoiceEdit：发票可编辑性', () => {
  it('非 issued 状态一律不可改（含已作废）', () => {
    /*
     * 已作废的票改不了 —— 它的冲回凭证已生成，再改发票本身会让
     * "已作废"这个状态失去意义。
     */
    for (const status of ['voided', 'draft', 'unknown']) {
      const r = decideInvoiceEdit({
        invoiceStatus: status,
        voucherStatus: 'draft',
        touchesVoucherFields: false,
      });
      expect(r.ok).toBe(false);
    }
    // 文案要可读且带上当前状态，便于使用者判断
    const r = decideInvoiceEdit({
      invoiceStatus: 'voided',
      voucherStatus: null,
      touchesVoucherFields: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('voided');
  });

  it('不触及凭证字段时，即使凭证已过账也放行（改备注/补关联应收）', () => {
    const r = decideInvoiceEdit({
      invoiceStatus: 'issued',
      voucherStatus: 'posted',
      touchesVoucherFields: false,
    });
    expect(r).toEqual({ ok: true, rebuildVoucher: false });
  });

  it('⚠️ 凭证已过账 + 触及金额类字段 → 拒绝，且提示"先作废再重开"', () => {
    const r = decideInvoiceEdit({
      invoiceStatus: 'issued',
      voucherStatus: 'posted',
      touchesVoucherFields: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // 必须给出可执行的下一步，而不是只说"不行"
      expect(r.reason).toContain('作废');
      expect(r.reason).toContain('冲回');
    }
  });

  it('凭证为草稿 → 放行且要求重建凭证', () => {
    expect(
      decideInvoiceEdit({
        invoiceStatus: 'issued',
        voucherStatus: 'draft',
        touchesVoucherFields: true,
      }),
    ).toEqual({ ok: true, rebuildVoucher: true });
  });

  it('无凭证（null）→ 放行且要求重建（把凭证补上）', () => {
    expect(
      decideInvoiceEdit({
        invoiceStatus: 'issued',
        voucherStatus: null,
        touchesVoucherFields: true,
      }),
    ).toEqual({ ok: true, rebuildVoucher: true });
  });

  it('⚠️ 凭证已作废 → 放行且要求重建', () => {
    /*
     * 这条容易写错成"已作废等于已入账，禁止改"。实际相反：
     * `generateVoucherDraft` 的幂等判据是 `ne(status, 'voided')`
     * （`voucher-hook.service.ts:118-127`），即已作废的旧凭证**不算**
     * "本业务已出凭证"，所以能正常生成新的一张 —— 这正是"作废后重开"的机制。
     */
    expect(
      decideInvoiceEdit({
        invoiceStatus: 'issued',
        voucherStatus: 'voided',
        touchesVoucherFields: true,
      }),
    ).toEqual({ ok: true, rebuildVoucher: true });
  });
});

describe('pickVoucherAffectingFields', () => {
  it('只挑出影响凭证的字段，忽略备注与关联应收', () => {
    expect(
      pickVoucherAffectingFields(['remark', 'amount', 'arId', 'taxRate']),
    ).toEqual(['amount', 'taxRate']);
  });

  it('空集合 → 空数组（调用方据此判定"无需重建凭证"）', () => {
    expect(pickVoucherAffectingFields([])).toEqual([]);
    expect(pickVoucherAffectingFields(['remark', 'arId', 'invoiceNo'])).toEqual(
      [],
    );
  });

  it('字段清单覆盖金额/税率/日期/类型/方向/归属（改任一项都要重算凭证）', () => {
    expect([...VOUCHER_AFFECTING_FIELDS].sort()).toEqual(
      [
        'amount',
        'contractId',
        'direction',
        'invoiceDate',
        'invoiceType',
        'projectId',
        'supplierId',
        'taxEntityId',
        'taxRate',
      ].sort(),
    );
  });
});

describe('shouldRebuildInvoiceVoucher：销项票不得补凭证', () => {
  const rebuildable = {
    ok: true as const,
    rebuildVoucher: true,
  };

  it('进项票 + 无凭证/草稿/作废 → 允许重建（补凭证是设计内行为）', () => {
    expect(shouldRebuildInvoiceVoucher('purchase', rebuildable)).toBe(true);
  });

  it('销项票 + 无凭证 → 不重建（方案 A：收入确认是唯一收入入口）', () => {
    expect(shouldRebuildInvoiceVoucher('sales', rebuildable)).toBe(false);
    expect(shouldRebuildInvoiceVoucher(null, rebuildable)).toBe(false);
    expect(shouldRebuildInvoiceVoucher(undefined, rebuildable)).toBe(false);
  });

  it('无需重建 / 不可编辑时一律 false', () => {
    expect(
      shouldRebuildInvoiceVoucher('purchase', {
        ok: true,
        rebuildVoucher: false,
      }),
    ).toBe(false);
    expect(
      shouldRebuildInvoiceVoucher('purchase', {
        ok: false,
        reason: 'x',
      }),
    ).toBe(false);
  });
});
