/**
 * 采购订单的**可选项判据**（纯函数，无 React 依赖）。
 *
 * ## 为什么需要它
 *
 * F4X-7 规定「采购订单必须关联**已批准**的采购申请，且**一申请一有效订单**」。
 * 服务端在 `PurService.createOrder` 里实现并加了行锁
 * （`pur.service.ts:385-419`：先 `for('update')` 锁申请行，再校验
 * `status === 'approved'`，再查有无 `status !== 'cancelled'` 的关联订单）。
 *
 * 客户端此前**完全没有**这层：创建弹窗既不显示「关联采购申请」，
 * 提交的 DTO 也不含 `requestId` —— 于是每次创建都被服务端 400 拒绝
 * （DTP 的 `requestId` 是 `@IsOptional()`，校验层放行，到了 service 才炸）。
 *
 * ## 这里是**提示**，不是权威
 *
 * 权威判据始终在服务端，且带行锁。本模块只回答"下拉里该列出哪些申请"，
 * 目的是不让使用者选到一个**提交必然失败**的项。并发下仍可能选到刚被
 * 他人占用的申请 —— 那时服务端会给出准确报错（「已生成订单，请勿重复下单」），
 * 而不会写坏数据。**不要把本函数当成并发安全的判据使用。**
 *
 * ## 判据与服务端逐条对齐
 *
 * | 服务端 | 本模块 |
 * |---|---|
 * | 申请必须存在 | 由下拉只列已取到的数据保证 |
 * | `status === 'approved'` | `isOrderableRequest` 的第一条 |
 * | 不存在 `status !== 'cancelled'` 的关联订单 | 第二条（注意：**已取消订单不占用**申请） |
 */

/** 只取需要的字段，避免与契约耦合过紧（便于在规格里构造最小对象） */
export interface OrderableRequestLike {
  id: string;
  status: string;
}

export interface OrderLike {
  requestId: string | null;
  status: string;
}

/**
 * 该采购申请是否**尚未被有效订单占用**。
 *
 * ⚠️ 关键细节：**已取消（`cancelled`）的订单不算占用** —— 这是服务端
 * `ne(purOrder.status, 'cancelled')` 的语义，也是业务上必须的：
 * 申请人撤单后应当能重新下单。若这里写成"存在任何关联订单即占用"，
 * 那么取消订单后该申请将**永远无法再下单**（下拉里选不到，服务端也过不去）。
 */
export function isRequestFree(
  requestId: string,
  orders: ReadonlyArray<OrderLike> | null | undefined,
): boolean {
  return !(orders ?? []).some(
    (o) => o.requestId === requestId && o.status !== 'cancelled',
  );
}

/** 下拉选项用的最小结构（`label` 直接给使用者看） */
export interface OrderableRequestOption {
  id: string;
  label: string;
}

/**
 * 「关联采购申请」下拉的选项列表。
 *
 * 入参 `requests` 已是服务端按 `status=approved` 过滤后的结果，
 * 这里仍再判一次 `status === 'approved'`：防止调用方忘了传筛选参数时
 * 静默列出未批准的申请（那样又变成"选得到但必然失败"）。
 *
 * `label` 取 `编号 - 品名/标题`，与仓内其它关联下拉（如
 * `VendorSettlementDialog` 的供应商选项）保持同一写法。
 */
export function orderableRequestOptions(
  requests: ReadonlyArray<{ id: string; code: string; title: string; status: string }> | null | undefined,
  orders: ReadonlyArray<OrderLike> | null | undefined,
): OrderableRequestOption[] {
  return (requests ?? [])
    .filter((r) => r.status === 'approved' && isRequestFree(r.id, orders))
    .map((r) => ({ id: r.id, label: `${r.code} - ${r.title}` }));
}
