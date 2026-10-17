# 晟笙 ERP 代码全面检查报告

> 审查对象：`C:/Users/20127/Desktop/晟笙ERP/code`（NestJS + React + TypeScript + Drizzle/PostgreSQL 单体仓库，版本 2.4.0）
> 审查方式：只读静态审查 + 结构/依赖/测试分析（未修改任何文件）
> 生成日期：2026-10-16

---

## 1. 项目整体结构与技术栈概览

**架构形态**：前后端单仓库（monorepo），`server/`（NestJS 后端）、`client/`（React 19 前端）、`shared/`（前后端共享类型与 RBAC 能力矩阵）、`scripts/`（构建/迁移/校验脚本）。

| 维度 | 技术 | 说明 |
|------|------|------|
| 后端框架 | NestJS 10.4 + Express 4 | 模块化分层，平台层 `server/platform/*` 承载 JWT、会话、调度、数据库绑定 |
| 前端框架 | React 19 + Vite 8 + TypeScript | 路由 `react-router-dom@7`，UI 用 antd@6 + Radix + Tailwind 4，数据层 `@tanstack/react-query` |
| 数据库 | PostgreSQL + Drizzle ORM 0.44.6 | 连接池 `max:20`，每请求经 `AsyncLocalStorage` 注入 `DRIZZLE_DATABASE` |
| 校验/安全 | class-validator + helmet + express-rate-limit + AES-256-GCM 密钥库 | 全局 `ValidationPipe`（whitelist+forbidNonWhitelisted） |
| 测试 | Jest + ts-jest + pglite（内存 PG） | 仅覆盖 `server/`，无前端测试、无真实 e2e |
| 集成 | 飞书（多维表格/云盘/通讯录）、银行流水、OpenAPI、异步导出 | 经平台 `CapabilityService` 抽象外部调用 |
| 部署 | Docker + docker-compose | `node:22-bookworm-slim`，非 root 运行，`npm ci` + prune |

**规模**：源码约 1290 个文件（515 js / 450 ts / 324 tsx）；`server/modules` 下 38 个业务模块；最大的文件为 `database/schema.ts`（3268 行）、`voucher.service.ts`（1477 行）、`hr-pay.service.ts`（1348 行）。

**整体评价**：分层清晰、能力矩阵单一真源、凭证生成有幂等与补偿队列、异常过滤器对 SQLSTATE 映射完善，工程基础扎实。风险集中在**数据权限的逐处 opt-in 执行**、**每请求事务的连接占用**、以及**核心业务 service 缺乏自动化测试**。

---

## 2. 功能模块与关键流程说明

**横切系统**
- 认证：自研 HS256 会话（`server/platform/jwt.ts`），会话存 `erp_session` Cookie（HttpOnly / SameSite=Lax / 生产 Secure）。登录安全含密码策略、失败锁定、TOTP MFA、登录审计（`modules/auth/login-security.service.ts`，708 行）。
- 授权：双全局守卫 `LoginGuard`+`RolesGuard`（注册为 `APP_GUARD`），能力矩阵唯一真源 `shared/rbac.ts`，前后端共用避免越权。
- 数据权限（行级）：`common/auth/data-scope.service.ts`（893 行），纯函数 `applyScope` 产出 Drizzle `SQL`；范围 `all/dept/dept_and_child/self/custom/none`，fail-closed 兜底 `1=0`。

**业务模块一览**（共 38 个）

| 域 | 模块 |
|----|------|
| 主数据 | master-data（纳税主体/客户/供应商/员工）、tax |
| 供应链 | pur（采购申请）、contracts（合同台账/减货/版本/里程碑）、returns（退貨）、crm（线索/商机/报价） |
| 项目财务 | projects、costs、revenues |
| 总账/财务 | finance（应收/应付/发票/对账/结算/现金流）、finance-reports（账簿/报表/增值税/税务风险/年结）、voucher（凭证+钩子+补偿队列）、fin-budget、fin-expense |
| 资产/HR | asset（全生命周期+折旧）、hr（员工/考勤/薪资/请假/招聘/考核/培训） |
| 平台/集成 | integrations（银行/导出/待办/OpenAPI）、feishu-sync/drive/collab、bi、audit、notes（票据状态机）、admin、semantic、system-config、settings、data-asset |
| 基础设施 | auth、identity、health、files、directory、attachment、notifications、view（SPA 兜底） |

**关键流程**
- **业务单据 → 凭证 → 入账**：约 17 个模块注入 `VoucherHookService.generateVoucherDraft`，含幂等键、月结/年结闸门、借贷平衡校验；失败写入 `comp_voucher_job` 补偿队列（至多重试 8 次）。
- **飞书同步**：`CapabilityService` 抽象出/入向多维表格读写，幂等靠 `comp_feishu_sync_record` 映射表。
- **银行流水 → 对账**：`bank-statement.service.ts` 导入→`autoMatch`/`manualMatch`→`bank-reconciliation.service.ts` 出差异报告。

**架构关注点**
1. 无全局 `api` 前缀，43/45 控制器硬编码 `'api/'` 字符串（仅 directory、view 例外），靠约定易遗漏。
2. 运行期未挂载 Swagger（有 `.openapi-build` 疑似外部生成）。
3. 跨模块写非原子：如 `projects.service.ts:750-794` 先生成应收再生成凭证，二者各自事务，仅凭证侧有补偿队列，跨模块一致性靠最终一致。
4. 飞书 `refresh_token` 已加密入库但全仓无 `/auth/refresh` 续期端点（疑似未完成特性/死代码）。

---

## 3. 代码质量问题（重复逻辑、命名、复杂度、风格一致性）

**3.1 重复逻辑**
- `round2` 函数被独立定义约 **32 次**（`server/**`），应抽取到 `server/common/utils/number.ts`。代表：`voucher.service.ts:101`、`costs.service.ts:71`、`asset.service.ts:97`、`bi-metrics.service.ts:36`、`common/tax/posting.ts:23`、`finance-reports/reports.service.ts:53` 等。
- `extractPostgresErrorCode` 复制 **6 次**（private 各一份 + 1 处独立函数）：`voucher.service.ts:366`、`costs.service.ts:1108`、`hr-core.service.ts:702`、`hr-self-service.service.ts:490`、`feishu-sync.service.ts:78`。
- “存在性→404”样板约 **110+ 处**（`if (rows.length===0) throw new NotFoundException(...)`），无统一 `requireFound` 封装。散见 `costs.service.ts:270,393,488,741,1018`、`crm.service.ts:125,278,316...`、`asset.service.ts:259,436,446...`、`contracts.service.ts:156,186,255...`。
- 客户端日期格式化内联 `dayjs().format(...)` 多处（`CashFlowTab.tsx:19`、`DeliverableSection.tsx:179,218` 等），缺统一 helper；且客户端 `todayIso()`（`utils/format.ts:19`）用本地时区，与服务端 `todayInShanghai()`（`common/utils/biz-date.ts:2`）按 `Asia/Shanghai` 口径**不一致**，存在账期漂移风险。
- `voucher.service.ts:384` 的私有 `assertPeriodOpen` 仅转发已导入的 `period-guard.ts:8`，无附加逻辑，属无意义间接层。

**3.2 命名一致性**
- 请求 DTO 后缀混用：`CreateCostBodyDto`（`*Body`）、`CreateTimesheetRequestDto`（`*Request`）与 `CreateVoucherLineDto`（无后缀）并存，规则不统一。
- Service 方法名整体一致（`listX/createX/...`），类/异常名符合 Nest 约定。共享 DTO 经 `@shared/api.interface` 在前后端共用，双份维护已被较好规避（仅服务端 class `implements` 共享接口的字段双维护，风险低）。

**3.3 复杂度 / 上帝对象**
- `hr-pay.service.ts`（1348 行）**严重违背单一职责**：薪酬/招聘需求/候选人/考核/培训 5 个子域混于一文件（薪酬 `createPayroll:355`/`payrollAction:491`/`approvePayroll:625`；招聘 `createRecruitReq:943`；候选人 `createCandidate:996`；考核 `createAppraisal:1121`；培训 `createTraining:1231`）。应拆分为 `payroll/recruit/candidate/appraisal/training` 五个 service。
- 巨型单体函数：`costs.service.ts` 的 `createAllocationBatch:841-1013`（≈172 行，校验+分摊+事务）；`voucher.service.ts` 的 `createVoucher:636-789`（≈153 行）。应拆解步骤。
- `voucher.service.ts`（1477 行）、`projects.service.ts`（1117 行，项目 CRUD 与财务过账混用，如 `postRevenueVoucherAndAr:706`）、`costs.service.ts`（1118 行）均存在职责堆叠。
- `database/schema.ts`（3268 行）单文件巨型 schema，按域拆分更佳（非典型上帝对象，但可维护性差）。

**3.4 风格一致性**
- ESLint 配置（`eslint.config.js`）仅启用 `react-hooks` 规则，**未启用** `import/order`、`@typescript-eslint/recommended`、`no-unused-vars`、命名规则、prettier 集成。
- `.prettierrc`（`singleQuote`、`printWidth:80`）存在但**无 prettier 依赖、无 format 脚本**；`.stylelintrc.js` 的 `rules:{}` 为空且仅扫 `client/src/**/*.css`。即 `lint` 脚本对风格实质为 no-op，**风格在 CI/本地均未被强制**。
- 服务端 100% async/await，客户端大量 `.then()` 链（16 个文件，如 `LoginPage.tsx`、`ApTab.tsx`），两端控制流风格割裂。
- 全仓无显式全局 `api` 前缀（见 §2）。

---

## 4. 潜在缺陷与安全风险

**4.1 认证 / 密钥（严重）**
- **H1 生产密钥强度校验可被绕过**：`main.ts:80-114` `assertProductionSecrets` 仅当 `NODE_ENV==='production'` 才强制 `JWT_SECRET`（≥32）/`SECRET_ENC_KEY`（≥16）。若生产误配（写成 `prod`/留空/compose 漏配），弱/空密钥被允许，攻击者可**自行伪造管理员会话**（HS256 HMAC，密钥可猜/为空即可伪造）；同时 `auth.controller.ts:398` 的 Cookie `Secure` 标志也依赖同一判断，误配下会话 Cookie 以非 Secure 下发，存在中间人窃取风险；非 production 非 development 时 `abortOnError` 不 fail-fast 进一步掩盖问题。建议改用显式 `REQUIRE_STRONG_SECRETS=true` 开关或反向判断（“非 development 即按生产要求强制”）。
- 飞书事件 Webhook 的放行开关 `feishu-collab/event.controller.ts:64-82` 已实现 fail-closed（仅非生产+`FEISHU_ALLOW_UNVERIFIED_EVENTS=true` 才跳过），但同样依赖 `NODE_ENV` 判断链，受 H1 连带影响。

**4.2 授权 / 数据权限（严重）**
- **M1 数据权限对“未配置资源”默认放行（fail-open）**：`data-scope.service.ts:400-460` `resolveScope` 在资源类型未命中配置时返回 `scope:'all'`；`conditionFor:510`/`assertVisible:603` 对 `from==='default'` 直接返回 `undefined`（不加任何过滤）。即若某敏感资源类型尚未在 `sys_data_scope` 登记，所有查询等于无行级过滤，且**完全依赖各 controller 是否记得调用** `conditionFor`/`narrowTaxEntityIdFor`。建议对会计资料类（`voucher/ledger/report`）默认 fail-closed，并补“每个敏感 controller 必须应用 data-scope”的清单核查。
- 数据权限执行点分散、无中央拦截器兜底，新增查询漏调即全量暴露；多角色取“最宽”范围（`resolveScope:386-488`，代码自注“需业务确认”）存在权限放大风险。

**4.3 错误处理 / 输入校验（良好为主）**
- 全局 `ValidationPipe`（`main.ts:170-194`）已启用 whitelist + forbidNonWhitelisted + transform，抽样 40+ 控制器均用 class-validator DTO，未发现 `@Body()` 接 `any`/未校验原始 body。
- 未发现空 `catch{}`/`catch{return null}` 吞异常；全局异常过滤器将 SQLSTATE 映射为恰当 4xx，且 `isProd` 下不向客户端回显堆栈/内部报文。外部调用（飞书）有超时、重试退避、令牌并发去重。
- **连接/事务可靠性的隐蔽风险（见 H2）**：`session.middleware.ts:43-55` 每请求（除健康检查/静态资源）都开一条 DB 事务仅用于 `set_config('app.user_id',...)`，直到 `res.finish` 才释放。慢接口或中等并发下可能**耗尽连接池**（连接池 `max:20`）或长时间持有事务（锁/快照）。建议改为连接获取后普通 `SET LOCAL`/`set_config(...,false)`，或仅对需要行级权限的接口绑定 `app.user_id`。

**4.4 SQL / 注入**
- 未发现 `sql\`...${userInput}...\`` 形式的字符串插值；`ilike ${`%${keyword}%`}` 走参数绑定。业务编号生成器 `common/utils/biz-code.ts:191-205` 用 `sql.raw` 拼接列/表名，但来源为 drizzle 表/列对象（非请求输入），**当前安全**；作为公共函数建议加断言/白名单约束参数来源，防止未来误用。

**4.5 依赖与配置安全**
- 已填充的**真实 `.env`**（`code/.env`，1958 字节）含开发密钥（DB 密码、飞书密钥等），但已被 `.gitignore` 排除，**未提交**（仅提醒：勿复用为生产值）。
- `docker-compose.yml` 敏感项走 `${...}?` 必填校验、Postgres 仅 `127.0.0.1` 暴露，**无硬编码密钥**；`Dockerfile` 非 root + `HEALTHCHECK`，良好。

---

## 5. 性能瓶颈与可优化点

**5.1 N+1 / 循环内 DB 调用**
- **`voucher.service.ts:1142-1318` `findBizByCode`**：正则提取业务单号后**逐单号 `await this.db` 查询**（`:1159,1173,1187...` 共十余次），随引用数线性放大。建议改为按单号集合 `inArray` 一次批量查。
- `hr-pay.service.ts:664-780` `collectAllocationItems` 在事务内对每项 `await tx.select` + `generateBizCode`（含 COUNT/MAX）+ insert，按项目数 N 放大为 ~4N 次串行往返（有界，可批量）。
- `bank-statement.service.ts:526-541` `autoMatch` 逐行 `await linkMatch` 串行写匹配；导入已分 500/批（良好），但匹配写入可批量 `insert ... values([...])`。

**5.2 大内存处理**
- `integrations/exports/export-file.ts:80-94` `new ExcelJS.Workbook()` + `writeBuffer()` 在内存生成整本工作簿，大报表内存峰值高；建议改 `ExcelJS.stream.xlsx.write()` 流式。
- `bi/bi.service.ts` 多次“聚合 SQL 拉全量后在 JS 内存 `Map`/双层循环归并”（`:177-181,265-280,503-525,706-724`），如 `projectCostBreakdown:503` 拉全量 `erpProjectCost` 后在 JS 里 `rows.map`，员工多/数据大时 CPU/内存热点；且**全无缓存**。

**5.3 缺失索引**
- 实时审计日志 `compAuditLog`（`schema.ts:1564`）仅建 `objectType` 单列索引（`:1593`），按 `objectType+objectId` 反查单据审计轨迹（极常见）**无复合索引**；归档表 `compAuditLogArchive:2996` 已建对等复合索引——建议补齐 `(objectType, objectId)`。另评估 `erpProjectCost(sourceRef, projectId, period)` 复合索引（`:684-698` 用 `like 'timesheet:%'` 过滤）。

**5.4 缓存未落地**
- 已装 `@nestjs/cache-manager`+`cache-manager`，但**全仓仅 1 处使用**（`admin/automation-config.*`）。BI 概览、报表重算、字典/能力码等高频只读查询均未缓存，属“装了没用上”的潜在死依赖；建议在 BI/报表/字典落地 `CacheModule` 或评估移除。

**5.5 调度器**
- 自定义发现机制（`platform/scheduler.ts`）用 advisory lock 保证多实例互斥，良好。但 `feishu_contact_full`/`feishu_daily_sync`/`retention_daily`（审计归档）为长时 I/O/大事务，在事件循环内同步 await，建议加超时、分批、限流反压评估；`docker-compose` `app` 服务 `mem_limit:1g` 对含报表/BI 聚合偏紧，易 OOM（结合 §5.2）。

---

## 6. 测试覆盖情况与可测试性建议

**6.1 现状**
- `jest.config.cjs:3-4` `roots:['<rootDir>/server']`——**仅覆盖 server，client 完全无测试**（find 返回空）。
- server 有 **60 个 `.spec.ts`**：集中在纯逻辑/规则引擎（tax、security、报表公式、工资引擎、银行对账逻辑、报价解析）与 **12 个 pglite 内存库集成测试**（`server/test/integration/*`，含 accounting-chain、audit-immutability、data-scope-bypass、revenue-chain 等）。
- **无真实端到端（HTTP/e2e）套件**；集成测试用 pglite 而非对运行服务演练。
- CI（`ci.yml`）含 `npm test` + 独立 `test:cov` + `npm audit --audit-level=high` + 依赖审计约束门禁，良好。

**6.2 覆盖缺口（核心业务 service 大面积 0%）**
`coverage/coverage-summary.json` 因 `collectCoverageFrom` 被收窄到仅 4 处有测试的区域，提交物全局仅 **2.04%**（反映收窄前全量，与当前门槛不一致，属陈旧产物，已被 `.gitignore` 忽略但工作区残留，建议勿提交）。实际未被测试触达的**编排型 service** 包括：`bi.service`、`hr-pay`、`hr-core`/`hr-self-service`、`finance-reports/*`（reports/ledgers/year-end/vat-declaration）、`finance/*`（ap/ar/invoice/reconciliation/cash-flow/vendor-settlement）、`crm/*`、`contracts/*`、`costs.service`、`pur`、`revenues`、`projects/*`、`auth`、`asset`、`admin`、`feishu-sync` 等。

**6.3 可测试性建议**
- 优先为高风险金融路径补 service 级测试（注入 `DRIZZLE_DATABASE` 用 pglite 同集成测试做法）：凭证生成幂等/借贷平衡/补偿重试、银行对账匹配、应收应付关账、薪资计算。
- 前端补关键交互与表单校验单测（当前 0）。
- 引入 HTTP 级 e2e（supertest + 启动实例）覆盖认证→数据权限→业务写链路，尤其验证 data-scope 的 fail-open 边界。
- 修正 `collectCoverageFrom` 口径，使覆盖率真实反映；移除/重建陈旧 `coverage/` 产物。

---

## 7. 按严重程度分级的问题清单

> 排序：严重 → 中等 → 轻微。每项标注文件位置与影响。

### 🔴 严重（Severe）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| S1 | 生产密钥强度校验仅依赖 `NODE_ENV==='production'`，误配即被绕过，可伪造管理员会话；Cookie `Secure` 同受牵连 | `server/main.ts:80-114`、`server/modules/auth/auth.controller.ts:398` | 认证体系根基失效，越权接管风险 |
| S2 | 数据权限对“未配置资源”默认 fail-open（`scope:'all'`），且执行点分散、无中央兜底 | `server/common/auth/data-scope.service.ts:400-460,510,603` | 敏感数据（凭证/账/报表/客户/员工）可能无行级过滤即全量暴露 |
| S3 | 每请求开启 DB 事务仅用于 set_config，长期占用连接池（`max:20`） | `server/platform/session.middleware.ts:43-55` | 并发/慢接口下连接池耗尽、事务长期持有锁/快照，可用性风险 |
| S4 | 跨模块写非原子（如应收与凭证各自事务，仅凭证侧有补偿队列） | `server/modules/projects/projects.service.ts:750-794` | 财务数据最终一致但存在中间态不一致窗口，审计/对账复杂 |

### 🟠 中等（Medium）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| M1 | `findBizByCode` 逐单号串行查询（N+1） | `server/modules/voucher/voucher.service.ts:1142-1318` | 凭证/单据解析延迟随引用数线性放大 |
| M2 | 审计日志缺 `(objectType, objectId)` 复合索引 | `server/database/schema.ts:1564,1593`（对比 `:2996`） | 反查单据审计轨迹全表扫描 |
| M3 | 核心业务 service 自动化测试大面积 0%，前端 0 测试，无真实 e2e | `jest.config.cjs`、`coverage/`、`client/**` | 回归无保障，金融核心路径风险高 |
| M4 | `vite:^8` 与 `@vitejs/plugin-react:^5` peer 不匹配风险 | `package.json:74,113` | 安装/构建可能 peer 冲突或运行期不兼容 |
| M5 | 缓存依赖已装但仅 1 处使用 | `package.json:4,15`；`server/modules/admin/automation-config.*` | 潜在死依赖 / 高频只读查询未受益 |
| M6 | 大报表内存峰值 + `mem_limit:1g` 偏紧 | `integrations/exports/export-file.ts:80-94`、`docker-compose.yml` | 大报表/BI 聚合可能 OOM |
| M7 | 飞书 `refresh_token` 入库但无续期端点 | `server/modules/auth/auth.service.ts:378-384` | 死代码/未完成特性，会话只能重新登录 |
| M8 | 调度重任务（飞书全量同步/审计归档）长时 I/O/大事务同步 await | `server/platform/scheduler.ts:55-64`、`feishu-sync.service.ts` | 长事务/锁表/反压风险 |
| M9 | 无显式 CORS 策略（当前因同源可接受，但不可审计） | `server/main.ts`（无 `enableCors`） | 前端独立部署时直接失败且难排查 |

### 🟡 轻微（Minor）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| L1 | `round2` 重复约 32 次 | 跨 `server/**`（如 `voucher.service.ts:101`、`costs.service.ts:71`） | 维护负担，口径漂移 |
| L2 | `extractPostgresErrorCode` 复制 6 次 | `voucher.service.ts:366`、`costs.service.ts:1108` 等 | 维护负担 |
| L3 | “存在性→404”样板约 110+ 处，无统一封装 | `costs/crm/asset/contracts.service.*` 等 | 样板冗长 |
| L4 | `hr-pay.service.ts` 混 5 子域，违反 SRP | `server/modules/hr/hr-pay.service.ts`（`:355,491,625,943,996,1121,1231`） | 可读性/可维护性差 |
| L5 | 巨型单体函数（`createAllocationBatch`≈172 行、`createVoucher`≈153 行） | `costs.service.ts:841-1013`、`voucher.service.ts:636-789` | 难测、难改 |
| L6 | 请求 DTO 后缀混用 Body/Request/无 | `CreateCostBodyDto`、`CreateTimesheetRequestDto` 等 | 命名不一致 |
| L7 | ESLint/Prettier/Stylelint 基本未强制 | `eslint.config.js`、`.prettierrc`、`.stylelintrc.js`、`scripts/lint.js` | 风格无门禁 |
| L8 | 客户端日期用本地时区，与服务端 Shanghai 口径不一致 | `client/src/utils/format.ts:19,26` vs `server/common/utils/biz-date.ts:2` | 账期/日期漂移 |
| L9 | 前后端 async/await vs `.then()` 风格割裂 | 服务端 100% async/await；客户端 16 文件 `.then()` | 风格不一致 |
| L10 | 无全局 `api` 前缀，依赖硬编码字符串约定 | `server/modules/**/controllers`（43/45） | 易遗漏前缀导致路由错误 |
| L11 | `database/schema.ts` 单文件 3268 行 | `server/database/schema.ts` | 可维护性差 |
| L12 | `antd:^6` 大版本（生态/破坏性变更需回归） | `package.json:13` | 升级回归风险 |

---

### 总体结论
代码库在工程基础上**优于一般同类项目**（分层清晰、校验/认证/异常处理扎实、凭证有幂等与补偿、CI 含测试与审计门禁）。**最优先治理项**为 S1（密钥校验绕过）、S2（数据权限 fail-open）、S3（每请求事务连接池）——三者均属“配置/约定失误即可引发系统性风险”。其次补齐核心 service 测试（M3）与修正依赖版本风险（M4）可显著降低长期运维与发布风险。以上均未修改任何代码。
