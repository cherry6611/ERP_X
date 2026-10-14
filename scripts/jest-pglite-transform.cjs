/**
 * jest 专用 transform（B-10 集成测试配套）
 *
 * 背景：@electric-sql/pglite 的打包产物 dist/index.cjs 在 Node 分支里固定使用**真实动态
 * import** 加载内置模块（共 11 处，形如 `await import("fs/promises")`、`await import("module")`）。
 * 而 jest 的 CommonJS VM 不提供 importModuleDynamically 回调（除非给 node 传
 * --experimental-vm-modules），于是运行期抛：
 *   ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG:
 *   A dynamic import callback was invoked without --experimental-vm-modules
 *
 * 处理方式：只对 pglite 的打包产物做一次等价改写——把 `import(` 换成模块顶部的
 * `__jestPgliteDynamicImport(`，该 helper 用 jest 提供的 require 同步加载模块并包成 Promise。
 * 被替换的 11 处全部是 `await import("<node 内置模块>")`，语义等价（require 与 import 对内置
 * 模块返回同一份导出）。**不改动** pglite 的业务逻辑，也不影响仓库其它任何模块。
 *
 * 为什么不用 NODE_OPTIONS=--experimental-vm-modules：那会把整个测试进程拖进 ESM VM 实验模式，
 * 影响既有 27 个 spec，且 `npx jest --config jest.config.cjs` 裸跑将无法通过。
 *
 * 该改写是对第三方产物文本的依赖：若将来 pglite 升级后不再匹配（例如改用静态 require），
 * 本 transform 会「无事可做」，而集成测试会立刻以 ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG
 * 失败——是显式失败，不会静默假绿。
 */
const DYNAMIC_IMPORT_PATTERN = /\bimport\s*\(/g;

const HELPER =
  '// [jest-pglite-transform] 动态 import → jest require，见 scripts/jest-pglite-transform.cjs\n' +
  'const __jestPgliteDynamicImport = (specifier) => Promise.resolve(require(specifier));\n';

module.exports = {
  process(sourceText, sourcePath) {
    const code = HELPER + sourceText.replace(DYNAMIC_IMPORT_PATTERN, '__jestPgliteDynamicImport(');
    // 便于排查：改写后的产物不再含裸动态 import
    if (/\bimport\s*\(/.test(code)) {
      throw new Error(
        `[jest-pglite-transform] ${sourcePath} 仍残留动态 import，pglite 产物结构可能已变化`
      );
    }
    return { code };
  },
  getCacheKey(sourceText, sourcePath, options) {
    return [
      sourcePath,
      options.configString,
      String(sourceText.length),
      'jest-pglite-transform:v1',
    ].join(':');
  },
};
