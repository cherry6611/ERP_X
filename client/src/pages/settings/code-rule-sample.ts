/**
 * 编号规则的**示例预览**（纯函数，可单测）。
 *
 * ## 为什么会有这个模块 —— 修一个"永远空白"的列
 *
 * 「设置 → 字典」页的编号规则表里有一列「示例」，其列定义为
 * `{ title: '示例', dataIndex: 'sample' }`。但 `sample` 这个字段
 * **在契约里不存在**（`CodeRuleItem` 只有 `bizType/bizName/prefix/datePattern/
 * seqLength/resetPolicy/allowReuse/enabled/remark`），服务端
 * `toCodeRule()` 也从不产出它 —— 于是 antd 读到 `record.sample === undefined`，
 * **每一行都是空的**（连 `-` 都没有，是整格空白）。
 *
 * 为什么静态检查没拦住：antd 的 `DataIndex<T>` 里含
 * `SpecialString<T> = T | (string & {})`，任意字符串都能通过类型检查，
 * 所以 `dataIndex` 写错字段名 `tsc` **完全不报错**（这也是本轮把
 * 同一张表里 `dataIndex: 'name'` 改成 `'bizName'` 的原因 —— 同一类错误）。
 *
 * ## 为什么在客户端按规则推算，而不是让服务端下发
 *
 * 示例的含义是"按当前规则，下一个编号长什么样"，它由
 * `prefix + 日期段 + 流水位数` 三件事**完全决定**，而这三件事都已经在
 * `CodeRuleItem` 里。因此可以纯函数推算，无需新契约字段、无需改服务端、
 * 也不必真的分配一个流水号（那会污染序号表 —— 预览绝不能消耗编号）。
 *
 * ⚠️ **必须与服务端 `generateBizCode` 的构成保持一致**
 * （`server/common/utils/biz-code.ts`）：
 *   `bucketKey = prefix + buildDateSegment(datePattern, now)`
 *   返回值   = `bucketKey + String(seq).padStart(seqLength, '0')`
 * 其中 `buildDateSegment`：`NONE` → `''`；`YYYY` → `2026`；`YYYYMM` → `202610`。
 *
 * 预览用 `0001` 作为流水占位（而不是去查下一个真实序号）：示例是**说明性**的，
 * 查真实序号会随每次查看变化，反而让人以为规则在变；且查询序号表有副作用风险。
 */
import { todayIsoAt } from '@client/src/utils/format';

/** 与 `CodeRuleItem` 的对应字段同构（只取推算示例所需的最小集） */
export interface CodeRuleSampleInput {
  prefix: string;
  datePattern: 'YYYYMM' | 'YYYY' | 'NONE';
  seqLength: number;
}

/**
 * 日期段 —— 逐字对齐服务端 `buildDateSegment`。
 *
 * 时区必须是**业务时区**（Asia/Shanghai）：服务端 `shanghaiYearMonth(now)`
 * 取的就是业务时区的年月，若这里用本地年月，跨月/跨年的那几个小时里
 * 预览会与服务端实际生成的编号**不一致**（这正是本轮其它地方修过的
 * 时区类缺陷）。因此复用 `todayIsoAt`（已锚定 Asia/Shanghai）而不是
 * `new Date().getMonth()`。
 */
export function dateSegmentFor(
  pattern: CodeRuleSampleInput['datePattern'],
  now: Date,
): string {
  if (pattern === 'NONE') return '';
  const iso = todayIsoAt(now);
  const year = iso.slice(0, 4);
  if (pattern === 'YYYY') return year;
  return `${year}${iso.slice(5, 7)}`;
}

/** 预览用的流水占位（示例不该依赖真实序号，见文件头） */
export const SAMPLE_SEQ_PLACEHOLDER = 1;

/**
 * 生成一条示例编号。
 *
 * `seqLength` 非法（非正数/非整数/NaN）时按服务端默认 4 位处理 ——
 * 宁可给出一个合理示例，也不要渲染出 `undefined` 或空串；
 * 但**不**在这里抛错：这是一个展示列，不应因数据脏而让整页崩掉。
 */
export function codeRuleSample(
  rule: CodeRuleSampleInput,
  now: Date = new Date(),
): string {
  const prefix = rule.prefix ?? '';
  const rawLength = Number(rule.seqLength);
  const seqLength =
    Number.isInteger(rawLength) && rawLength > 0 ? rawLength : 4;
  const seq = String(SAMPLE_SEQ_PLACEHOLDER).padStart(seqLength, '0');
  return `${prefix}${dateSegmentFor(rule.datePattern, now)}${seq}`;
}
