/**
 * 项目预算基线判定。金额按分比较，避免把 numeric 转成 float 后再相加。
 * 预算小于等于 0 视为尚未设置基线，拒绝带项目的费用，并要求先去项目上填写。
 */
export function moneyToCents(value: string | number | null | undefined): bigint {
  if (value == null || value === '') return 0n;
  const text = String(value).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) return 0n;
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, frac = ''] = unsigned.split('.');
  const cents = BigInt(whole || '0') * 100n + BigInt((frac + '00').slice(0, 2));
  return negative ? -cents : cents;
}

export function centsToYuan(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

export function decideProjectBaseline(input: {
  projectExists: boolean;
  budget: string | null;
  occupied: string;
  amount: string;
}): { ok: true } | { ok: false; reason: string } {
  if (!input.projectExists) return { ok: true };
  const budget = moneyToCents(input.budget);
  const occupied = moneyToCents(input.occupied);
  const amount = moneyToCents(input.amount);
  if (budget <= 0n) {
    return {
      ok: false,
      reason: '项目预算基线为 0 元，请先在项目上填写大于 0 的预算后再提交费用',
    };
  }
  const next = occupied + amount;
  if (next > budget) {
    return {
      ok: false,
      reason:
        `超出项目预算基线：项目预算 ${centsToYuan(budget)} 元，` +
        `已占用 ${centsToYuan(occupied)} 元，本次 ${centsToYuan(amount)} 元`,
    };
  }
  return { ok: true };
}
