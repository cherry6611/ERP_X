/**
 * `invoice-billable.ts` 规格 —— 合同可开金额口径。
 *
 * ## 这份规格守的是什么
 *
 * 可开金额 = 合同额 − **已开销项发票**合计。它决定「这张发票能不能开」，
 * 算错的两个方向代价不对称：
 *   · 算**大**了 → 允许超额开票（多开销项票，事后红冲，票账不符）；
 *   · 算**小**了 → 合法开票被误拒（用户看到"还有额度却开不出票"，且无提示指向原因）。
 *
 * 本仓实测踩过的是后者：求和缺 `direction` 过滤时，一张通过
 * `PATCH /api/finance/invoices/:id` 补上 `contractId` 的**进项**发票会吃掉销项额度。
 * 这里用 `CONTRACT_INVOICED_DIRECTION` 把"只算销项"这一判据钉死，
 * 并在最后一条用例里显式说明"进项票不进这个入参"这一调用约定。
 *
 * ## 断言强度
 *
 * 金额断言一律**精确值**（`toBe`）：金额错了就是真金白银出错，不留容差。
 */
import { CONTRACT_INVOICED_DIRECTION, computeBillable } from './invoice-billable';

describe('computeBillable（合同可开金额）', () => {
  it('无任何已开发票时可开金额 = 合同额', () => {
    expect(computeBillable(106000, [])).toBe(106000);
  });

  it('减去已开销项发票合计（含税口径）', () => {
    expect(computeBillable(106000, [31800, 10600])).toBe(63600);
  });

  it('红字发票（负数金额）回补可开额度', () => {
    // 31800 已开，其中 10600 开了红字 → 净已开 21200
    expect(computeBillable(106000, [31800, -10600])).toBe(84800);
  });

  it('已开超过合同额时返回负数（由调用方决定是否拒绝，不在这里夹到 0）', () => {
    expect(computeBillable(1000, [1200])).toBe(-200);
  });

  it('数字与字符串混用（PG numeric 经驱动回来是字符串）结果一致', () => {
    expect(computeBillable('106000.00', ['31800.00', 10600])).toBe(63600);
  });

  it('null / undefined / 非数字 一律按 0 计，不产生 NaN', () => {
    expect(computeBillable(null, [null, undefined, 'abc', 100])).toBe(-100);
    expect(computeBillable(undefined, [])).toBe(0);
  });

  it('分位取整与 splitTax 同源：0.005 级尾差不放大', () => {
    // 10600.005 的 6% 拆分后含税仍是 10600.01/10600.00 两级，
    // 这里只钉"合计按 2 位小数取整"这一条：三次 0.005 相加必须收敛到 0.02
    expect(computeBillable(100, [0.005, 0.005, 0.005])).toBe(99.98);
  });

  it('CONTRACT_INVOICED_DIRECTION 固定为 sales —— 进项发票不得进入入参', () => {
    expect(CONTRACT_INVOICED_DIRECTION).toBe('sales');
    /*
     * 调用约定（不是本函数的职责，但必须在这里说清）：
     * service 侧按 `contract_id + status='issued' + direction=sales` 取金额，
     * **不能**把进项发票的 amount 传进来。下面这条断言就是那个反例：
     * 若把进项票混进来，可开金额会被误扣。
     */
    const contractAmount = 106000;
    const salesOnly = [31800];
    const withPurchaseMixedIn = [31800, 5300];
    expect(computeBillable(contractAmount, salesOnly)).toBe(74200);
    expect(computeBillable(contractAmount, withPurchaseMixedIn)).toBe(68900);
  });
});
