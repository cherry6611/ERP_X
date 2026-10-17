/**
 * 结项闸门里与「结项摘要」有关的**纯判据**。
 *
 * ## 为什么单独成模块
 *
 * 原判据是 service 里的一行内联 `if`：
 *
 * ```
 * if (!closeDto?.closeSummary) { …抛"结项须填写结项摘要"… }
 * ```
 *
 * 它拦住了 `undefined` / `''`，**但拦不住一串空格** —— `'   '` 在 JS 里是真值。
 * 后果不是"数据不好看"：库里会落下一行 `close_summary = '   '`，
 * 而结项摘要会进入结项报告与飞书通知（`sendCloseReportNotification` 把它拼进正文），
 * 收到通知的人看到的是一段空白，而系统里**没有任何一处会报错**。
 * 这类"校验看起来在、其实漏一个取值"的判据必须能逐输入断言，
 * 否则下次改字段时又会以同样的方式漏掉 `\t` / `\n` / 全角空格。
 *
 * 判据抽在这里之后，service 只负责调用与抛错（与
 * `contracts/contract-update-guard.ts`、`finance/void-guard.ts` 同一手法：
 * **返回中文文案而不是抛异常**，使本模块零依赖、可被 jest 直接加载）。
 *
 * ⚠️ 本文件不写完整的抛错语句形态（哪怕是注释里）——
 * `scripts/audit-error-messages.mjs` 用正则扫未剥离注释的原文。
 */

/** 结项摘要缺失时的中文文案（service 与前端提示共用同一句） */
export const CLOSE_SUMMARY_REQUIRED_MESSAGE = '结项须填写结项摘要';

/**
 * 归一键控台传来的结项摘要。
 *
 * @returns 去空白后的摘要；`null` 表示**视为未填写**（`undefined` / `''` / 纯空白）
 */
export function normalizeCloseSummary(
  raw: string | null | undefined
): string | null {
  if (raw === null || raw === undefined) return null;
  // `trim()` 默认就覆盖半角空白 + \t \n \r，以及全角空格 U+3000
  // （String.prototype.trim 去除的是 WhiteSpace + LineTerminator，含 U+3000）。
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/** 结项摘要是否已填写（闸门判据） */
export function hasCloseSummary(raw: string | null | undefined): boolean {
  return normalizeCloseSummary(raw) !== null;
}

/**
 * 项目已结项时**写主档**的拦截文案（`updateProject`）。
 *
 * @returns 不允许时返回可直接抛出的中文文案；允许时返回 `null`
 *
 * 与 `deliverable.service.ts` 的 `assertProjectNotClosed` 是同一条业务规则
 * （「结项后项目只读归档」）在两个写路径上的同一判据 —— 原先只有交付物那条有，
 * 项目主档这条完全没有，于是"只读归档"只是 `CloseProjectSection` 的一句承诺。
 */
export function projectClosedWriteBlockReason(
  status: string | null | undefined
): string | null {
  if (status === 'closed') {
    return '项目已结项，项目主档已冻结（结项报告已发出，改动会让报告与实际不一致）；如需调整请先反结项';
  }
  return null;
}
