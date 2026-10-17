/**
 * 退货页的纯格式化函数（§5.9 / F8）。
 *
 * `money` 原先定义在 `ReturnsPage.tsx` 顶部。`新建采购退货` 弹窗搬到
 * `./PurchaseReturnCreateDialog.tsx` 后两边都要用它（列表金额、指标卡、可退数量区
 * 的含税单价），故移到这里由两边导入 —— 纯函数独立成模块后即可被单测
 * （见 `returns-format.spec.ts`）。
 *
 * ⚠️ 它与 `utils/format.ts` 的 `formatMoney` **不是同一个东西**：后者是
 * `style: 'currency'`（带货币符号），本函数只出金额数字与千分位 —— 表格列与
 * 指标卡的单位在表头/标签里，换成 `formatMoney` 会让每个数字多一个可见符号。
 */

export function money(value: number): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}
