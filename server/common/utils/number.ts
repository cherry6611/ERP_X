/**
 * 数值工具：全仓金额取整的唯一入口。
 *
 * 实现放在 `shared/number.ts`（前后端共用，`shared/tax.ts` 也依赖它），
 * 这里只做再导出 —— 目的是**消除历史上散落在 9 个文件里的重复 round2**。
 * 那些重复实现分成两种互不一致的写法（有无 `Number.EPSILON`），
 * 且都对负数（红冲）取整方向不对称，导致「原凭证 + 红冲凭证」合计不为 0。
 *
 * 详见 `shared/number.ts` 的口径说明。新增代码请统一从此处 import，
 * 不要再写 `Math.round(x * 100) / 100`。
 */
export { round2 } from '@shared/number';
