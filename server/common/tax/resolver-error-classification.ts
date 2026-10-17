/**
 * 纳税主体兜底查询的**失败分类**逻辑（从 `tax-entity-resolver.ts` 抽出，§5.9）。
 *
 * ## 为什么这段值得单独成文件并被断言
 *
 * 它决定"一次数据库查询失败"要不要惊动运维，而这个判断错了在两个方向上都很贵：
 *
 * | 判断 | 错的后果 |
 * |---|---|
 * | 把真实故障当"schema 未就绪"静默（漏报） | **整批凭证以无主体落库**，日志里与"确实没有匹配合同"无法区分；运维既看不到故障也看不到影响面 |
 * | 把"schema 未就绪"当真实故障（误报） | 每次调用刷一条 error，**把真实故障淹没在噪声里** |
 *
 * 还有一条容易写错的细节：`code` 藏在**异常链**里。drizzle 会把驱动错误包成
 * `DrizzleQueryError`，真正的 SQLSTATE 在 `error.cause.code` 上，有时还不止一层。
 * 只读第一层 `error.code` 会**永远取不到**，于是分类恒定走"必须记录"分支
 * （误报），或者更糟 —— 若实现写成"取不到 code 就当可静默"，就变成漏报。
 *
 * 这两条都能用纯函数断言钉住，所以不该留在 service 里。
 */

/** 可静默降级的 SQLSTATE：环境尚未迁移完成时的两个特征码 */
export const SILENT_SCHEMA_SQLSTATES: ReadonlyArray<string> = ['42P01', '42703'];

/**
 * 沿 `cause` 链提取 PostgreSQL SQLSTATE。
 *
 * drizzle 会包一层 `DrizzleQueryError`，所以真正的码常在 `cause` 上，且可能多层。
 * 深度上限 5 是防**循环 cause 链**（对象互相引用）导致死循环。
 *
 * 只认 `^[0-9A-Z]{5}$`（SQLSTATE 的形状），避免把 `error.code` 上的
 * 其他含义的码（Node 的 `ECONNREFUSED`、HTTP 码等）误当 SQLSTATE：
 *   · `ECONNREFUSED` 是 12 位 → 不匹配；
 *   · `'404'` 是 3 位 → 不匹配；
 *   · `'42P01'` → 匹配。
 *
 * @returns 找到的 SQLSTATE，或 `null`（含"取不到"与"形状不符"两种）
 */
export function extractPgCode(error: unknown): string | null {
  const SQLSTATE = /^[0-9A-Z]{5}$/u;
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current !== 'object') break;
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && SQLSTATE.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/**
 * 该错误是否属于"可静默降级"（不记 error，只记 debug）。
 *
 * 只有"schema 未就绪"的两个特征码可静默 —— 那是**预期内**的降级条件
 * （补偿队列在迁移前被调用、单测用最小 schema）。
 * 其余一律不可静默：连接断开 / 权限 / 超时 / 语法错误都会导致**整批凭证无主体**，
 * 必须让运维看见。
 */
export function isSilentSchemaDegrade(error: unknown): boolean {
  const code = extractPgCode(error);
  return code !== null && SILENT_SCHEMA_SQLSTATES.includes(code);
}
