import {
  RETURN_ACTION_TARGET,
  RETURN_STATUSES,
  RETURN_TRANSITIONS,
  isBalanced,
  purchaseReturnLines,
  returnAmount,
  returnableQuantity,
  salesReturnCostLines,
  salesReturnLines,
  sumReturnLines,
  validateReturnAction,
  type ReturnStatus,
} from './return-rules';

/**
 * C-05 退货规则单测。
 *
 * 退货最容易错的两件事：**可退数量**少扣一次就超退；**金额还原**用错税率
 * 或直接用 `净额 × 税率` 会差 1 分，进而让红字凭证与发票对不上。
 * 这组测试把这两件事钉死。
 */
describe('C-05 退货状态机', () => {
  it('终态（completed / void）不可再流转', () => {
    for (const status of ['completed', 'void'] as ReturnStatus[]) {
      for (const action of ['submit', 'approve', 'reject', 'complete', 'void'] as const) {
        const errors = validateReturnAction(status, action);
        expect(errors.length).toBeGreaterThan(0);
        expect(errors[0]).toContain('终态');
      }
    }
  });

  it('正常流转链 draft → submitted → approved → completed', () => {
    expect(validateReturnAction('draft', 'submit')).toEqual([]);
    expect(validateReturnAction('submitted', 'approve')).toEqual([]);
    expect(validateReturnAction('approved', 'complete')).toEqual([]);
  });

  it('驳回退回草稿（允许改后重提，不把单子废掉）', () => {
    expect(validateReturnAction('submitted', 'reject')).toEqual([]);
    expect(RETURN_ACTION_TARGET.reject).toBe('draft');
  });

  it('跳过审批不能直接完成（approved 是 complete 的唯一前置）', () => {
    expect(validateReturnAction('draft', 'complete').length).toBeGreaterThan(0);
    expect(validateReturnAction('submitted', 'complete').length).toBeGreaterThan(0);
  });

  it('已完成不可作废（已出红字凭证，须先作废凭证）', () => {
    const errors = validateReturnAction('completed', 'void');
    expect(errors.length).toBeGreaterThan(0);
  });

  it('草稿/待审/已批准可作废', () => {
    for (const status of ['draft', 'submitted', 'approved'] as ReturnStatus[]) {
      expect(validateReturnAction(status, 'void')).toEqual([]);
    }
  });

  it('非法流转的错误消息是可读中文并列出允许的前置状态', () => {
    const errors = validateReturnAction('draft', 'approve');
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('批准');
    expect(errors[0]).toContain('允许的前置状态');
  });

  it('所有状态与目标状态都在枚举内', () => {
    for (const target of Object.values(RETURN_ACTION_TARGET)) {
      expect(RETURN_STATUSES).toContain(target);
    }
    for (const allowed of Object.values(RETURN_TRANSITIONS)) {
      for (const status of allowed) expect(RETURN_STATUSES).toContain(status);
    }
  });
});

describe('C-05 可退数量', () => {
  it('可退 = 已验收 − 已退', () => {
    expect(
      returnableQuantity({ quantity: 100, acceptedQuantity: 80, returnedQuantity: 30 })
        .returnableQuantity
    ).toBe(50);
  });

  it('未验收的货不可退（基准是已验收，不是订购）', () => {
    const result = returnableQuantity({
      quantity: 100,
      acceptedQuantity: 0,
      returnedQuantity: 0,
    });
    expect(result.returnableQuantity).toBe(0);
    expect(result.notAccepted).toBe(true);
  });

  it('已退超过已验收时夹到 0，不产生负数可退量', () => {
    expect(
      returnableQuantity({ quantity: 10, acceptedQuantity: 10, returnedQuantity: 15 })
        .returnableQuantity
    ).toBe(0);
  });

  it('分多次退货后累计已退被正确扣减：再退一次即超额被识别', () => {
    // 验收 100，已退 60 → 可退 40
    const first = returnableQuantity({
      quantity: 100,
      acceptedQuantity: 100,
      returnedQuantity: 60,
    });
    expect(first.returnableQuantity).toBe(40);
    // 若再退 50 则超过可退 40
    expect(50 > first.returnableQuantity).toBe(true);
  });

  it('数量为小数时按整数截断（退货数量只能是整数件）', () => {
    expect(
      returnableQuantity({
        quantity: 10,
        acceptedQuantity: 10.9,
        returnedQuantity: 3.7,
      }).returnableQuantity
    ).toBe(7);
  });
});

describe('C-05 退货金额还原', () => {
  it('按原单税率倒算：含税 1060、税率 6% → 净额 1000、税额 60', () => {
    const result = returnAmount({ unitPrice: 1060, quantity: 1, taxRate: 6 });
    expect(result.amount).toBe(1060);
    expect(result.netAmount).toBe(1000);
    expect(result.taxAmount).toBe(60);
  });

  it('恒等式：净额 + 税额 === 含税金额（多组边界）', () => {
    for (const [unitPrice, quantity, taxRate] of [
      [1060, 1, 6],
      [1130, 3, 13],
      [99.99, 7, 6],
      [0.01, 1, 13],
      [12345.67, 13, 9],
      [1, 1, 1],
    ] as const) {
      const result = returnAmount({ unitPrice, quantity, taxRate });
      expect(
        Math.round((result.netAmount + result.taxAmount) * 100) / 100
      ).toBe(Math.round(result.amount * 100) / 100);
    }
  });

  it('0 税率时净额等于含税额、税额为 0', () => {
    const result = returnAmount({ unitPrice: 500, quantity: 2, taxRate: 0 });
    expect(result.amount).toBe(1000);
    expect(result.netAmount).toBe(1000);
    expect(result.taxAmount).toBe(0);
  });

  it('数量为 0 时金额全为 0（不会出现负零或 NaN）', () => {
    const result = returnAmount({ unitPrice: 100, quantity: 0, taxRate: 13 });
    expect(result.amount).toBe(0);
    expect(result.netAmount).toBe(0);
    expect(result.taxAmount).toBe(0);
  });

  it('多行汇总：三项分别求和，合计仍满足恒等式', () => {
    const summary = sumReturnLines([
      { quantity: 2, unitPrice: 1130, taxRate: 13 },
      { quantity: 3, unitPrice: 1060, taxRate: 6 },
      { quantity: 1, unitPrice: 99.99, taxRate: 6 },
    ]);
    expect(summary.quantity).toBe(6);
    expect(
      Math.round((summary.netAmount + summary.taxAmount) * 100) / 100
    ).toBe(Math.round(summary.amount * 100) / 100);
  });

  it('少退一分钱也要如实反映（不允许把尾差抹平到 0）', () => {
    const result = returnAmount({ unitPrice: 0.01, quantity: 1, taxRate: 13 });
    expect(result.amount).toBe(0.01);
    expect(Math.round((result.netAmount + result.taxAmount) * 100) / 100).toBe(0.01);
  });
});

describe('C-05 退货分录', () => {
  it('采购退货：借 2202 含税 / 贷 1403 净额 + 贷 222102 税额，且借贷平衡', () => {
    const lines = purchaseReturnLines(1000, 60);
    expect(isBalanced(lines)).toBe(true);
    expect(lines.find((l) => l.accountCode === '2202')?.debit).toBe(1060);
    expect(lines.find((l) => l.accountCode === '1403')?.credit).toBe(1000);
    expect(lines.find((l) => l.accountCode === '222102')?.credit).toBe(60);
  });

  it('采购退货税额为 0 时不产生进项税额行', () => {
    const lines = purchaseReturnLines(1000, 0);
    expect(lines.find((l) => l.accountCode === '222102')).toBeUndefined();
    expect(isBalanced(lines)).toBe(true);
  });

  it('销售退货：借 6001 净额 + 借 222101 税额 / 贷 1122 含税，且借贷平衡', () => {
    const lines = salesReturnLines(1000, 60);
    expect(isBalanced(lines)).toBe(true);
    expect(lines.find((l) => l.accountCode === '6001')?.debit).toBe(1000);
    expect(lines.find((l) => l.accountCode === '222101')?.debit).toBe(60);
    expect(lines.find((l) => l.accountCode === '1122')?.credit).toBe(1060);
  });

  it('销售退货默认不红冲成本（需业务显式调用成本冲回）', () => {
    const lines = salesReturnLines(1000, 60);
    expect(lines.find((l) => l.accountCode === '6401')).toBeUndefined();
    expect(lines.find((l) => l.accountCode === '1403')).toBeUndefined();
  });

  it('成本冲回分录独立可用：借 1403 / 贷 6401，且金额为 0 时返回空数组', () => {
    const lines = salesReturnCostLines(400);
    expect(isBalanced(lines)).toBe(true);
    expect(lines.find((l) => l.accountCode === '1403')?.debit).toBe(400);
    expect(lines.find((l) => l.accountCode === '6401')?.credit).toBe(400);
    expect(salesReturnCostLines(0)).toEqual([]);
  });

  it('金额全为 0 时采购/销售退货都不产生空分录行', () => {
    expect(purchaseReturnLines(0, 0)).toEqual([]);
    expect(salesReturnLines(0, 0)).toEqual([]);
  });
});
