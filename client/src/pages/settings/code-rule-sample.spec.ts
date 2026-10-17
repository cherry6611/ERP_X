import { codeRuleSample, dateSegmentFor, SAMPLE_SEQ_PLACEHOLDER } from './code-rule-sample';

/**
 * 规格锚定服务端 `generateBizCode` 的构成
 * （`server/common/utils/biz-code.ts`）：
 *   `prefix + buildDateSegment(datePattern, now) + String(seq).padStart(seqLength,'0')`
 *
 * 并且**日期段必须按业务时区（Asia/Shanghai）**取年月 ——
 * 服务端 `shanghaiYearMonth(now)` 就是这么取的。
 */

/** 业务时区 2026-10-16 08:00（= UTC 00:00） */
const AT_SHANGHAI_MORNING = new Date('2026-10-16T00:00:00.000Z');
/** 业务时区 2026-10-16 00:30 —— 对应 UTC 前一天 16:30 */
const AT_SHANGHAI_MIDNIGHT = new Date('2026-10-15T16:30:00.000Z');
/** 跨年边界：业务时区 2027-01-01 00:30 = UTC 2026-12-31T16:30 */
const AT_SHANGHAI_NEW_YEAR = new Date('2026-12-31T16:30:00.000Z');

describe('dateSegmentFor：三种日期段', () => {
  it('NONE → 空串（编号不含日期）', () => {
    expect(dateSegmentFor('NONE', AT_SHANGHAI_MORNING)).toBe('');
  });

  it('YYYY → 四位年', () => {
    expect(dateSegmentFor('YYYY', AT_SHANGHAI_MORNING)).toBe('2026');
  });

  it('YYYYMM → 年 + 两位月', () => {
    expect(dateSegmentFor('YYYYMM', AT_SHANGHAI_MORNING)).toBe('202610');
  });

  it('⚠️ 按业务时区取年月，不是本地时区', () => {
    /*
     * 这条是本文件最重要的断言。UTC 2026-10-15T16:30 在**上海**已是
     * 10-16 00:30，而在 UTC 还是 10-15。若实现写成 `now.getMonth()`/
     * `getFullYear()`（本地时区），在 UTC 环境下会得到 09 月与 2026，
     * 与上海口径一致时才是 202610。
     *
     * 服务端 `shanghaiYearMonth(now)` 用的是业务时区，所以预览
     * 必须与它一致，否则跨月/跨年那几个小时里预览与实际编号不符。
     */
    expect(dateSegmentFor('YYYYMM', AT_SHANGHAI_MIDNIGHT)).toBe('202610');
    expect(dateSegmentFor('YYYY', AT_SHANGHAI_MIDNIGHT)).toBe('2026');
  });

  it('⚠️ 跨年边界同样按业务时区', () => {
    /*
     * UTC 2026-12-31T16:30 = 上海 2027-01-01 00:30 → 应为 2027 / 202701。
     * 本地时区实现（UTC）会给出 2026 / 202612。
     */
    expect(dateSegmentFor('YYYY', AT_SHANGHAI_NEW_YEAR)).toBe('2027');
    expect(dateSegmentFor('YYYYMM', AT_SHANGHAI_NEW_YEAR)).toBe('202701');
  });
});

describe('codeRuleSample：整条示例编号', () => {
  it('拼装顺序与服务端一致：前缀 + 日期段 + 补零流水', () => {
    expect(
      codeRuleSample(
        { prefix: 'CTR', datePattern: 'YYYYMM', seqLength: 4 },
        AT_SHANGHAI_MORNING,
      ),
    ).toBe('CTR2026100001');
  });

  it('seqLength 决定补零位数', () => {
    const at = AT_SHANGHAI_MORNING;
    expect(codeRuleSample({ prefix: 'PO', datePattern: 'YYYY', seqLength: 2 }, at)).toBe('PO202601');
    expect(codeRuleSample({ prefix: 'PO', datePattern: 'NONE', seqLength: 6 }, at)).toBe('PO000001');
  });

  it('NONE 日期段下编号不含年月', () => {
    expect(
      codeRuleSample({ prefix: 'INV', datePattern: 'NONE', seqLength: 4 }, AT_SHANGHAI_MORNING),
    ).toBe('INV0001');
  });

  it('流水占位固定为 1（示例不消耗真实序号，也不随查看变化）', () => {
    /*
     * 这两条一起表达"示例是稳定的"：同一个规则在**同一天**的任何时刻
     * 都必须给出同一个示例。若有人把实现改成去查下一个真实序号，
     * 这个断言不会拦住（仍是 0001），但会消耗序号表 —— 因此这条
     * 断言的用意是记录"为什么固定用它"，配合 SAMPLE_SEQ_PLACEHOLDER 常量。
     */
    expect(SAMPLE_SEQ_PLACEHOLDER).toBe(1);
    const at = AT_SHANGHAI_MORNING;
    const a = codeRuleSample({ prefix: 'CTR', datePattern: 'YYYYMM', seqLength: 4 }, at);
    const later = new Date('2026-10-16T09:00:00.000Z');
    const b = codeRuleSample({ prefix: 'CTR', datePattern: 'YYYYMM', seqLength: 4 }, later);
    expect(a).toBe(b);
  });

  it('seqLength 非法时回落到 4 位，而不是渲染出 undefined/空串', () => {
    /*
     * 这是展示列，宁可给一个合理示例也不能让整页显示 `undefined`。
     * 注意 `String(1).padStart(NaN, '0')` 会得到 '1' 而不是 '0001'，
     * 所以必须显式兜底 —— 这条断言正是钉住那个行为。
     */
    const at = AT_SHANGHAI_MORNING;
    expect(codeRuleSample({ prefix: 'X', datePattern: 'NONE', seqLength: Number.NaN }, at)).toBe('X0001');
    expect(codeRuleSample({ prefix: 'X', datePattern: 'NONE', seqLength: 0 }, at)).toBe('X0001');
    expect(codeRuleSample({ prefix: 'X', datePattern: 'NONE', seqLength: -3 }, at)).toBe('X0001');
    expect(codeRuleSample({ prefix: 'X', datePattern: 'NONE', seqLength: 2.5 }, at)).toBe('X0001');
  });

  it('prefix 为空串时不报错（拼出纯日期段 + 流水）', () => {
    expect(codeRuleSample({ prefix: '', datePattern: 'YYYYMM', seqLength: 3 }, AT_SHANGHAI_MORNING)).toBe('202610001');
  });
});
