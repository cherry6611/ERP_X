# 严重/架构级问题改造方案（待确认）

> 配套报告：`docs/CODE_REVIEW_REPORT.md`
> 本轮目标：针对 **S2 / S3 / S4 / M3** 四项高风险/架构级问题给出可落地的改造方案、影响面与回滚预案。
> 已落地的安全修复（第一波，已通过 `tsc`）：M4(vite^7)、M2(审计复合索引)、S1(密钥校验绕过)、L7(ESLint)、L1(round2 抽取)。
> 本文件**不改动代码**，仅陈述方案，确认后再实施。

---

## S2 — 数据权限 fail-open 默认策略

### 现状与风险
- `common/auth/data-scope.service.ts:400-406` 默认 `fallback.scope = 'all'`，即资源类型未命中配置行时**不施加任何行级过滤**。
- 代码**已具备** fail-closed 能力（`:423-458`）：当 `DATA_SCOPE_UNCONFIGURED_POLICY=deny` 且 `sys_data_scope` 中该 `resourceType` 已有启用配置行时，返回 `scope:'none'`（空集）。但该能力**默认关闭**，且只对"已启用行级权限"的资源收紧。
- 真正风险点：**(1)** 生产若未设 `DATA_SCOPE_UNCONFIGURED_POLICY=deny`，未配置资源仍全量暴露；**(2)** 数据权限为逐 controller **opt-in**（`conditionFor`/`narrowTaxEntityIdFor`/`assertVisible` 需各接口主动调用），漏调用即全量暴露，且无中央兜底。

### 改造方案（保守、行为不变更已配置资源）
1. **会计资料类默认 fail-closed**：在 `resolveScope` 中，对 `voucher`/`ledger`/`report` 等资源类型，将"未配置"的默认策略由 `fallback('all')` 改为"若 `unconfiguredPolicy() !== 'allow'` 则按 `none`（空集）收紧"，与现有 `deny` 开关对齐，但**仅对会计资料生效**，普通业务资源维持现有宽松默认以免误伤。
2. **新增启动期覆盖核查**：`DataScopeService.onModuleInit` 中遍历所有敏感 `resourceType`，若生产（`NODE_ENV=production`）且 `unconfiguredPolicy() !== 'deny'`，打印 `warn` 提示运维设置该环境变量；并输出"哪些敏感 controller 未调用 data-scope"的**静态清单**（基于路由元数据/约定）到日志。
3. **文档化**：在部署文档明确要求生产环境设置 `DATA_SCOPE_UNCONFIGURED_POLICY=deny`。

### 影响面
- 仅影响"未配置数据权限的会计资料类查询"：若生产实际未给 `voucher/ledger/report` 配置行级权限，列表会变空 → 这是预期的安全收紧，但需运维先确认配置已就绪。
- 已配置资源、普通业务资源：行为不变。

### 回滚预案
- 环境变量 `DATA_SCOPE_UNCONFIGURED_POLICY=allow` 可立即恢复原有宽松行为（代码中已有该逃生开关）。
- 若仅改源码未设环境变量，会计资料收紧仅在该资源"已启用配置行"时触发；如误伤，补齐 `sys_data_scope` 配置或置 `allow` 即恢复。

### 验证
- 单元测试：`resolveScope` 对 `voucher` 在 policy=default 时返回 `none`；policy=allow 时返回 `all`；已配置行时按配置。
- 集成测试（pglite）：以普通角色查询 `voucher` 列表，未配置时返回空集（401/403 或空数组），admin/`bypass` 不受影响。

---

## S3 — 每请求事务占用连接池

### 现状与风险
- `platform/session.middleware.ts:43-55`：每个请求（除健康检查/静态资源）都 `this.raw.transaction(async (tx) => { set_config('app.user_id'); requestDb.run(tx, () => next()); })`，事务**持续占用一条连接直到 `res.finish`**。
- `platform/database.ts:5,16-22`：`db` 是 Proxy，请求内查询路由到 `requestDb.getStore()`（即上面的 `tx`）；GUC `set_config('app.user_id', ...)` 供审计列 `current_setting('app.user_id', true)` 读取（schema 多处用到，如 `schema.ts:1590`）。
- 风险：慢接口/中等并发下，连接池 `max:20` 被长期事务占满，出现等待甚至耗尽；事务长期打开还持有快照/锁。

### 改造方案（保守、保证 GUC 正确性）
- 核心难点：`set_config(..., true)` 是事务级，脱离事务即丢失；而连接池连接被复用，**不能把会话级 GUC 留在连接上**（会串号到下一请求）。因此原设计用"事务包住整个请求"来让 GUC 存活是**正确的**，但代价是连接被事务占用。
- **推荐方案（保持连接占用不变、消除长期事务副作用）**：
  1. 引入请求级**专用连接**：`const conn = await this.raw.client.unsafe('BEGIN'); set_config(session)` 在专用连接上，将 `requestDb` store 绑定到该专用连接的 drizzle 句柄；请求结束 `res.once('finish')` 时 `RESET app.user_id` + `COMMIT/ROLLBACK` + 释放连接回池。这样 GUC 只在该连接本请求内可见，不会串号，且不在"事务持续打开"状态（BEGIN 后未提交期间仍占连接，但无长事务快照问题）。
  2. 提供**开关** `PER_REQUEST_TX`（默认保持现状事务模式），新方案作为 `PER_REQUEST_TX=connection` 启用，便于灰度与回滚。
- **更激进但更优（二期）**：业务 service 自行 `this.db.transaction` 已能正确嵌套/独立；可改为请求内不强制开事务，仅用 `SET LOCAL`（需事务）或专用连接模式。

### 影响面
- 涉及请求生命周期与所有依赖 `current_setting('app.user_id')` 的查询/审计列。
- 若 GUC 重置/绑定出错，会导致审计列 `app.user_id` 为空或串号（安全相关），必须充分验证。

### 回滚预案
- 保留原 `PER_REQUEST_TX=transaction`（默认）路径，设置环境变量即可秒级回滚。
- 新路径增加启动自检：若 GUC 在请求内不可见则启动失败（fail-fast）。

### 验证
- 集成测试：并发 50 请求压测下连接池占用对比（新方案事务持有时间显著下降）；断言 `compAuditLog.createdBy` 仍为当前用户 ID（无串号）；断言两个连续请求（不同用户）审计列互不串号。

---

## S4 — 跨模块写非原子（应收 + 凭证各自事务）

### 现状与风险
- `modules/projects/projects.service.ts:750-794`：`createProjectRevenue` 先 `arService.createAr`（独立事务），再 `voucherHook.generateVoucherDraft`（独立事务）。任一步失败，前一步不会回滚。
- 设计上**已有补偿机制**：`VoucherHookService` 将失败写入 `comp_voucher_job` 补偿队列（最多重试 8 次），属"最终一致 + 补偿"模式，并非裸缺陷。

### 改造方案（治理而非重写）
1. **明确为有意的最终一致性**：在 `createProjectRevenue` 注释与架构文档中标注"AR 与凭证为最终一致，靠补偿队列兜底"，消除"看起来像 bug"的歧义。
2. **加对账/巡检任务**：新增一个轻量 `cron`（`ENABLE_SCHEDULER` 受控）定期比对"已生成 AR 但未生成凭证"的单据，补触发 `generateVoucherDraft`，缩小不一致窗口。
3. **（可选，二期）单一编排事务**：若业务要求强一致，改为由调用方开启一个 `this.db.transaction`，将 `tx` 透传给 `arService` 与 `voucherHook`，在**同一事务**内完成；需改造这两个 service 支持传入外部 tx（破坏性较大，建议二期）。

### 影响面
- 仅新增注释 + 一个对账任务，无接口/行为破坏；二期强一致方案才涉及 service 签名变更。

### 回滚预案
- 注释/对账任务移除即可；二期方案单独评审。

### 验证
- 集成测试：模拟 `generateVoucherDraft` 抛错 → 断言 `comp_voucher_job` 产生补偿记录；对账任务能捞起该笔并补生成凭证。

---

## M3 — 核心路径自动化测试补建

### 现状
- `jest.config.cjs` `roots:['<rootDir>/server']`，仅 server；client 0 测试；核心编排 service（voucher/finance/finance-reports/bi/hr-pay/crm/contracts/costs/projects）大量 0% 覆盖；无真实 HTTP e2e（仅 pglite 内存库集成测试）。

### 改造方案（分批、复用现有 pglite 范式）
1. **凭证生成核心路径**（最高优先级）：`server/test/integration/` 新增 `voucher-generate.spec.ts`，覆盖：
   - 幂等（同 `sourceType+sourceRef` 不重复生成）；
   - 借贷平衡校验（不平衡直接拒绝）；
   - 月结/年结闸门（关账期间拒绝）；
   - 补偿队列重试（注入失败 → `comp_voucher_job` → 重试成功）。
2. **银行对账**：`bank-reconciliation` 现有 logic spec 补 `autoMatch`/`manualMatch` 端到端（pglite 造流水 + 应收）。
3. **财务关账**：应收/应付 `close` 流程基本路径。
4. **前端测试基线**：引入 Vitest + @testing-library/react，先对 1–2 个纯展示/表单组件建基线，验证工具链可跑（不追求高覆盖）。
5. **修正 `collectCoverageFrom`**：从"仅 4 个有测试区域"扩到覆盖全部 `server/**/*.service.ts`（CI 门槛设为合理值，如全局 ≥40%），移除陈旧的 `coverage/coverage-summary.json` 提交物。

### 影响面
- 新增测试文件与 devDependency（vitest 等）；不改变业务代码；CI 时长增加。

### 回滚预案
- 测试文件独立，删除即回滚；覆盖率门槛可在 CI 配置中下调。

### 验证
- `npm run test:cov` 通过且覆盖率较现状提升；新增 spec 全绿。

---

## 实施顺序建议（确认后执行）
1. **S2**（低风险、安全收益高，且机制已具备，仅补默认策略+启动核查）
2. **M3**（纯新增、零业务风险，立即提升回归保障）
3. **S4**（仅注释+对账任务，零破坏）
4. **S3**（需开关灰度，最后做，含严格验证）

> 以上四项均提供环境变量/开关级回滚，可在生产以"先开开关观察、再切流量"的方式灰度。请逐项确认或调整优先级。
