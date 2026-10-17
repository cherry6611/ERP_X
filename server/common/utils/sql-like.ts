/**
 * S4：`ILIKE` / `LIKE` 关键字的通配符转义（全仓唯一入口）。
 *
 * ## 为什么需要它
 *
 * 各服务的模糊搜索原先一律写成 `ilike(col, \`%${keyword}%\`)`。
 * **这不是 SQL 注入**（drizzle 已绑定参数，值本身安全），但 `%` 与 `_`
 * **未做 `ESCAPE` 转义**，会被 `ILIKE` 当作通配符：
 *
 *   · 传 `keyword = %` → 模式变成 `%%%` → **匹配全表**；
 *   · 传 `keyword = _` → 匹配任意单字符 → 逐字符探测枚举。
 *
 * 于是任意登录用户都能用搜索接口枚举全部行（在其数据权限范围内绕过"搜索"语义），
 * 成本极低。审计 §6.9 点名 6 处，本文件提供统一修法。
 *
 * ## 用法（两步缺一不可）
 *
 * ```ts
 * import { escapeLikePattern, likeContains } from '@server/common/utils/sql-like';
 *
 * // ① 显式转义关键字
 * const pattern = likeContains(keyword);      // → `%转义后的关键字%`
 * // ② SQL 侧声明转义符（drizzle: sql`${col} ILIKE ${pattern} ESCAPE '\\'`）
 * ```
 *
 * 只做①不做②仍然会**把 `\` 当普通字符**匹配 —— 两者必须配对。
 * 为避免"配不齐"，`likeContains` 返回的对象同时携带模式与转义符，
 * 推荐直接用 `likeEscapeClause` 生成整段条件。
 *
 * ## 为什么转义符用反斜杠
 *
 * PostgreSQL 的 `LIKE` 默认转义符就是 `\`（`standard_conforming_strings = on` 下
 * 字符串字面量里的 `\` 不再被解释，因此**必须显式写 `ESCAPE '\'`** 才能生效）。
 * 显式声明比依赖默认行为更可靠：默认行为在 `ESCAPE ''`（禁用转义）时完全不同。
 */

import { sql, type SQL, type SQLWrapper } from 'drizzle-orm';

/** `LIKE`/`ILIKE` 的转义符。PostgreSQL 允许自定义，但 `\` 是与 drizzle 模板最省事的组合 */
export const LIKE_ESCAPE_CHAR = '\\';

/**
 * 搜索关键字长度的统一上限。
 *
 * 通配符转义解决的是"模式被放大"，但超长关键字本身也会让 `ILIKE %...%`
 * 无法走索引、白耗 CPU。业务上没有一个合理的搜索词会超过 100 字符。
 */
export const LIKE_KEYWORD_MAX_LENGTH = 100;

/**
 * 把用户输入的关键字转义为 `LIKE` 模式中的**字面量**。
 *
 * 转义顺序很重要：必须先转义反斜杠本身，再转义 `%` 与 `_` ——
 * 否则 `\%` 会被二次转义成 `\\%`，语义从"字面百分号"变成"字面反斜杠 + 通配符"。
 */
export function escapeLikePattern(keyword: string): string {
  return keyword
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

/** 规整关键字：去首尾空白 + 截断到上限。返回空串表示"不构成搜索条件" */
export function normalizeLikeKeyword(keyword: string | null | undefined): string {
  return (keyword ?? '').trim().slice(0, LIKE_KEYWORD_MAX_LENGTH);
}

/**
 * 生成"包含"匹配的模式：`%<转义后的关键字>%`。
 *
 * 关键字为空时返回 `null`，调用方据此**完全跳过**该条件
 * （而不是拿 `%%` 去匹配全表 —— 那正是原缺陷的形状）。
 */
export function likeContains(keyword: string | null | undefined): string | null {
  const normalized = normalizeLikeKeyword(keyword);
  if (normalized === '') return null;
  return `%${escapeLikePattern(normalized)}%`;
}

/** 生成"以…开头"匹配的模式（如单据号前缀搜索） */
export function likeStartsWith(keyword: string | null | undefined): string | null {
  const normalized = normalizeLikeKeyword(keyword);
  if (normalized === '') return null;
  return `${escapeLikePattern(normalized)}%`;
}

/**
 * 一行生成带 `ESCAPE` 的 `ILIKE` 条件。
 *
 * drizzle 的 `ilike(col, pattern)` **不支持 ESCAPE 子句**，因此必须落到
 * `sql` 模板。
 *
 * ⚠️ 转义符**必须走参数绑定**，不能写字面量：
 * 在 `standard_conforming_strings = on`（现代 PostgreSQL 默认）下，
 * 写成 `sql.raw("'\\'")` 会生成 `ESCAPE '\\'` —— PostgreSQL 把 `'\\'` 解析为
 * **两个字符的反斜杠**，于是直接报 `invalid escape string`（pglite 实测复现）。
 * 绑定参数则原样传一个反斜杠，与本模块 `escapeLikePattern` 的转义口径严格一致。
 *
 * 用法：
 * ```ts
 * const keyword = likeContains(rawKeyword);
 * const where = keyword ? ilikeEscaped(mdCustomer.name, keyword) : undefined;
 * ```
 *
 * 注意 `column` 传 drizzle 列对象（会被编译为带表别名的标识符），
 * **不要**传字符串 —— 那会退化成手工拼标识符。
 */
export function ilikeEscaped(column: SQLWrapper, pattern: string): SQL {
  return sql`${column} ILIKE ${pattern} ESCAPE ${LIKE_ESCAPE_CHAR}`;
}
