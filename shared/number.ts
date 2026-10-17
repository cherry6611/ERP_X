/**
 * 金额取整的唯一实现（前后端共用，放在 `shared` 是因为 `shared/tax.ts` 也要用，
 * 而 `shared` 不能反向依赖 `server`）。
 *
 * ## 为什么要自己实现，而不是 `Math.round(v * 100) / 100`
 *
 * 全仓原先有 **9 份** `round2`，且分成两种互不一致的写法：
 *   A. `Math.round(v * 100) / 100`
 *   B. `Math.round((v + Number.EPSILON) * 100) / 100`
 *
 * 两种都有问题：
 *
 * 1. **二进制浮点导致会计口径反转**。十进制的 1.005 在 IEEE-754 下实际是
 *    1.00499999999999989，`v * 100 = 100.49999999999999`，`Math.round` 得 100 → **1.00**，
 *    而会计上的「四舍五入」应为 **1.01**。B 写法加 EPSILON 能把正数补回 1.01。
 *
 * 2. **负数（红冲）方向不对称 —— 这是真正的账务缺陷**。
 *    `Math.round` 是「向 +∞ 取整」（`Math.round(-0.5) === -0`），不是会计要求的
 *    「远离零取整」。实测：
 *
 *    ```
 *    A: round2(2.675) = 2.68    round2(-2.675) = -2.67   合计 = 0.01  ← 不平
 *    B: round2(1.005) = 1.01    round2(-1.005) = -1.00   合计 = 0.01  ← 不平
 *    ```
 *
 *    红冲凭证的金额就是原凭证的相反数，一旦两者取整方向不同，
 *    「原凭证 + 红冲凭证」的合计不为 0，借贷凭空差出 0.01 —— 且不会报错。
 *
 * 因此本实现改为**先转十进制字符串、再按十进制位四舍五入（远离零）**，
 * 保证 `round2(x) + round2(-x) === 0` 恒成立，且符合会计口径。
 *
 * ## 不静默归零
 * 非有限数（NaN / Infinity）**原样返回**，不转成 0。静默把垃圾值变 0
 * 会让错误数据在报表上完全看不出来（本项目财税纪律：要件缺失不得静默按 0）。
 */
export function round2(value: number): number {
  // NaN / Infinity 原样传递：让问题在调用点暴露，而不是被抹平成 0
  if (typeof value !== 'number' || !Number.isFinite(value)) return value;
  if (value === 0) return 0;

  const negative = value < 0;
  const fixed = Math.abs(value).toFixed(10);

  // 极大数（≥1e21）toFixed 会返回指数记数法，此时字符串路径不可用，
  // 退化为纯算术取整（该量级已超出金额合理范围，不影响会计口径）
  if (fixed.includes('e') || fixed.includes('E')) {
    const scaled = Math.abs(value) * 100;
    return (negative ? -1 : 1) * (Math.round(scaled) / 100);
  }

  const dot = fixed.indexOf('.');
  let intPart = dot === -1 ? fixed : fixed.slice(0, dot);
  const frac = dot === -1 ? '' : fixed.slice(dot + 1);

  const keep = frac.slice(0, 2).padEnd(2, '0');
  const nextDigit = frac.charAt(2);

  let kept = keep;
  if (nextDigit !== '' && Number(nextDigit) >= 5) {
    const digits = kept.split('');
    let i = digits.length - 1;
    let carryToInt = false;
    while (i >= 0) {
      if (digits[i] === '9') {
        digits[i] = '0';
        i -= 1;
      } else {
        digits[i] = String(Number(digits[i]) + 1);
        break;
      }
    }
    if (i < 0) carryToInt = true;
    kept = digits.join('');
    if (carryToInt) intPart = (BigInt(intPart) + 1n).toString();
  }

  const result = Number(`${intPart}.${kept}`);
  return negative ? -result : result;
}
