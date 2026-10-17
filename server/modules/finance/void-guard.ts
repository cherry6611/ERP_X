/**
 * 作废单据的付款/核销可用性判定（B1 作废路径的**收尾守卫**）。
 *
 * ## 为什么这不是"把 if 搬个位置"，而是必须独立成模块
 *
 * B1 给应收/应付/发票加了作废路径，服务端会写 `status='voided'`。但作废路径
 * 落地时**没有同步收紧下游入口**，于是作废单据仍可被付款/核销；更糟的是
 * 核销末尾的状态重算会把 `'voided'` **覆盖成 `'paid'`/`'partial'`** ——
 * 已作废（且已开具冲回凭证）的单据被"复活"，而冲回凭证还挂在账上。
 *
 * 三处守卫原先都是**事务体内部的内联 `if`**，形如：
 *
 * ```
 * if (单据.status === 'voided') → 抛出「XX 已作废，不可 YY」
 * ```
 *
 * （原文是一行 `throw` 语句；此处刻意不写完整的 `throw … Exception(…)` 形态 ——
 * `scripts/audit-error-messages.mjs` 用正则扫**原始源码**（不剥注释），
 * 注释里出现该形态会被它当成真实抛错并因"消息不含中文"而失败。实测踩过一次。）
 *
 * 这带来两个具体问题：
 *   ① **无法测**：要触达它必须建库、开事务、造单据。而它守的是"钱能不能进来"，
 *      恰恰最该有回归测试 —— 三处守卫是同一轮里补的，将来任何一处被
 *      重构掉都不会有测试变红；
 *   ② **口径会漂**：三处各写一遍，文案与判据都可能分叉（本项目已多次发生
 *      "同一口径三处各写一遍，其中一处漏了" —— 见 `opening-cash.ts` 的文件头）。
 *
 * 抽成本模块后，判据是**纯函数**，规格可以直接喂各种状态组合；
 * 三个调用点共用同一份判据与同一份中文文案。
 *
 * ## 判据为什么是"白名单"而不是"黑名单"
 *
 * 直觉写法是 `status !== 'voided'`（黑名单）。这里用**白名单**
 * （`pending` / `approved` / `partial` / `paid` 才放行）：
 *
 * · 作废状态的集合**将来还会增加**（例如 `rejected`、`cancelled`、
 *   `superseded`），黑名单每加一个都要回来改三处；
 * · 白名单的失效方向是**安全**的 —— 新增一个未知状态时它会**拒绝**，
 *   而不是默默放行一笔已经不该发生的付款。
 *
 * 这与 `shared/rbac.ts` 的 `hasCapability`（无 `_default` 即拒绝）是同一思路：
 * 权限与资金两个领域都不能 fail-open。
 *
 * ⚠️ **注意状态集合的差异**：应收（`ArStatus`）与应付（`ApStatus`）的
 * 可付状态并不完全相同 —— 应收有 `settled`（已核销完毕）没有 `paid`，
 * 应付有 `paid`（已付清）没有 `settled`。所以下面用两个常量分别表达，
 * 而不是合并成一个"通用可付状态"（合并会把一边的语义塞进另一边）。
 */

/**
 * 允许**登记付款/回款**的应付状态。
 *
 * 语义：这些状态下单据仍有未结余额、且未被作废。
 * · `pending`  —— 待付款（新建应付的初始态）
 * · `approved` —— 已批准（等待付款）
 * · `partial`  —— 部分付款（还有余额）
 * · `paid`     —— 已付清。**仍放行**是有意的：`createPayment` 本身会按
 *   `amount − 已占用` 校验余额并抛出"超过可付余额"，由余额规则给出
 *   更准确的中文报错；把 `paid` 也放进白名单是为了让"为什么不能付"
 *   由余额口径回答，而不是让状态守卫抢答一句笼统的话。
 */
export const PAYABLE_AP_STATUSES: ReadonlyArray<string> = [
  'pending',
  'approved',
  'partial',
  'paid',
];

/** 允许**核销**的应收状态（同 `PAYABLE_AP_STATUSES` 的思路；`settled` 由余额校验拦） */
export const WRITEOFFABLE_AR_STATUSES: ReadonlyArray<string> = [
  'open',
  'partial',
  'settled',
];

/** 允许**核销**的应付状态 */
export const WRITEOFFABLE_AP_STATUSES: ReadonlyArray<string> = [
  'pending',
  'approved',
  'partial',
  'paid',
];

/**
 * 该状态下是否允许对这张单据**登记付款/付款核销**。
 *
 * @param status     单据当前状态（来自事务内 `FOR UPDATE` 读到的那一行，
 *                   因此不会受客户端过期数据影响）
 * @param allowed    该单据类型允许的状态白名单
 * @param actionName 用于报错文案的动作名，如 `'登记付款'` / `'核销'`
 * @param docName    用于报错文案的单据名，如 `'应付'` / `'应收'`
 * @returns 不允许时返回可直接抛出的**中文报错文案**；允许时返回 `null`
 *
 * 返回文案而不是抛异常，是为了让本模块保持**零依赖的纯函数**
 * （不 import Nest 的 `BadRequestException`），从而能被 jest 直接加载 ——
 * 与 `ledger-export-columns.ts` 同一手法。
 */
export function blockedReasonForWriteAction(
  status: string | null | undefined,
  allowed: ReadonlyArray<string>,
  actionName: string,
  docName: string,
): string | null {
  if (status && allowed.includes(status)) return null;
  /*
   * 作废是最常见的拦截原因，给出**具体**文案；其余未知状态给通用文案。
   * 分开写是为了让使用者/排障者一眼看出"这张单被作废了"，
   * 而不是看到一句"当前状态不可操作"却不知道状态是什么。
   */
  if (status === 'voided') {
    return `${docName}已作废，不可${actionName}`;
  }
  return `${docName}当前状态不可${actionName}`;
}
