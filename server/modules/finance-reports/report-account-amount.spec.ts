/**
 * `report-account-amount` 的规格：报表取数的方向口径。
 *
 * 这组断言不是"验算加法"，而是**把三种口径的语义钉死** ——
 * 谁钳 0、谁不钳、`change` 为何与方向无关。写错的后果都是"数字错了但报表仍平"。
 */
import {
  accountAmount,
  isCreditDirection,
  isDebitDirection,
  type AccountValues,
} from './report-account-amount';

/** 借方余额 100（借 > 贷） */
const DEBIT_SIDE: AccountValues = {
  openingDebit: 100,
  openingCredit: 0,
  debitOccur: 30,
  creditOccur: 0,
  closingDebit: 130,
  closingCredit: 0,
};

/** 贷方余额 100（贷 > 借）—— 对应"子科目反向余额"的真实场景 */
const CREDIT_SIDE: AccountValues = {
  openingDebit: 0,
  openingCredit: 100,
  debitOccur: 0,
  creditOccur: 30,
  closingDebit: 0,
  closingCredit: 130,
};

describe('方向识别', () => {
  it('中文与英文两种写法都认', () => {
    expect(isDebitDirection('借')).toBe(true);
    expect(isDebitDirection('debit')).toBe(true);
    expect(isCreditDirection('贷')).toBe(true);
    expect(isCreditDirection('credit')).toBe(true);
  });

  it('其它值既不是借也不是贷（走净额口径）', () => {
    expect(isDebitDirection('净')).toBe(false);
    expect(isCreditDirection('净')).toBe(false);
    expect(isDebitDirection('')).toBe(false);
  });
});

describe('⚠️ 借方口径：钳 0（这是"货币资金虚增"的机制）', () => {
  it('借方余额 → 取借方净额', () => {
    expect(accountAmount('balance', '借', DEBIT_SIDE)).toBe(130);
  });

  it('⚠️ 贷方余额的借方科目 → **返回 0，不是 -130**', () => {
    expect(accountAmount('balance', '借', CREDIT_SIDE)).toBe(0);
  });

  it('⚠️ 正因为钳 0，若把"货币资金"整行按`借`汇总，贷方子科目会被抹掉 → 虚增', () => {
    /*
     * 实测场景（迁移 bs-moneyfunds-net 修的就是这个）：
     *   1001 库存现金 借 100；100202 银行存款-一般户 贷 100（账户间划转后）
     *   · 逐科目按`借`取：1001 → 100，100202 → **0**（钳掉）→ 合计 **100**
     *   · 按`净`取：100 + (−100) = **0**  ← 正确
     */
    const cash: AccountValues = { openingDebit: 0, openingCredit: 0, debitOccur: 100, creditOccur: 0, closingDebit: 100, closingCredit: 0 };
    const bank: AccountValues = { openingDebit: 0, openingCredit: 0, debitOccur: 0, creditOccur: 100, closingDebit: 0, closingCredit: 100 };
    const byDebit = accountAmount('balance', '借', cash) + accountAmount('balance', '借', bank);
    const byNet = accountAmount('balance', '净', cash) + accountAmount('balance', '净', bank);
    expect(byDebit).toBe(100);
    expect(byNet).toBe(0);
    expect(byDebit).not.toBe(byNet);
  });

  it('英文写法 debit 与中文等价', () => {
    expect(accountAmount('balance', 'debit', CREDIT_SIDE)).toBe(accountAmount('balance', '借', CREDIT_SIDE));
  });
});

describe('⚠️ 贷方口径：钳 0', () => {
  it('贷方余额 → 取贷方净额', () => {
    expect(accountAmount('balance', '贷', CREDIT_SIDE)).toBe(130);
  });

  it('借方余额的贷方科目 → 返回 0', () => {
    expect(accountAmount('balance', '贷', DEBIT_SIDE)).toBe(0);
  });

  it('英文写法 credit 等价', () => {
    expect(accountAmount('balance', 'credit', DEBIT_SIDE)).toBe(accountAmount('balance', '贷', DEBIT_SIDE));
  });
});

describe('⚠️ 净额口径：**不钳**，可负', () => {
  it('借方余额 → 正数', () => {
    expect(accountAmount('balance', '净', DEBIT_SIDE)).toBe(130);
  });

  it('贷方余额 → **负数**（不钳成 0）', () => {
    expect(accountAmount('balance', '净', CREDIT_SIDE)).toBe(-130);
  });

  it('未知方向值也走净额（不会因拼错方向而静默返回 0）', () => {
    expect(accountAmount('balance', 'xxx', CREDIT_SIDE)).toBe(-130);
  });
});

describe('kind 决定用哪一对数', () => {
  const V: AccountValues = {
    openingDebit: 10,
    openingCredit: 2,
    debitOccur: 30,
    creditOccur: 5,
    closingDebit: 38,
    closingCredit: 5,
  };

  it('balance → 期末', () => {
    expect(accountAmount('balance', '净', V)).toBe(33);
  });

  it('occurrence → 本期发生额', () => {
    expect(accountAmount('occurrence', '净', V)).toBe(25);
  });

  it('opening → 年初', () => {
    expect(accountAmount('opening', '净', V)).toBe(8);
  });
});

describe('⚠️ change（变动额）：完全忽略方向', () => {
  const V: AccountValues = {
    openingDebit: 100,
    openingCredit: 0,
    debitOccur: 0,
    creditOccur: 40,
    closingDebit: 60,
    closingCredit: 0,
  };

  it('= (期末借−期末贷) − (年初借−年初贷)', () => {
    /* (60-0) − (100-0) = -40 */
    expect(accountAmount('change', '净', V)).toBe(-40);
  });

  it('⚠️ 传 `借` 也返回 **-40**（不钳 0）—— 否则"减少"会被抹成 0', () => {
    expect(accountAmount('change', '借', V)).toBe(-40);
  });

  it('⚠️ 传 `贷` 也是 -40（方向对它无意义）', () => {
    expect(accountAmount('change', '贷', V)).toBe(-40);
  });

  it('三个方向结果一致', () => {
    const a = accountAmount('change', '借', V);
    const b = accountAmount('change', '贷', V);
    const c = accountAmount('change', '净', V);
    expect([a, b, c]).toEqual([a, a, a]);
  });

  it('无变动 → 0', () => {
    expect(
      accountAmount('change', '净', {
        openingDebit: 50, openingCredit: 0, debitOccur: 0, creditOccur: 0, closingDebit: 50, closingCredit: 0,
      }),
    ).toBe(0);
  });
});

describe('边界', () => {
  it('values 为 undefined / null → 0', () => {
    expect(accountAmount('balance', '借', undefined)).toBe(0);
    expect(accountAmount('balance', '借', null)).toBe(0);
    expect(accountAmount('change', '净', undefined)).toBe(0);
  });

  it('保留 2 位（三分位被舍入）', () => {
    expect(
      accountAmount('balance', '净', {
        openingDebit: 0, openingCredit: 0, debitOccur: 0, creditOccur: 0,
        closingDebit: 100.005, closingCredit: 0,
      }),
    ).toBe(100.01);
  });

  it('恰好相等 → 三个方向都是 0', () => {
    const ZERO: AccountValues = {
      openingDebit: 5, openingCredit: 5, debitOccur: 5, creditOccur: 5, closingDebit: 5, closingCredit: 5,
    };
    expect(accountAmount('balance', '借', ZERO)).toBe(0);
    expect(accountAmount('balance', '贷', ZERO)).toBe(0);
    expect(accountAmount('balance', '净', ZERO)).toBe(0);
  });

  it('负数输入（红冲后的借贷方发生额）也能算', () => {
    const V: AccountValues = {
      openingDebit: 100, openingCredit: 0, debitOccur: -30, creditOccur: 0, closingDebit: 70, closingCredit: 0,
    };
    expect(accountAmount('occurrence', '净', V)).toBe(-30);
    /* 借方向钳 0：明细侧发生额为负 → 记 0 */
    expect(accountAmount('occurrence', '借', V)).toBe(0);
  });
});
