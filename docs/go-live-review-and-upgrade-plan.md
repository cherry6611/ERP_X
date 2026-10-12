# 晟笙数据服务 ERP — 上线就绪评估与升级/UI 优化方案

> 日期：2026-10-11 · 本文档为纯评估与设计产物，不含任何代码改动。前置报告：`docs/project-review-2026-10.md`。
> 标注约定：**[已验证]** = 本轮实际核查（命令/接口/日志）；**[建议确认]** = 需业务侧核对后执行。

## 结论摘要

系统具备上线条件：22 个页面全链路业务闭环完整，运行态健康（服务端日志无错误），RBAC/RLS/审计三道防线已生效，历史两次发布均 finished。上线前有两个必办项：**清理 `[API_TEST]` 演示数据**、**可见范围从「仅创建者」扩大到实际使用人群**；且当前线上版本落后于开发版（不含 BI 期间费用指标与触发器激活），上线时需重新发布。UI 层存在 4 项全局一致性欠账（金额对齐、空态文案、分页/卡片列数、状态色语义），修复工作量小、收益高，建议在上线后第一个迭代内完成。

---

## 一、全面检查结论（自上轮报告起的更新）

### 1.1 已完成项（上轮建议 → 本轮闭环）

| 项 | 上轮状态 | 本轮状态 |
|---|---|---|
| BI 增加期间费用/营业利润/贡献净额口径 | 建议排期 | **已实施并验收**：指标卡、毛利榜新列、趋势序列均上线，接口自测 2xx **[已验证]** |
| admin_rent_expiry_remind 触发器 | 待激活 | **已激活**（Active=true，每日 09:00）**[已验证]** |
| 人力成本口径文档 | 缺失 | 已交付 `docs/project-review-2026-10.md` |

### 1.2 运行态核查

- 服务端日志干净：无编译错误、无运行时异常 **[已验证]**。
- 写接口鉴权模型：19 个 controller 含写方法，全部依赖平台网关登录态（不加 `@NeedLogin`），RLS 对 anon 仅开放 SELECT，匿名写入被 42501 正确拒绝。**当前形态正确**——应用对内、全员登录访问，无公开匿名写入场景 **[已验证]**。
- 代码卫生：TODO/FIXME 仅 1 处，位于平台保护组件 `client/src/components/business-ui/entity-combobox/search-trigger.tsx:85`，**不处理**（平台文件红线）。无 `console.*` 残留；无 nest-cli.json 运行时资源依赖，无发布静默失效风险 **[已验证]**。
- 发布历史：2 次发布均 finished（最近一次 2026-10-10 15:26），**晚于该时间点提交的 BI 指标改动尚未发布** **[已验证]**。

### 1.3 未闭环项（沿用上轮）

1. 3 个 feishu-bitable 插件实例（成本出向/合同归档/工时入向）appToken/tableID 仍为占位。
2. `feishu_daily_sync` 触发器 Active=false **[已验证]**（有意：待插件配置完成再激活，避免每日 02:00 必失败并在幂等映射表留 pending 占位）。
3. 单环境数据库：dev 与生产共用一套库，`<database-environment type="single_env">`。
4. `[API_TEST]` 演示数据仍在线上库中（本轮抽查 /api/projects 复核：2 个项目 + 1 个合同草稿仍在）**[已验证]**。

---

## 二、修复建议（分级）

### P0 — 上线阻塞（上线前必须完成）

**P0-1 清理 `[API_TEST]` 演示数据**

- 现状证据：编号段 2026100001 的全链演示数据（线索/合同草稿 CTR/项目 PRJ×2/项目成本/项目收入/应收应付/工资单与分摊/行政缴费 ADB/租房合同 RNT/资产 AST/事务 AFR 等），以 `docs/project-review-2026-10.md` 附录清单为准，本轮抽查确认仍在 **[已验证]**。
- 动作：用 `lark-cli apps +db-execute`（先加载 lark-apps-db skill）按外键依赖**从下游往上游**删除：核算与流水（erp_project_cost / erp_project_revenue / erp_revenue_adjust / erp_ar / erp_ap_bill / erp_timesheet / erp_cost_allocation / hr_payroll 及工资明细）→ 项目（erp_project）→ 合同（erp_contract）→ CRM（crm_lead/crm_opportunity）→ 行政（erp_admin_bill / erp_admin_rent_contract / ast_change+ast_depreciation→ast_asset / admin_affairs）→ 主数据（md_employee / md_customer / md_supplier）。识别条件：编号前缀+`2026100001` 流水段或名称含 `[API_TEST]`；删除前先 SELECT 计数留档，删除后复核各业务列表为空/仅剩真实数据。
- 验收：各列表接口（projects/contracts/customers/suppliers/employees/admin-*）不再返回 `[API_TEST]` 记录；comp_audit_log 保留删除审计痕迹。
- 注意：**同步模块 comp_feishu_sync_record 中的映射行一并清理**，避免真实数据后续被演示期占位行挡住同步。

**P0-2 扩大运行时可见范围**

- 现状证据：`+access-scope-get` 显示 scope=Range，当前仅创建者一人在 users 列表、require_login=true、审批流 enabled **[已验证]**。
- 动作：用 `+access-scope-set` 把使用者（部门/群/人员）加入范围；范围变更走既有审批人。**[建议确认]** 名单由业务侧提供。

**P0-3 重新发布最新版本**

- 动作：见第三章发布流程。当前线上版本不含 BI 期间费用指标（10-11 00:22 提交）。

### P1 — 上线前建议（可上线后一周内补齐）

**P1-1 插件配置与 feishu_daily_sync 激活**：3 个 bitable 实例 appToken/tableID 由你在插件配置页填写（清单见 `AGENTS.md` 架构约定节），随后激活 feishu_daily_sync 并人工触发一轮同步验证（幂等映射表无报错、Base 侧可见记录）。未配置期间，出向/入向同步不可用，属功能降级而非故障。

**P1-2 admin 角色成员核对**：`+role-` 命令族核对 admin 角色成员名单与实际管理者一致（RBAC 前后端已生效，角色成员错了就是权限放错人）**[建议确认]**。

**P1-3 环境变量核查**：`+env-list` 确认无遗留调试变量（当前无 .env 依赖，属例行检查）。

### P2 — 排期处理

- **P2-1 多环境数据库评估**：见第四章 M2。
- **P2-2 UI 一致性修复**：见第五章，建议作为上线后第一个迭代。
- **P2-3 演示数据防再生**：约定测试数据必须带 `[API_TEST]` 前缀 + 用后即删；可在 /audit 页面按 actor+时间段定期巡检新增测试数据。

---

## 三、上线运行建议

### 3.1 发布流程（以 lark-apps-ops skill 为准）

1. 本地改动全部 `git` 提交（发布只认仓库内容）。
2. `lark-cli apps +release-create --app-id "$app_id"` 发起部署（如 CLI 返回 confirmation_required，按提示确认，勿静默重试）。
3. `lark-cli apps +release-get` 轮询至 `finished`（failed 则读 error_logs 关键步骤），拿到 online_url。
4. 线上冒烟：打开线上入口走一遍核心页（登录态=真实用户）；`+log-list` 查有无 5xx/异常。
5. 回滚：发布失败或线上异常时，`+release-list` 找上一个 finished 的 release_id，按 lark-apps-ops 指引回退并重发。

### 3.2 上线前动作清单（勾选式）

- [ ] P0-1 演示数据清理完毕并复核
- [ ] P0-2 可见范围扩大并通过审批
- [ ] P0-3 重新发布 + 线上冒烟
- [ ] admin_rent_expiry_remind 接收人确认（每日 09:00 会真实扫描并发飞书消息，当前收件=admin 角色成员+合同提交人）**[建议确认]**
- [ ] P1-2 角色成员核对
- [ ] 插件配置完成 / 明确降级运行（P1-1 可延后，不阻塞）

### 3.3 上线后运维基线

| 事项 | 方式 | 频率 |
|---|---|---|
| 线上错误监控 | `+log-list` / `+trace-list`（lark-apps-ops） | 每日 |
| 接口量/错误率/延迟 | `+metric-list`、`+analytics-list` | 每周 |
| 业务审计巡检 | /audit 页面（comp_audit_log），重点看 anon 写入尝试与非常规状态流转 | 每周 |
| 触发器执行情况 | server 日志按 `admin_rent_expiry_remind`/`feishu_daily_sync` 关键词巡检；feishu_daily_sync 激活后首轮必看 comp_feishu_sync_record | 每日（激活后第一周） |
| 数据库备份 | lark-apps-db skill 的行级审计 / PITR 能力（具体命令以该 skill 为准），上线前确认配额与策略 | 上线前定策略，按周演练 |
| 测试数据卫生 | 按 P2-3 约定巡检 | 每月 |

### 3.4 已知运行特性（不是 bug，运维侧须知）

- 沙箱/验收链路中 admin 按钮不可见、浏览器写操作被 RLS 拒——均为预期防线，勿据此误判线上故障。
- 工资分摊、公共折旧分摊在 BI 中计入期间费用而非毛利，绑定项目的折旧计入毛利：口径详见 `bi.service.ts`（sourceRef 前缀 payroll:/asset: 区分）。
- 通知插件当前可用（send-feishu-message 已安装）；bitable 类插件未配置前相关同步报错为真实透传，属配置缺失而非代码缺陷。

---

## 四、升级详细设计与方案（里程碑）

### M1 多维表格同步落地（上线后第 1-2 周，依赖 P1-1 配置）

- 范围：3 个 bitable 插件实例配置 → feishu_daily_sync 激活 → 首轮同步验证。
- 关键文件：`server/modules/feishu-sync/`（同步任务与幂等逻辑）、`comp_feishu_sync_record`（幂等映射）。
- 验收：入向（工时）与出向（成本、合同）各跑一轮：映射表无报错、Base 侧记录数与来源表一致、重复执行不产生重复记录（幂等生效）。

### M2 多环境数据库拆分（上线后第 1 个月内决策）

- 动机：单环境下开发热重载直接读写生产数据，任何开发期误操作即生产事故；上线后此风险从「可接受」变为「不可接受」。
- 方案：用 lark-apps-db skill 的 dev/online 多环境初始化与发布能力拆分环境；拆分时同步把演示/真实数据各就其位，并冻结 dev 环境对生产表的直接 DML 权限。
- 验收：dev 写入不影响 online 数据；online 发布流程不变。

### M3 功能增强候选（按业务优先级排期，非本轮承诺）

1. BI 指标下钻：毛利榜行点击展开项目成本构成（erp_project_cost 按 costType 聚合）。
2. 语义检索（`semantic-search` skill）：合同/项目库按内容找相似，用于售前复用历史方案。
3. 自动化扩展：客户信用额度触达预警（creditLimit 与 openAr 比对）接入现有 cron。
4. 性能核查：随数据量增长复查 erp_project_cost(period)/erp_ar(status) 等高频过滤列索引（建表时已有常规索引，量级上来后用 EXPLAIN 复核）。

---

## 五、前端 UI 优化升级设计及方案

### 5.1 全局共性问题（4 项，横跨所有页面，优先修）

| # | 问题 | 现状证据 | 改法 | 工作量 |
|---|---|---|---|---|
| G1 | 金额列未右对齐 | 全项目约 41 处 formatMoney 列左对齐，仅 voucher 页 2 列（voucher/components/VoucherPanel.tsx:349,356）做了 `align:'right'` | 所有金额表格列统一 `align:'right'`，配合 `render` 内 `tabular-nums` 等宽数字 | 小（机械改动，可一单元并行派发） |
| G2 | 空态两极分化 | crm/projects/finance/costs/audit/suppliers/dashboard 用 antd 默认「暂无数据」；hr/voucher/fin-expense/data-asset 有引导文案 | 统一 `locale.emptyText` 为引导式文案（「暂无XX，点击右上角「新增XX」创建」），抽公共常量 | 小-中 |
| G3 | 分页与卡片列数无约定 | `pagination={false}` 泛滥（crm/projects/costs/finance/hr/audit/suppliers/data-asset GrantPanel）；指标卡 grid-cols-3/4/5 混用（dashboard 4 与 5、admin-bills/rent 3） | 定规范：>20 行业务列表开启后端分页（table-skill）；同页卡片区统一列数，跨页不强拉齐但同域页面（admin 四页）统一为 4 列 | 中 |
| G4 | 状态色语义偏差 | biz-labels.ts:109-164 中「执行中/交付中/审批中」均映射 default 蓝，规范要求的「进行中=黄」未落地 | 校准 badge 变体映射：仅「生效/已批准」用蓝，流程进行态用黄（secondary/warning 系） | 小 |

### 5.2 页面级优化清单（按优先级）

**P0（随 G1-G4 一并做，纯规范落地）**

| 页面 | 问题（位置） | 改法 | 工作量 |
|---|---|---|---|
| dashboard | 金额列左对齐（DashboardPage.tsx:155-224）| 金额列右对齐 | 小 |
| crm | 两 Tab 空态默认文案（LeadsTab.tsx:259、OpportunitiesTab.tsx:269）；pagination=false 与 contracts 不一致 | 空态引导 + 与 contracts 对齐 | 小 |
| projects | 列表无 emptyText、pagination=false（ProjectsPage.tsx:146）| 同上 | 小 |
| costs | 4 Tab 均 pagination=false、无 emptyText（CostsTab.tsx:158-168 等）| G2/G3 套用 | 中 |
| finance | 金额列左对齐（ArTab.tsx:203-235、ApTab.tsx:219-239）；AgingTab 空态干瘪（:63）| G1/G2 | 小 |
| suppliers / audit / data-asset | pagination=false 或无 emptyText（SuppliersPage.tsx:339、AuditPage.tsx:150-156、GrantPanel.tsx:243）| G2/G3 | 小 |

**P1（体验增强，第二个迭代）**

| 页面 | 问题 | 改法 | 工作量 |
|---|---|---|---|
| dashboard | 指标卡 10 张信息密度平（无趋势/强调） | 核心卡（收入/毛利/营业利润）加月度环比箭头与次级文案；预算执行图「已执行/在途占用」色值改为绿+紫，与全局语义（蓝收入/橙成本/紫费用）对齐 | 中 |
| admin-bills / admin-rent | 指标卡 grid-cols-3 与他页不一（index.tsx:229、RentStatsCards.tsx:23）；页面标题手写未用 PageShell 规范 | 统一 4 列；标题走 PageShell | 小 |
| hr | 自写 h1 未用 PageShell（hr/index.tsx:34）；面板 pagination=false 为最不一致区 | PageShell 统一 + 分页规范 | 小 |
| 全局导航 | 图标重复：Calculator 用于成本+资产、Wallet 用于应收+行政缴费（Layout.tsx:48-75）；finance 页标题「财务中心」与导航「应收应付」不一致 | 去重图标（资产换 Building2/Laptop、行政缴费换 Receipt）；标题对齐 | 小 |

**P2（可选锦上添花）**

- 列表增删动效（AutoAnimate，见 animation-skill）：crm 线索、审批面板。
- 全局空态插画：为 G2 的引导文案配 generate_image 生成统一空态插画（后台系统类，最多一张通用）。
- 成本页动态指标卡加 costType 图标，提升扫读性。

### 5.3 实施建议

- G1-G4 + P0 页面清单为**一个迭代单元**（纯机械规范落地，可并行派发，验收=浏览器巡检抽查 5 页）。
- P1 为**第二个迭代单元**（涉及视觉决策，建议先出 1-2 张设计稿确认再铺开）。
- 全程遵守 AGENTS.md 设计规范与 shadcn/antd-table/table-skill 约束，禁止引入新 UI 库。

---

## 附：本轮核查方法留档

服务端/客户端日志（read_logs）、写接口鉴权 grep 扫描、触发器 GET 复核（admin_rent_expiry_remind Active=true / feishu_daily_sync Active=false）、/api/projects 演示数据抽查、17 页面代码级 UI 审查（Explore）、+release-list 发布历史、+access-scope-get 可见范围。所有引用文件路径以仓库当前版本为准。

---

## 6. 全量开工实施结果（2026-10-11）

- 演示数据清理：验收助手身份 + `[API_TEST]` 判据全库清点，44 表约 76 行按外键顺序事务删除，删除前全量留档至 `docs/api-test-data-archive/`（45 文件）；删后逐表复核清零，列表接口抽查无残留。
- UI 全量修复：G1 金额右对齐、G2 空态引导文案、G3 分页统一（pageSize 10 + showTotal）、G4 状态色黄系校准（进行中=黄，成功/生效=蓝绿）落地；dashboard 指标卡环比、预算图绿/紫配色、导航图标去重、hr PageShell、admin 指标卡列数对齐、成本指标卡类型图标完成。AutoAnimate 动效与空态插画未做（动效依赖未安装且收益低，纯文案空态已达成引导目的）。
- BI 毛利榜下钻：`GET /api/bi/projects/:id/cost-breakdown` + 毛利榜行展开按 costType 成本构成。
- 客户信用预警：`customer_credit_alert` cron（每日 09:00，Active=true），openAr ≥ creditLimit×80% 汇总通知 admin；阈值常量 `CREDIT_ALERT_RATIO`（admin.automation.ts）。SQL 命中逻辑已用插桩数据验证（超额命中 105%、未超不命中）。
- 语义检索：`rds_ai` + `vector` 插件，`erp_contract`/`erp_project` 增 `embedding vector(1024)` 列 + 触发器自动生成 + HNSW 索引；`GET /api/semantic/similar?type=&id=&limit=`；合同/项目列表行操作「找相似」弹层。实测距离分布（相似主题 0.196 / 无关 0.537），阈值 `SIMILARITY_MAX_DISTANCE=0.4`。
- 性能核查（只读）：核心表索引完备（code 唯一、customer/contract/project 外键、period、embedding HNSW）；status 等枚举过滤列暂无索引，空库起步量级可接受，数据量增长后再评估。
- 角色核对：仅「系统管理员」（admin）一个角色，成员 1 用户 + 1 群，信用预警收件人合理。

## 7. 移交清单（需用户本人操作/决策）

1. **可见范围**：`+access-scope-set` 配置上线后可见人员名单（当前默认范围）。
2. **多维表格插件配置（M1 前置）**：3 个 feishu-bitable 实例（成本出向 `erp_bitable_two_way_sync_1`、合同出向 `contract_ledger_archiving_1`、工时入向 `flexible_labor_hours_sync_1`）需在插件配置页填入各 Base 的 appToken 与 tableID，配完后激活 `feishu_daily_sync` 触发器。
3. **重新发布确认**：本轮含 DDL（embedding 列）与新模块，发布前走 `+release-*` 流程并确认。
4. **信用预警首日观察**：次日 09:00 核对 admin 是否收到扫描消息（无超限客户也应看到日志「无超限客户」）；阈值不合适改 `CREDIT_ALERT_RATIO` 后重新发布。
5. **多环境拆分（M2）**：当前单环境（开发即生产库），如需 dev/online 隔离执行 `+db-env-create`（不可逆，需单独决策）。
