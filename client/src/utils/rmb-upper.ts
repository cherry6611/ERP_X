/**
 * C-06：金额大写转换（人民币）——前端镜像实现。
 *
 * 服务端权威实现见 `server/common/utils/rmb-upper.ts`（A-12 验收标准③）。
 * 前端无法 import server 目录（构建边界），故按同一套规则镜像一份；
 * **任何规则改动都必须两边同步**，否则报表（服务端组包）与单据（前端组包）
 * 打印出来的大写金额会不一致。
 *
 * 规则依据《正确填写票据和结算凭证的基本规定》：
 *   - 中文大写数字：零壹贰叁肆伍陆柒捌玖；
 *   - 数位：拾佰仟万亿（万、亿为节权位）；
 *   - 元后无角分 → 加「整」；有角无分 → 「X元X角整」；有分 → 「X元X角X分」；
 *   - 角位为 0 而分位不为 0 时，元后必须写「零」（例：0.05 → 零元零伍分）；
 *   - 阿拉伯数字中间有 0 时写「零」，连续多个 0 只写一个「零」；
 *   - 万位/亿位是 0 但下级有数字时，需保留「零」（例：1000000 → 壹佰万元整）。
 */

const DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'] as const;
/** 节内权位（个、拾、佰、仟） */
const UNITS = ['', '拾', '佰', '仟'] as const;
/** 节权位（个、万、亿、万亿） */
const SECTION_UNITS = ['', '万', '亿', '万亿'] as const;

/**
 * 金额上限：小于 10 万亿元。
 * 换算到「分」后必须落在 `Number.MAX_SAFE_INTEGER`（≈9.007e15）内，
 * 否则 `Math.round(amount * 100)` 会丢精度，大写与金额不一致。
 */
const MAX_AMOUNT = 1e13;

export class RmbUpperError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RmbUpperError';
  }
}

/** 把 0~9999 的整数转成中文（不含节权位），个位为 0 时按内部规则保留「零」 */
function sectionToChinese(section: number): string {
  let out = '';
  let zeroPending = false;
  let unitIndex = 0;
  let rest = section;
  while (rest > 0) {
    const digit = rest % 10;
    if (digit === 0) {
      // 连续 0 只记一次；且只有后面还有非 0 位时才需要补「零」
      if (out !== '') zeroPending = true;
    } else {
      if (zeroPending) {
        out = `${DIGITS[0]}${out}`;
        zeroPending = false;
      }
      out = `${DIGITS[digit]}${UNITS[unitIndex]}${out}`;
    }
    rest = Math.floor(rest / 10);
    unitIndex += 1;
  }
  return out;
}

/** 非负整数 → 中文大写（含 万/亿 节权位与节间补零） */
function integerToChinese(value: number): string {
  if (value === 0) return DIGITS[0];
  const sections: number[] = [];
  let rest = value;
  while (rest > 0) {
    sections.push(rest % 10000);
    rest = Math.floor(rest / 10000);
  }
  let out = '';
  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index];
    if (section === 0) {
      // 整节为 0：只有当后面还有非 0 节、且当前输出不是以「零」结尾时才补一个「零」
      const hasLower = sections.slice(0, index).some((item) => item > 0);
      if (hasLower && out !== '' && !out.endsWith(DIGITS[0])) out += DIGITS[0];
      continue;
    }
    // 高位节内不足 4 位（如 1_0000 的「1」）时，需在节内补前导零
    const sectionText = sectionToChinese(section);
    const needsLeadingZero =
      out !== '' && section < 1000 && !out.endsWith(DIGITS[0]) && index < sections.length - 1;
    out += `${needsLeadingZero ? DIGITS[0] : ''}${sectionText}${SECTION_UNITS[index]}`;
  }
  return out;
}

/**
 * 金额（元）→ 人民币大写。
 *
 * @param amount 金额，允许 number / 数字字符串 / 负数；按**四舍五入到分**处理
 * @returns 例：`1234.56` → `壹仟贰佰叁拾肆元伍角陆分`；
 *          `100.00` → `壹佰元整`；`0.05` → `零元零伍分`；`1000000` → `壹佰万元整`
 */
export function toRmbUpper(amount: number | string): string {
  const raw = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(raw)) {
    throw new RmbUpperError(`金额不是有效数字：${String(amount)}`);
  }
  if (Math.abs(raw) >= MAX_AMOUNT) {
    throw new RmbUpperError(`金额超出可转换范围（需小于 10 万亿元）：${String(amount)}`);
  }
  const negative = raw < 0;
  // 先四舍五入到分，并补偿 IEEE754 表示误差（1.005 的双精度值略小于 1.005）
  const scaled = Math.abs(raw) * 100;
  const cents = Math.round(scaled + Number.EPSILON * scaled);
  const yuan = Math.floor(cents / 100);
  const jiao = Math.floor((cents % 100) / 10);
  const fen = cents % 10;

  let out = `${integerToChinese(yuan)}元`;
  if (jiao === 0 && fen === 0) {
    out += '整';
  } else if (fen === 0) {
    out += `${DIGITS[jiao]}角整`;
  } else if (jiao === 0) {
    // 角位为 0 而分位不为 0：元后必须写「零」（如 0.05 → 零元零伍分）
    out += `${DIGITS[0]}${DIGITS[fen]}分`;
  } else {
    out += `${DIGITS[jiao]}角${DIGITS[fen]}分`;
  }
  return negative ? `负${out}` : out;
}

/**
 * 打印场景的容错包装：金额缺失/非法时返回空串而不是抛错。
 *
 * 打印一个页面上往往有多个合计，其中任一个金额脏数据不应让整页白屏；
 * 调用方拿到空串时会显示 `—`，比抛异常更符合"能打出来但提示异常"的预期。
 */
export function toRmbUpperSafe(amount: number | string | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return '';
  const numeric = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(numeric)) return '';
  try {
    return toRmbUpper(numeric);
  } catch {
    return '';
  }
}
