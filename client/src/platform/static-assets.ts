/**
 * 静态资源 URL 解析（**零依赖，可被 jest 加载**）。
 *
 * ## 为什么从 `platform/env.ts` 搬出来
 *
 * `env.ts` 里有两个函数，只有一个是纯的：
 *
 * | 函数 | 是否依赖 `import.meta` | 谁在用 |
 * |---|---|---|
 * | `getEnv()` | **是**（`import.meta.env.MODE`） | **全仓 0 处调用** |
 * | `getAssetsUrl()` | 否 | `business-ui/api/user-profiles/service.ts` |
 *
 * 而 `platform/services.ts` 末尾有一行 `export { getAssetsUrl } from './env'`，
 * 把这份依赖**传染给了整条 barrel**：
 *
 * ```
 * UserDisplay
 *   → business-ui/api/users/queries
 *     → business-ui/api/users/service
 *       → platform/services          ← barrel
 *         → platform/env             ← import.meta.env.MODE
 * ```
 *
 * 后果不是"某个测试慢"，而是**任何间接 import `UserDisplay` 的纯逻辑模块，
 * 它的 spec 一行都跑不起来**：jest 对 `client/` 下的 `.ts` 用
 * `tsconfig.test.json`（`module: CommonJS`），而 `import.meta` 只在
 * `es2020`+ 模块下合法：
 *
 * ```
 * client/src/platform/env.ts:2:10 - error TS1343:
 *   The 'import.meta' meta-property is only allowed when the '--module' option is 'es2020'…
 * ```
 *
 * 这条链在 §5.9 / F8 的拆分中**实际挡下过工作**：`ArApSection` 的四张表列定义
 * 因 `render` 里含 `<UserDisplay>` 而无法整体搬进可测模块。
 *
 * ## 修法：把纯函数与 `import.meta` 分开
 *
 * 纯函数搬到本文件（无任何 import），barrel 改为从这里再导出；
 * `env.ts` 保持原样（`getEnv` 虽无调用方，但删除它属于另一件事，
 * 不在本次修复范围内）。
 *
 * ⚠️ **不要把纯函数放回 `env.ts`**，也不要在本文件里 import `env.ts` ——
 * 那会把 `import.meta` 重新接回这条链，等于没修。
 */

/**
 * 把资源路径解析成可直接用于 `<img src>` / CSS `url()` 的地址。
 *
 * 绝对 URL（`http…`）原样返回；其余视为静态资源名，返回一个占位
 * SVG（浅灰底 #e8eef5，320×112）。占位图用 `data:` URI 内联，
 * 避免为一张兜底图引入网络请求。
 */
export function getAssetsUrl(path: string): string {
  if (path.startsWith('http')) return path;
  return `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="112"><rect width="100%" height="100%" fill="#e8eef5"/></svg>')}`;
}
