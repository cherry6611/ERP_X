import {
  isRequestFree,
  orderableRequestOptions,
  type OrderLike,
} from './pur-order-rules';

/**
 * 规格对齐的是**服务端** F4X-7 判据（`server/modules/pur/pur.service.ts:385-419`）：
 *   · 申请必须 `approved`；
 *   · 不存在 `status !== 'cancelled'` 的关联订单。
 */
const req = (id: string, status = 'approved', code = 'PR001', title = '办公用品') => ({
  id,
  code,
  title,
  status,
});

const order = (requestId: string | null, status = 'pending'): OrderLike => ({
  requestId,
  status,
});

describe('isRequestFree：已取消订单不占用申请', () => {
  it('无订单 → 空闲', () => {
    expect(isRequestFree('r1', [])).toBe(true);
    expect(isRequestFree('r1', null)).toBe(true);
    expect(isRequestFree('r1', undefined)).toBe(true);
  });

  it('存在 pending / accepted 的关联订单 → 被占用', () => {
    expect(isRequestFree('r1', [order('r1', 'pending')])).toBe(false);
    expect(isRequestFree('r1', [order('r1', 'accepted')])).toBe(false);
  });

  it('⚠️ 关联订单**已取消** → 仍空闲（否则撤单后永远无法重新下单）', () => {
    /*
     * 这条是本模块最容易被"顺手改错"的地方：服务端用的是
     * `ne(purOrder.status, 'cancelled')`，即取消的订单不占用申请。
     * 若有人简化成"有订单就占用"，业务上表现为：申请人取消订单后，
     * 该采购申请在下拉里消失、服务端也拒绝 —— 申请被永久锁死。
     */
    expect(isRequestFree('r1', [order('r1', 'cancelled')])).toBe(true);
  });

  it('只判断指定申请，且不把 null requestId 当成命中', () => {
    expect(isRequestFree('r1', [order('r2'), order(null)])).toBe(true);
  });
});

describe('orderableRequestOptions', () => {
  it('只列 approved 且未被占用的申请', () => {
    const requests = [
      req('r1', 'approved'),
      req('r2', 'approved'),
      req('r3', 'pending'),
      req('r4', 'rejected'),
    ];
    const orders = [order('r2', 'pending')];
    expect(orderableRequestOptions(requests, orders).map((o) => o.id)).toEqual(['r1']);
  });

  it('再次拒绝未批准的申请（防止调用方漏传 status 筛选）', () => {
    /*
     * 即使调用方把全部申请都传进来，也不能列出未批准的 —— 否则又回到
     * "选得到但提交必然 400"的形态（正是本次修复要消除的）。
     */
    expect(orderableRequestOptions([req('r1', 'draft')], []).length).toBe(0);
    expect(orderableRequestOptions([req('r1', 'submitted')], []).length).toBe(0);
    expect(orderableRequestOptions([req('r1', 'rejected')], []).length).toBe(0);
  });

  it('label 为「编号 - 品名」', () => {
    const opts = orderableRequestOptions([req('r1', 'approved', 'PR009', '差旅')], []);
    expect(opts).toEqual([{ id: 'r1', label: 'PR009 - 差旅' }]);
  });

  it('空/缺省入参返回空数组（首屏 loading 期间不得抛错）', () => {
    expect(orderableRequestOptions(null, null)).toEqual([]);
    expect(orderableRequestOptions(undefined, undefined)).toEqual([]);
    expect(orderableRequestOptions([], [])).toEqual([]);
  });
});
