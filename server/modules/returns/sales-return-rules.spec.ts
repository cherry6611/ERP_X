/**
 * `sales-return-rules` 的规格：销售退货的**累计可退额度**与价税分离。
 *
 * 最重要的一组断言针对"同一笔收入被反复退货"：
 * 判据是**累计**口径（本次 + 已退 ≤ 收入确认），
 * 少算已退就会让退货额超过收入、把账面收入冲成负数。
 */
import {
  DEFAULT_SALES_RETURN_TAX_RATE,
  checkReturnAmount,
  returnableAmount,
  salesReturnTaxSplit,
  toNumber,
} from './sales-return-rules';

describe('returnableAmount', () => {
  it('收入 1000、已退 300 → 可退 700', () => {
    expect(returnableAmount({ revenueAmount: 1000, alreadyReturnedAmount: 300 })).toBe(700);
  });

  it('未退过 → 可退 = 收入全额', () => {
    expect(returnableAmount({ revenueAmount: 1000, alreadyReturnedAmount: 0 })).toBe(1000);
  });

  it('全退完 → 可退 0', () => {
    expect(returnableAmount({ revenueAmount: 1000, alreadyReturnedAmount: 1000 })).toBe(0);
  });

  it('⚠️ 已退超过收入（历史脏数据）→ 可退 0，不返回负数', () => {
    expect(returnableAmount({ revenueAmount: 1000, alreadyReturnedAmount: 1500 })).toBe(0);
  });

  it('入参与字符串（numeric 经 pg 驱动）同样可用', () => {
    expect(returnableAmount({ revenueAmount: '1000.00', alreadyReturnedAmount: '300.00' })).toBe(700);
  });

  it('null / undefined 按 0', () => {
    expect(returnableAmount({ revenueAmount: null, alreadyReturnedAmount: undefined })).toBe(0);
    expect(returnableAmount({ revenueAmount: 1000, alreadyReturnedAmount: null })).toBe(1000);
  });

  it('保留 2 位（尾差）', () => {
    expect(returnableAmount({ revenueAmount: 333.33, alreadyReturnedAmount: 111.11 })).toBe(222.22);
  });
});

describe('checkReturnAmount（累计闸门）', () => {
  const base = { revenueAmount: 1000, alreadyReturnedAmount: 0 };

  it('额度内 → 通过', () => {
    const r = checkReturnAmount({ amount: 300, ...base });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.amount).toBe(300);
      expect(r.returnable).toBe(1000);
    }
  });

  it('⚠️ 恰好等于可退额度 → 通过（判据是严格大于才拒绝）', () => {
    expect(checkReturnAmount({ amount: 1000, ...base }).ok).toBe(true);
    expect(
      checkReturnAmount({ amount: 700, revenueAmount: 1000, alreadyReturnedAmount: 300 }).ok,
    ).toBe(true);
  });

  it('⚠️ 累计超限 → 拒绝（防同一笔收入被反复退货）', () => {
    const r = checkReturnAmount({ amount: 800, revenueAmount: 1000, alreadyReturnedAmount: 300 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message).toContain('超过可退金额 700');
      expect(r.message).toContain('收入确认 1000');
      expect(r.message).toContain('已退 300');
    }
  });

  it('刚好超 1 分也拒绝（无容差）', () => {
    const r = checkReturnAmount({ amount: 700.01, revenueAmount: 1000, alreadyReturnedAmount: 300 });
    expect(r.ok).toBe(false);
  });

  it('金额为 0 → 拒绝，且**不**走额度比较（文案是"必须大于 0"）', () => {
    const r = checkReturnAmount({ amount: 0, ...base });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe('退货金额必须大于 0');
  });

  it('金额为负 → 同样按"必须大于 0"拒绝', () => {
    const r = checkReturnAmount({ amount: -100, ...base });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe('退货金额必须大于 0');
  });

  it('已全额退完后再退 1 分 → 拒绝，可退金额显示 0', () => {
    const r = checkReturnAmount({ amount: 0.01, revenueAmount: 1000, alreadyReturnedAmount: 1000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('超过可退金额 0');
  });

  it('入参为字符串同样可用', () => {
    expect(checkReturnAmount({ amount: 300, revenueAmount: '1000', alreadyReturnedAmount: '0' }).ok).toBe(true);
  });
});

describe('salesReturnTaxSplit（价税分离走权威 splitTax）', () => {
  it('含税 106、税率 6% → 净 100 / 税 6', () => {
    expect(salesReturnTaxSplit({ amount: 106, taxRate: 6 })).toEqual({ netAmount: 100, taxAmount: 6 });
  });

  it('净 + 税 恒等于含税金额（不能出现"少 1 分"）', () => {
    for (const amount of [106, 1000, 333.33, 999.99, 1234.56, 0.01]) {
      for (const rate of [1, 3, 6, 9, 13]) {
        const { netAmount, taxAmount } = salesReturnTaxSplit({ amount, taxRate: rate });
        const sum = Math.round((netAmount + taxAmount) * 100) / 100;
        expect(sum).toBe(amount);
      }
    }
  });

  it('⚠️ 税率缺省为 6%（与收入确认默认一致）', () => {
    expect(DEFAULT_SALES_RETURN_TAX_RATE).toBe(6);
    expect(salesReturnTaxSplit({ amount: 106 })).toEqual(
      salesReturnTaxSplit({ amount: 106, taxRate: 6 }),
    );
  });

  it('税率为 null / undefined 都落到默认值', () => {
    expect(salesReturnTaxSplit({ amount: 106, taxRate: null })).toEqual({ netAmount: 100, taxAmount: 6 });
    expect(salesReturnTaxSplit({ amount: 106, taxRate: undefined })).toEqual({ netAmount: 100, taxAmount: 6 });
  });

  it('税率为 0（免税）→ 净额 = 含税额、税额 0', () => {
    expect(salesReturnTaxSplit({ amount: 100, taxRate: 0 })).toEqual({ netAmount: 100, taxAmount: 0 });
  });

  it('入参为字符串同样可用', () => {
    expect(salesReturnTaxSplit({ amount: '106', taxRate: '6' })).toEqual({ netAmount: 100, taxAmount: 6 });
  });

  it('⚠️ 与权威 splitTax 同源：净额逐组相等（消除副本的意义所在）', () => {
    /* 这条断言的价值：一旦有人把公式改回内联版本，它会立刻失败 */
    for (const amount of [100, 106, 1000, 1060, 333.33, 777.77]) {
      for (const rate of [1, 6, 13]) {
        const mine = salesReturnTaxSplit({ amount, taxRate: rate });
        /* splitTax 的语义：tax = round2(amount*rate/(100+rate))，net = amount - tax */
        const expectTax = Math.round(((amount * rate) / (100 + rate)) * 100) / 100;
        const expectNet = Math.round((amount - expectTax) * 100) / 100;
        expect(mine.taxAmount).toBe(expectTax);
        expect(mine.netAmount).toBe(expectNet);
      }
    }
  });
});

describe('toNumber', () => {
  it('字符串 / null / NaN / Infinity 的归一', () => {
    expect(toNumber('123.45')).toBe(123.45);
    expect(toNumber(null)).toBe(0);
    expect(toNumber(undefined)).toBe(0);
    expect(toNumber('abc')).toBe(0);
    expect(toNumber(Number.NaN)).toBe(0);
    expect(toNumber(Number.POSITIVE_INFINITY)).toBe(0);
  });
});
