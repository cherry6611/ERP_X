# 晟笙数据服务 ERP

数据服务公司独立 ERP 系统：CRM → 合同 → 项目 → 成本/收入核算 → 应收应付 → BI 看板 → 审计，全链路业务闭环。NestJS + React 全栈，Drizzle + PostgreSQL。

## 设计规范

- 风格：企业后台管理系统，紧凑密度。主色用 shadcn 默认 primary，背景 `bg-background`，卡片白色。
- 布局：固定左侧栏 `w-56`（分组导航），主内容区最小宽度自适应，页面容器统一 `p-6`，区块纵向 `gap-6`，并列卡片 `gap-4`。
- 排版：页面标题 `text-2xl font-semibold`，区块标题 `text-base font-semibold`，正文/表格 `text-sm`，辅助说明 `text-sm text-muted-foreground`。
- 组件：**数据表格一律用 antd `<Table>`**（`import { Table } from 'antd'`，列定义 `TableColumnsType`）；表单用 shadcn Form + Dialog（见 forms-skill）；图表用 ReactECharts，色板统一从 `theme/tokens.ts` 的 `seriesColor(...)` / `CHART_COLORS` 取（见 charts-skill）；图标只用 lucide-react。Card 禁止嵌套 Card。
  - ⚠️ **规范修正（§5.10 / P2-5）**：原文写「色板统一从 `utils/chart-colors.ts` 导入」，但实测**该模块只有 1 处引用**（`CostsPage.tsx`），其余 5 个图表文件都直接 `seriesColor(...)` —— 而 `seriesColor` 的真正定义处在 `theme/tokens.ts`（与 CSS 变量同源，暗色下能跟随主题）。规范指向了一个**事实上不是入口**的文件，与 F4 同一类问题（规范无法 grep 验证）。
    **但"禁止裸写色值"这条实际已达成**：实测 5 个图表文件中硬编码 `#RRGGBB` 为 **0 处**。所以这次只修规范文本，未改代码 —— 把 6 个文件统一迁到 `chart-colors` 反而是退化（多一层转发，且 `chart-colors` 不含暗色映射）。
    判据：**图表取色一律走 `seriesColor(语义键)`**（`revenue`/`cost`/`budget`/`other` 等），不要写十六进制，也不要在页面里自建色表。
  - ⚠️ **规范修正（§5.5 / F4）**：原文写「表格用 `@lark-apaas/client-toolkit/antd-table`」，但**该包未安装、也不在 `package.json` 依赖中**，全仓 0 引用（唯一命中是一句注释）。规范描述了一个不存在的实现，使"规范可 grep 验证"这一能力失效 —— 按它写的代码**根本编译不过**。现已改为指向真实在用的 antd `<Table>`（130 实例 / 87 文件）。
  - **shadcn `<Table>` 仅限非数据表场景**：打印件（`components/print/PrintDocument.tsx`）、Excel 导入预览（`components/excel/ExcelImportDialog.tsx`）、以及 `components/ui/table.tsx` 这一原子组件本身。判据：**需要分页 / 排序 / 固定列 / 横向 scroll / 空态钩子 → 必须 antd**。
  - 为什么不是"两套都行"：shadcn `Table` 是**纯样式表格**，没有分页、排序、固定列、`scroll` 横向容器与空态钩子。账簿明细、增值税底稿这类可达数千行的表用它 = **全量渲染**，且科目编码列在横向滚动时不会固定。
  - antd Table 的落地要点（`LedgersPage.tsx` 是完整范例）：`useMemo` 稳定 `columns` 与 `dataSource`（否则分页/排序状态每次渲染被重置）；聚合行用 `Table.Summary`（不是手写 `<tfoot>`）；下钻交互用 `onRow`；溢出文本用 `ellipsis`（自带 tooltip，优于 `truncate` 的静默截断）；**不要同时保留手写分页控件**。
- 共享组件（components/erp/）：StatCard 指标卡（icon + tone + delta，替代裸 border 卡）、FilterBar 筛选区卡片容器；PageShell 支持 actions 插槽（页头右侧主操作按钮）。Layout 含顶栏（面包屑 + 用户区 UserDisplay）。
- 状态展示：业务状态用 Badge（含 success/warning/info 语义 variant，映射见 utils/biz-labels.ts STATUS_VARIANTS）：草稿/待审批=灰，已生效/待回款=蓝，进行中/部分完成=黄，终态成功（完成/结项/回款/批准）=绿，驳回/逾期/超限=红。
- 所有交互按钮必须挂真实 handler；列表页必须有真实空态文案与失败反馈（toast 用 sonner，仅用于操作结果反馈）。
- 响应式：最小适配 1280px 宽即可。
- **数据层两套并存是有意的分工，不是遗留**（§5.6 复核结论）。判据一句话：
  **同一个 id 在多个组件里被解析 → TanStack Query；一个屏幕读自己的数据且在写后要刷新 → `useAsyncData`。**
  | 层 | 适用 | 为什么必须用它 |
  |---|---|---|
  | TanStack Query（`components/business-ui/api/*/queries.ts`） | 共享只读**实体解析**：userId → 姓名/头像（`UserDisplay`、`UserSelect`） | 同一 userId 出现在几十个组件里，缓存与**请求去重**消除 N+1；表格每行一个 `UserDisplay` 时去重是硬需求 |
  | `useAsyncData`（`hooks/useAsyncData.ts`） | **业务屏数据**：列表/详情/报表 | 每屏自管 `loading`/`error`/写后重取；**写后必须拿到新数据**，缓存的陈旧读在这里是 bug 而非优化 |
  ⚠️ **不要"统一掉"其中一套**：审计曾建议删除 `QueryClientProvider` 与 4 个 `useQuery`，实测该建议会**运行时崩溃** —— `useUsersByIds` 有 5 个真实调用方，消费链通到应用顶栏（`Layout.tsx` → `<UserDisplay>`）。判据"4 处 useQuery"数的是 hook **定义处**而非调用方。详见 `platform/AppContainer.tsx`。
  缓存策略：`staleTime` 5 分钟 + `gcTime` 10 分钟 + `retry: false`；若某业务确实需要"改名立即可见"，用 `clearUserCache` **显式失效**，不要把全局 `staleTime` 调成 0 去惩罚所有读取点。

## 架构约定

- 模块目录：`server/modules/<name>/`，页面 `client/src/pages/<name>/`，前端 API `client/src/api/<name>/`。
- 飞书 OAuth 登录：`FEISHU_REDIRECT_URI` 宿主须与 `APP_BASE_URL` / 浏览器一致（本地用 `127.0.0.1`，勿混 `localhost`，否则 state Cookie 失效）；飞书开放平台重定向 URL 须与 env 逐字符相同。未绑定飞书禁止自动注册：密码登录 → 设置页「绑定飞书」(`/api/auth/feishu/bind`) → 之后可用飞书登录；回调失败 302 到 `/login?feishu_error=…`。
- 飞书集成：插件实例 `send_erp_approval_notification_1`（审批通知，收件人=单据提交人+admin）、`erp_bitable_two_way_sync_1`（成本出向）、`contract_ledger_archiving_1`（合同出向）、`flexible_labor_hours_sync_1`（工时入向）；后三个为 feishu-bitable 插件，appToken/tableID 需用户在插件配置页填写。同步模块 `server/modules/feishu-sync/`，幂等映射表 `comp_feishu_sync_record`，cron 触发器 `feishu_daily_sync`（未激活）。
- 飞书云空间/知识库直连：`server/modules/feishu-drive/`（feishu-client/drive/wiki/config service），凭证存 `comp_feishu_drive_config` 单行配置表（RLS 不放行 anon），tenant_access_token 内存缓存提前 5 分钟刷新；前端页面 `/drive`、`/wiki`。云空间支持浏览/新建文件夹/新建文档/上传（限 10MB，base64 经 upload_all）/重命名/删除；知识库支持节点树浏览与云文档同步（`POST /api/wiki/sync`）。重命名/删除/同步/配置读写为 `@CanCapability('drive_write')`（仅 admin），浏览/新建/上传登录即可。知识库空间需用户在飞书侧把应用加为空间成员（可编辑），未授权时 131006→页面显示引导提示。
- 员工与飞书身份绑定：`md_employee.platform_user_id`（唯一表达式索引）；`GET /api/hr/employees/me` 按当前用户查绑定员工，工时填报自动带出。
- HR 三期扩展：员工自助 `GET /api/hr/my/summary`（档案/本月考勤/本年余额/已审批工资单）；补卡表 `hr_attendance_amendment`（审批通过后事务内生成 hr_attendance）；年假按司龄规则初始化（<1年5天、1-3年8天、3-5年10天、5-10年12天、≥10年15天，不覆盖已设置余额）；离职流转 `POST /api/hr/employees/:id/offboard`（状态机 probation/active→resigned，返回近 60 天确认工时的待交接项目）。
- 附件来源：`comp_attachment.source_type`（upload/feishu_doc）；云文档链接登记走 AttachmentField「云文档链接」按钮；审批通知自动附带单据附件链接；发票（erp_invoice）、报价单（crm_quotation）、成本凭证（erp_project_cost）、交付物验收单（erp_deliverable）均已放行附件类型，对应弹窗内可上传文件/登记云文档链接。
- 报价单：`crm_quotation` + `crm_quotation_item`（`server/modules/crm/quotation.*`，前端 CRM 页「报价单」Tab）；状态机 draft→pending_approval→approved→converted|void（驳回退回 draft）；金额后端计算落库（行金额=数量×单价×(1−行折扣)，总额再乘整单折扣，预估成本=数量×预估单价，毛利<20% 前端红色警示）；提交时复用 send_erp_approval_notification_1（bizType=quotation）；approved 一键转合同草稿（金额/客户带入、taxRate=6，同名合同查重防重复转换），与商机一键转合同并存。写接口均为 @CanRole(['admin'])。
- 交付物验收单：`erp_deliverable.accept_conclusion` 验收结论，accept 接口透传；验收通过弹窗（结论+附件 erp_deliverable）替代原一键验收，accepted 行可重开只读弹窗补看附件。
- 成本类型含 `flex_labor`（灵活用工）：兼职工（part_time/flex）工时确认自动归集到该类型。
- 发票台账：`POST /api/finance/invoices/:id/void` 作废（仅 issued；作废释放可开金额），表单支持手填发票号/开票日期；销项开票在事务内锁合同行校验可开金额；应收/应付核销事务内 FOR UPDATE 锁行防并发超核销。
- 成本多维：`erp_project_cost.department_id/contract_id`（工时确认自动带员工部门与项目合同，手动成本按项目归属部门/合同回填）；`GET /api/costs/dimension-summary?dimension=costType|department|contract|period` 多维汇总；工时确认时角色无生效费率则报错拒绝（不再生成 0 元成本），确认全程事务化防重复生成。
- 财务 P0：`GET /api/finance/cash-flow/forecast` 13 周滚动现金流预测（流入=未结应收按 dueDate 落周；流出=未付应付 + 每月工资固定流出（按最近已审批周期应发总额）+ 已审批未付报销；期初现金=已确认回款−已批付款；业务时区周一为周界）。发票进销项：`erp_invoice.direction`（sales/purchase，进项关联 `supplier_id`，销项可关联 `ar_id` 追溯回款核销，`PATCH /api/finance/invoices/:id` 补充关联）。项目财务健康：`GET /api/bi/project-financial-health`（预算 vs 实际，近 3 月成本线性外推完工成本；预警优先级 unreachable > over_budget > watch > healthy）。`erp_project.estimated_total_cost` 预计总成本可修订，创建/更新接口透传。
- 项目详情页工作台：`ProjectDetailPage` 主文件只做布局编排，区块全部由 `client/src/pages/projects/components/` 下 Section 组件承担（统一 props `{ projectId, onChanged }`，数据内部自取，写成功后回调 onChanged 联动顶部财务卡与 EVM），`ProjectDetailDialog` 复用同一批执行类 Section（里程碑/交付物/变更/结项）。详情页可直接登记发票（销项/进项）、应收/回款、应付/付款、成本、工时、收入确认（新增 `POST /api/projects/:id/revenues`，@CanRole admin）；「编辑项目」弹窗（ProjectEditDialog）走 updateProject；结项入口仅 accepting 状态渲染。项目附件（需求书/执行计划等）经 ProjectDocSection 挂 `resourceType='erp_project'`，文档类型用标题前缀 `[类型] 文档名` 承载（附件模型无类型字段）。
- 项目交付模块：交付物表 `erp_deliverable`（状态机 pending→submitted→accepted|returned，类型 dataset/report/software/doc/other，`deliverable.service.ts`）；里程碑基线/预测/权重（`erp_project_milestone.baseline_date/forecast_date/weight_pct`，创建时 baseline=forecast=plan_date）；有加权里程碑时进度按达成权重/总权重自动重算，无权重项目保持手动进度；EVM 挣值（`common/utils/evm.ts` 里程碑权重法，SPI/CPI/EAC，BI 健康项透出，无加权或分母为 0 时为 null）；结项闭环（全部交付物 accepted + 全部里程碑 reached + closeSummary 必填，`erp_project.close_summary/satisfaction/retrospective/closed_at`，同合同项目全部结项时回写合同 completed；结项后自动向 admin 推送结项报告飞书通知，复用 send_erp_approval_notification_1，失败不阻塞结项）；周预警 cron `delivery_warning_weekly`（周一 09:00，`delivery-warning.automation.ts`：逾期/7 天内到期里程碑 + SPI/CPI<0.9，复用 send_erp_approval_notification_1 通知 admin）。
- 应收回款提醒：`erp_ar.owner_user_id`（回款责任人，妙搭 userId 纯文本；登记弹窗 UserSelect 选择，列表 UserDisplay 展示）；cron `ar_due_reminder_daily`（每日 09:00，`finance/ar-reminder.automation.ts`：open 且 dueDate≤today+7 的逾期/临期单据按责任人分组发飞书，无责任人归 admin）；业务时区共享函数 `server/common/utils/biz-date.ts todayInShanghai()`；NotificationsService.sendUserNotification 可指定任意收件人。
- 外协供应商结算：`md_employee.supplier_id`（员工弹窗内兼职/灵活用工显示「所属供应商」）；工时确认生成 flex_labor 成本时回填 `erp_project_cost.supplier_id`；财务页应付 Tab「外协结算」弹窗按「供应商+月份(可选项目)」对账已确认工时×角色费率（erp_labor_rate 生效费率），`GET/POST /api/finance/vendor-settlement/{preview,generate}`；生成应付 `erp_ap_bill.source='vendor_settlement'`，查重键 `source_ref='VS:{period}:{supplierId}:{projectId|ALL}'`，重复生成 409。
- 项目周报/纪要：`erp_project_minutes`（weekly_report/meeting）；`GET/POST /api/projects/:id/minutes`、`DELETE /api/projects/minutes/:id`；项目详情页 MinutesSection（附件 resourceType='erp_project_minutes'）。
- 自动化任务总开关：`comp_automation_config` 表（task_key 主键 + enabled），行政页「自动化任务」（/admin-automation）可视化管理；`AutomationConfigService.isEnabled(taskKey)` 60s 内存缓存，6 个 cron handler（ar_due_reminder_daily / delivery_warning_weekly / project_drive_sync_daily / feishu_daily_sync / customer_credit_alert / admin_rent_expiry_remind）开头检查开关，停用则直接跳过；GET 公开登录态，PUT 仅 admin。
- 项目状态流转与结项闭环在 `projects-status.service.ts`（`projects.transform.ts` 提供 toProject/状态机表）；周报纪要在 `minutes.service.ts`；主 service 只剩查询/建改/合同链路。
- 聚合文件 `server/app.module.ts` / `client/src/app.tsx` / `client/src/api/index.ts` 由主 agent 维护，业务模块禁止改。
- **页面拆分（§5.9 / F8，全项目规则）**：页面主文件**只做布局编排与筛选区**，区块/表格/导出/表单一律拆到同目录 `components/` 或独立模块。原先是"仅 `ProjectDetailPage` 这么做"的局部约定，审计确认团队知道怎么拆、只是没在所有域执行，故升级为全项目规则。
  - **拆分判据**（按收益排序，都不要求"重写页面"）：
    1. **零耦合的纯函数先搬**：导出列定义、格式化、校验 —— 它们与组件状态无关，搬走后立刻变成**可单测**的（这是最大收益：`ledger-export-columns.spec.ts` 10 条断言原本无法存在）。
    2. **列定义单独成文件**：`TableColumnsType` 常有上百行，且"漏一列/列序错/`value` 取错字段"在界面上完全看不出来（导出照样成功，只是数字错位），必须能逐列断言。
    3. **每个 Tab / Section 一个组件**：统一 props，数据内部自取（`useAsyncData`），写成功后回调 `onChanged` 联动。
    4. 主文件保留：`PageShell`、筛选区、Tab 切换、跨 Tab 的导出按钮。
  - 参考实现：`pages/finance/ledgers/LedgersPage.tsx` + `ledger-exports.ts` + `ledger-export-columns.ts`（拆分后 1242 → 1193 行，且导出列定义获得 10 条单测）；`pages/projects/ProjectDetailPage.tsx` + `components/*Section.tsx`。
  - 单测落点：`jest.config.cjs` 的 `roots` 已含 `client/`。**前端纯逻辑模块（不依赖 React/DOM）必须配 spec** —— 依赖 React 的组件拆出来的纯逻辑模块正是最该测的部分。
  - ⚠️ 拆分时**不要改动行为**：一次只搬一个模块、搬完立刻跑 `type:check` + `lint` + `test`。按**行号**切割文件在插入代码后整体位移 —— 用**文本锚点**并先断言锚点唯一。
  - **豁免：`client/src/components/ui/` 不适用 500 行门槛**（`sidebar.tsx` 673 行是唯一超标者）。理由三条，都可核验：① 整目录由 shadcn CLI 管理（见 `components.json` 的 `aliases.ui`），`sidebar.tsx` 保留上游笔迹（`"use client"`、双引号 + 无分号），拆它 = fork 上游，下次 `npx shadcn add` 会冲突；② 它是**一组同主题原子组件**（24 个导出 + `useSidebar`），拆开只把同一套语境切碎，**不产生任何可单测的纯逻辑**，即 §5.9 的收益判据一条都不成立；③ `Layout.tsx` 自己手写了左侧栏（`localStorage['erp-sidebar-collapsed']` + `bg-sidebar` 自绘），与 `ui/sidebar.tsx` 的 `SidebarProvider`/cookie 方案无关 —— 实测**全仓 0 引用**。
    **判据**：§5.9 的 500 行门槛针对**业务代码**（`pages/`、`components/` 下非 `ui/` 的部分）。
  - ⚠️ **不要用审计报告的行数表格当清单** —— 它是时点快照，会同时**漏报**后来长大的文件与**误报**已拆掉的文件。用 `git ls-tree` + 当前源码现算，并**同时检查两个方向**：HEAD 超标而现在达标的、HEAD 未超标而现在超标的（本会话实测有 3 个文件属后者：`TaxDeclarationPage` 489→663、`TaxEntities` 380→527、`ReportsPage` 493→505）。收尾明细见 `docs/F8巨型组件拆分收尾说明-2026-10-16.md`。
- 前后端契约唯一权威：`shared/api.interface.ts`，属性一律 camelCase；请求参数类型（各 ListParams/Payload）也统一定义在 shared，`client/src/api/` 不得再本地定义 interface/type。
- 业务编号：`generateBizCode(db, table, table.code, 'PREFIX', now?, { bizType })`，编号结构与前缀/位数/重置策略由 `sys_code_rule` 配置（B-08）；规则缺失时按传入前缀与 `前缀+YYYYMM+4位流水` 回落（如 CTR2026100001）。**作废不重用**（B-09）：回退路径用 `MAX(seq)+1` 而非 `count()+1`，财务类单据（凭证/发票/收付款/工资单/应付/应收）禁止开启 `allow_reuse`。
- 期间/日期：业务时区 Asia/Shanghai，月份用 `YYYY-MM` 字符串；时间字段传输 ISO 字符串；新增日期逻辑必须用 `server/common/utils/biz-date.ts`。
- **接口鉴权（B-01）**：全部业务 controller 类级 `@NeedLogin()`；方法级**只用** `@CanCapability('x')`（写语义，要求矩阵中该能力为 `rw`）或 `@CanCapabilityRead('x')`（读语义，`r` 或 `rw` 均可）。**禁止 `@CanRole`**（`npm run check:rbac` 会拦）。角色→能力的唯一权威是 `shared/rbac.ts` 的 `MATRIX`；新增能力码必须同时登记到 `Capability` 联合类型与 `server/common/auth/route-capability.ts` 的映射表。前端按钮用 `<CanCapability capability="x">` / `<CanCapabilityWrite capability="x">` 包裹同步隐藏；路由级守卫见 `client/src/platform/RequireCapability.tsx`（未登录跳登录页，无权渲染明确提示而非空白）。员工自助保留登录态：补卡、请假、工时填报与确认、资产变更申请、采购申请、附件上传/云文档链接登记。
- **请求体 DTO（API-1）**：`@Body()` 必须是 **class DTO**（`implements` shared 同名契约类型 + class-validator 装饰器）；禁止 interface 或内联对象类型（运行时会擦除，`ValidationPipe` 静默放行任意请求体）。金额用 `@IsNumber({ maxDecimalPlaces: 2 })` + `@Min(0.01)`；期间用 `@Matches(/^\d{4}-(0[1-9]|1[0-2])$/)`；UUID 用 `@IsUUID()`。
  ⚠️ **DTO class 必须定义在 controller class 之前**：否则 SWC 编译到 CJS 后类声明仍是 `let/const`（TDZ），生产构建**启动时**会抛 `Cannot access 'X' before initialization`，而 `tsc --noEmit` 与 jest 都发现不了。
- **迁移顺序**：迁移按**文件名排序**执行，新迁移必须排在所依赖的建表迁移之后（先例：`2026-10-15-upgrade-batch1z-code-rules-seed.sql` 的 `z`）。改名前先跑 `npm run migrate:dryrun`（pglite 全量执行）。所有 DDL 必须幂等（`IF NOT EXISTS` / `DO $$ ... EXCEPTION WHEN duplicate_object`），文件头写 `-- requires:`。
- **新增查询统一走 Drizzle**，仅事务中间件保留裸 `pg`；**新增外部 IO（HTTP/文件流/通知）必须在事务外**。
- **数据级权限（B-02）**：行级可见范围由 `sys_data_scope` + `server/common/auth/data-scope.service.ts` 在 **SQL 层**注入条件（不能只在 UI 隐藏）；收窄但取不到值时必须 fail-closed 返回空集。
- **上传安全（B-06）**：`server/common/security/upload-policy.ts` 校验扩展名 + 大小 + **内容魔数**（改名伪装被拒），SVG 额外拦截脚本/事件；扫描结论落 `comp_stored_file.scan_status`，`none` 记为 `skipped` 而非 `clean`。附件版本链见 `FilesService.save({ parentFileId })` 与 `GET /api/files/:id/versions`。
- 状态机变更在 service 校验前置状态，非法流转抛 `BadRequestException`（消息必须为可读中文，CI 由 `node ./scripts/audit-error-messages.mjs` 审计）。
- 数据库表前缀：`md_`（主数据）、`crm_`（前端业务）、`erp_`（核算/合同/项目/财务）、`fin_`（账务/报表）、`hr_`（人事）、`sys_`（系统配置与安全）、`comp_`（合规）。
- **已由业务确认「不适用」的三项税务口径（2026-10-16，勿再作为未决项提出）**：① 小规模 1% 征收率的政策到期调整；② 差额征税 / 免税是否需独立档位；③ 跨主体交易是否视同销售。公司当前**没有**对应业务，故**不改代码**。若将来开展相关业务，需回到 `docs/待确认口径清单-2026-10-16.md` 第六节重新评估。
  - 同批确认的另两项：**票据贴现息 360 天基准**（无贴现业务，保持不动）、**销售退货不自动红冲成本**（保持现状，退货商品成本由业务手工调整 —— 分析毛利时须知此前提）。
- **数据资产能力码已与审计分离**：`/data-asset` 用 `data_asset`（不再沿用 `audit`），**仍仅 admin**。⚠️ **不要直接给 `data_asset` 加角色** —— `da_dataset` 虽关联 `contract_id`，但该模块**尚无 SQL 层行级过滤**，加角色即等于跨合同可见。要放开必须先实现行级收窄（`server/common/auth/data-scope.service.ts`）。
- 测试/演示数据：一律以 `[API_TEST]` 前缀命名；接口自测数据用后即删，删除前留档至 `docs/api-test-data-archive/`；生产库不保留演示数据。
- 运维与进度台账：`docs/RUNBOOK.md`（健康检查/账务核对/迁移回滚/备份演练/定时任务）、`docs/升级落地状态台账-2026-10-15.md`（逐条需求落地状态与遗留清单）、`docs/B14-error-message-audit.md`。
