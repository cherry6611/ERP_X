/**
 * `check:numeric-precision` 第二道（取整口径门禁）的规格。
 *
 * ## 为什么要给一个"检查脚本"写测试
 *
 * 因为它**坏过一次且没有任何征兆**：我第一版用 `[^()]*` 跳过中间部分，
 * 于是 `Math.round((gross - netAmount) * 100) / 100` 这种**带内层括号的
 * 真实违规全部漏报** —— 而漏报的门禁比没有门禁更糟：它给出"全仓干净"的结论。
 * 我是在"故意植入一处违规看它会不会拦"时才发现的（当时它没拦）。
 *
 * 所以这里把三件事钉住：
 *   ① 带内层括号的违规**必须命中**（第一版就是漏在这里）；
 *   ② 不带括号的简单形态**必须命中**；
 *   ③ **注释里引用该写法不得误报** —— 本仓大量注释在解释"原先这里自带一份
 *      `Math.round(x*100)/100`"（`number.ts`、`payroll-engine.ts`、
 *      `return.service.ts` 等）。不剥注释的话门禁会被自己的文档打爆。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts', 'check-numeric-precision.mjs');
const src = readFileSync(SCRIPT, 'utf8');

/** 从门禁脚本里取出它实际使用的正则（避免这里复制一份而与实现漂移） */
function gatePattern(): RegExp {
  const m = /const PATTERN = (\/[\s\S]*?\/);/.exec(src);
  if (!m) throw new Error('未能从 check-numeric-precision.mjs 取到 PATTERN —— 门禁实现已改名？');
  // eslint-disable-next-line no-eval -- 仅用于在测试里复用门禁自己的正则字面量
  return eval(m[1]) as RegExp;
}

/** 复刻门禁的"剥注释"步骤（保持行号） */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (mm) => mm.replace(/[^\n]/g, ' '))
    .split(/\r?\n/)
    .map((line) => (/^\s*(\/\/|\*)/.test(line) ? ' '.repeat(line.length) : line))
    .join('\n');
}

const offendersOf = (text: string) => {
  const re = gatePattern();
  return stripComments(text)
    .split(/\r?\n/)
    .filter((line) => re.test(line));
};

describe('取整口径门禁的正则', () => {
  it('门禁脚本里确实有 PATTERN（防止实现改名后本 spec 静默失效）', () => {
    expect(() => gatePattern()).not.toThrow();
  });

  it('⚠️ 带内层括号的违规必须命中（第一版用 [^()]* 时全部漏报）', () => {
    expect(offendersOf('const x = Math.round((gross - netAmount) * 100) / 100;')).toHaveLength(1);
    expect(offendersOf('const x = Math.round((orderedAmount + amount) * 100) / 100;')).toHaveLength(1);
    expect(offendersOf('netValue = Math.round((netValue - d.amount) * 100) / 100;')).toHaveLength(1);
  });

  it('不带括号的简单形态必须命中', () => {
    expect(offendersOf('return String(Math.round(product * 100) / 100);')).toHaveLength(1);
    expect(offendersOf('const v = Math.round(value * 100) / 100;')).toHaveLength(1);
  });

  it('写法有空格/换行差异也要命中', () => {
    expect(offendersOf('Math.round( x  *  100 )  /  100')).toHaveLength(1);
  });

  it('⚠️ 注释里引用该写法**不得误报**（本仓大量注释在解释它）', () => {
    const commentOnly = [
      '/**',
      ' * 不要再写 `Math.round(x * 100) / 100`。',
      ' * 本引擎历史上自带一份 `Math.round(n * 100) / 100`，对负数取整不对称。',
      ' */',
      '// 统一走 round2：本地 `Math.round(x*100)/100` 对负数量（红冲）取整不对称',
    ].join('\n');
    expect(offendersOf(commentOnly)).toHaveLength(0);
  });

  it('正确写法（round2）不得误报', () => {
    expect(offendersOf('const withheldTotal = round2(gross - netAmount);')).toHaveLength(0);
    expect(offendersOf('const cumulative = round2(orderedAmount + amount);')).toHaveLength(0);
  });

  it('只取整到 1 位或 3 位不算违规（本门禁只管"自行取整到 2 位"）', () => {
    expect(offendersOf('Math.round(x * 10) / 10')).toHaveLength(0);
    expect(offendersOf('Math.round(x * 1000) / 1000')).toHaveLength(0);
  });

  it('注释与违规在同一文件时，只报违规那一行', () => {
    const mixed = [
      '/** 不要再写 `Math.round(x * 100) / 100`。 */',
      'const bad = Math.round((a + b) * 100) / 100;',
      'const good = round2(a + b);',
    ].join('\n');
    const found = offendersOf(mixed);
    expect(found).toHaveLength(1);
    expect(found[0]).toContain('const bad');
  });
});
