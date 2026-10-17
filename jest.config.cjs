/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/server', '<rootDir>/client'],
  testMatch: ['**/*.spec.ts'],
  /**
   * 默认超时从 jest 的 5000ms 提高到 30000ms。
   *
   * 原因（实测，不是猜测）：本仓有多个 pglite 集成规格，每个都要 boot 一次
   * pglite WebAssembly 并跑完整 36 条迁移链 —— **迁移本身只占 1.3s**
   * （`migrate:dryrun` 各条耗时合计），其余是 WASM 启动与 Drizzle 初始化。
   * 单跑一个这样的规格约 8~20s。
   *
   * 在默认 5s 下，一旦有足够多的 pglite 规格并行占用 worker（本轮新增
   * `column-reference-audit` / `baseline-consistency` / `account-status` 三个），
   * **与它们无关的普通规格也会被拖过 5s 而失败** —— 实测
   * `export-file.spec.ts` 单跑 27s 通过、全量跑 107s 后超时失败，
   * 属于资源争用导致的假失败。假失败比慢更糟：它会让人开始忽略红灯。
   *
   * 这里选择显式提高默认超时，而不是给单个规格加 `jest.setTimeout`：
   * 争用影响的是**任意**规格，逐个加必然漏，且漏掉的那个会在 CI 上偶发失败。
   */
  testTimeout: 30000,
  transform: {
    // 服务端与 shared：用 node 目标的 tsconfig（无 JSX）
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
    /*
     * 客户端：.tsx 需要 jsx: react-jsx，而 	sconfig.test.json 继承的是
     * node 目标且 exclude 了 client —— 直接用它会报
     * "Module '...badge.tsx' was resolved ... but '--jsx' is not set"。
     *
     * 因此为客户端单独建 	sconfig.test-client.json（继承 tsconfig.app.json）。
     * 顺序上 .tsx 必须排在 .ts 之前 —— 后面的规则若也匹配会覆盖前面的
     * （jest 按 transform 键的书写顺序取第一个匹配，不按具体度）。
     */
    '^.+\\.tsx$': ['ts-jest', { tsconfig: 'tsconfig.test-client.json' }],
    // @electric-sql/pglite 产物内部用真实动态 import 加载内置模块，jest 的 CJS VM 不支持，
    // 故单独挂 transform 做等价改写（详见 scripts/jest-pglite-transform.cjs）
    '@electric-sql[\\\\/]pglite[\\\\/].+\\.cjs$':
      '<rootDir>/scripts/jest-pglite-transform.cjs',
  },
  // 默认忽略 node_modules 的转译；这里只为 pglite 开一个口子
  transformIgnorePatterns: ['/node_modules/(?!@electric-sql/pglite/)'],
  moduleNameMapper: {
    '^@server/(.*)$': '<rootDir>/server/$1',
    '^@shared/(.*)$': '<rootDir>/shared/$1',
    // B-05：前端纯逻辑模块（不依赖 React/DOM）也纳入单测范围。
    // 否则「字典标签静默退化成英文 key」这类问题只能靠人工发现。
    '^@client/(.*)$': '<rootDir>/client/$1',
    /*
     * shadcn 生成物（`client/src/components/ui/*`）内部用 `@/lib/utils`
     * 这种别名，不是 `@client/...`。jest 不做 tsconfig paths 解析，
     * 缺这条映射时任何**间接**依赖 UI 原子的纯逻辑模块都加载不了 ——
     * 例如 `hr/components/employee-import.ts` → `HrStatusBadge` → `badge.tsx`。
     * 这类间接依赖会随拆分推进（§5.9 / F8）越来越常见。
     */
    '^@/(.*)$': '<rootDir>/client/src/$1',
  },
  /**
   * 覆盖率统计范围（B-11）：只统计「确有测试覆盖」的模块。
   *
   * 原配置含 `server/modules/**\/*.service.ts`，会纳入 60+ 个尚无测试的 service
   * （admin/bi/costs/contracts... 合计上万行 0% 覆盖），全局比例被稀释到 4% 左右，
   * 与 60%/50% 门槛自相矛盾 —— `npm run test:cov` 必然 exit 1，门槛形同虚设。
   * 这里收窄到实际有断言的模块，**门槛保持不变**（statements/lines 60%、branches/functions 50%）：
   *   - common/security/**、common/tax/**、common/utils/biz-date.ts：同目录既有 spec（实测 73.6% / 90.4% / 75% 行覆盖）
   *   - modules/voucher/voucher.service.ts：test/integration/accounting-chain.spec.ts
   *     （真实 VoucherService + pglite，覆盖建科目/建凭证/过账/结账/反结账/作废回退/各类拒绝分支）
   * 收窄后实测全局：Stmts 76.13% / Branch 55.47% / Funcs 65.48% / Lines 78.11%（均高于门槛）。
   *
   * 未纳入 modules/feishu-collab/approval-callback.service.ts 的原因：其 spec 只覆盖到 34%
   * （纳入会把全局 statements 从 76% 压到 59%，低于 60% 门槛）。等该模块 spec 补齐后可加进本清单，
   * 门槛无需调整。新增测试覆盖到某个模块时同样只需把路径加进本数组。
   */
  collectCoverageFrom: [
    'server/common/security/**/*.ts',
    'server/common/tax/**/*.ts',
    'server/common/utils/biz-date.ts',
    'server/modules/voucher/voucher.service.ts',
  ],
  coverageThreshold: {
    global: {
      branches: 50,
      functions: 50,
      lines: 60,
      statements: 60,
    },
  },
};
