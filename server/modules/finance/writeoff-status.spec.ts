/**
 * `writeoff-status` 的规格：应付核销/冲回的状态重算。
 *
 * 最重要的是第一条断言：**已作废单据不得被"复活"**。
 * `ap.service.ts` 的注释描述了这条规则被破坏后的后果 ——
 * 单据状态回到"已付/部分付"而冲回凭证仍在账上 → **重复计数**。
 */
import {
  REVERSAL_ZERO_TOLERANCE,
  apWriteoffReversalStatus,
  apWriteoffStatus,
  isPaymentFullyUsed,
  paymentStatusAfterReversal,
} from './writeoff-status';

describe('apWriteoffStatus', () => {
  it('⚠️ 已作废单据不参与重算（防"复活"：冲回凭证还在账上，状态却回到已付/部分付）', () => {
    expect(
      apWriteoffStatus({ currentStatus: 'voided', newPaidAmount: 500, totalAmount: 1000 }),
    ).toBe('voided');
    expect(
      apWriteoffStatus({ currentStatus: 'voided', newPaidAmount: 1000, totalAmount: 1000 }),
    ).toBe('voided');
    expect(
      apWriteoffStatus({ currentStatus: 'voided', newPaidAmount: 0.01, totalAmount: 1000 }),
    ).toBe('voided');
  });

  it('付满 → paid', () => {
    expect(apWriteoffStatus({ currentStatus: 'pending', newPaidAmount: 1000, totalAmount: 1000 })).toBe('paid');
    expect(apWriteoffStatus({ currentStatus: 'partial', newPaidAmount: 1200, totalAmount: 1000 })).toBe('paid');
  });

  it('付了一部分 → partial', () => {
    expect(apWriteoffStatus({ currentStatus: 'pending', newPaidAmount: 1, totalAmount: 1000 })).toBe('partial');
    expect(apWriteoffStatus({ currentStatus: 'approved', newPaidAmount: 999.99, totalAmount: 1000 })).toBe('partial');
  });

  it('一分没付 → 保持原状态（不强行改成 pending）', () => {
    expect(apWriteoffStatus({ currentStatus: 'approved', newPaidAmount: 0, totalAmount: 1000 })).toBe('approved');
    expect(apWriteoffStatus({ currentStatus: 'pending', newPaidAmount: 0, totalAmount: 1000 })).toBe('pending');
  });

  it('⚠️ 边界：差 1 分不算付满（无容差）', () => {
    expect(apWriteoffStatus({ currentStatus: 'pending', newPaidAmount: 999.99, totalAmount: 1000 })).toBe('partial');
    expect(apWriteoffStatus({ currentStatus: 'pending', newPaidAmount: 1000.001, totalAmount: 1000 })).toBe('paid');
  });
});

describe('apWriteoffReversalStatus', () => {
  it('冲回到 0（含 0.001 容差内）→ pending', () => {
    expect(apWriteoffReversalStatus({ newPaidAmount: 0, totalAmount: 1000 })).toBe('pending');
    expect(apWriteoffReversalStatus({ newPaidAmount: 0.001, totalAmount: 1000 })).toBe('pending');
    expect(apWriteoffReversalStatus({ newPaidAmount: -0.5, totalAmount: 1000 })).toBe('pending');
  });

  it('仍有余款 → partial', () => {
    expect(apWriteoffReversalStatus({ newPaidAmount: 0.01, totalAmount: 1000 })).toBe('partial');
    expect(apWriteoffReversalStatus({ newPaidAmount: 500, totalAmount: 1000 })).toBe('partial');
  });

  it('仍付满 → paid', () => {
    expect(apWriteoffReversalStatus({ newPaidAmount: 1000, totalAmount: 1000 })).toBe('paid');
  });

  it('容差常量为 0.001（改动它会同时影响本模块两条判据）', () => {
    expect(REVERSAL_ZERO_TOLERANCE).toBe(0.001);
  });
});

describe('付款单状态', () => {
  it('核销路径：无容差（newUsed >= amount 才算已付）', () => {
    expect(isPaymentFullyUsed(1000, 1000)).toBe(true);
    expect(isPaymentFullyUsed(999.99, 1000)).toBe(false);
    /* 差 0.001 也判未付满 —— 与冲回路径不同 */
    expect(isPaymentFullyUsed(999.999, 1000)).toBe(false);
  });

  it('冲回路径：有 0.001 容差', () => {
    expect(paymentStatusAfterReversal(1000, 1000)).toBe('paid');
    expect(paymentStatusAfterReversal(999.999, 1000)).toBe('paid');
    expect(paymentStatusAfterReversal(999, 1000)).toBe('approved');
  });

  it('⚠️ 已如实记录的口径不一致：同一组数在两条路径上可能得出不同状态', () => {
    /*
     * 这不是"我引入的 bug"，而是抽取时**暴露**出来的既有差异：
     *   · 核销路径 `isPaymentFullyUsed(999.999, 1000)` → false
     *   · 冲回路径 `paymentStatusAfterReversal(999.999, 1000)` → 'paid'
     * 本断言把这个事实固定下来（防止有人以为两处一致而"顺手统一"其中一处却没改另一处）。
     * 真要统一容差，应当作一次显式的口径变更并评估存量状态，而不是顺手改。
     */
    const used = 999.999;
    const total = 1000;
    expect(isPaymentFullyUsed(used, total)).toBe(false);
    expect(paymentStatusAfterReversal(used, total)).toBe('paid');
  });

  it('冲回只会在 paid / approved 之间切换（不会回到 pending）', () => {
    for (const used of [0, 1, 500, 999, 1000, 1200]) {
      const st = paymentStatusAfterReversal(used, 1000);
      expect(['paid', 'approved']).toContain(st);
    }
  });
});
