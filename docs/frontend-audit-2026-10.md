# 前端审计报告（client/src）— 2026-10

范围：`code/client/src/**`（React 19 + TS + Vite + react-router-dom v7 + antd v6 + shadcn/Radix + Tailwind 4 + sonner）。
基准：`code/AGENTS.md`（设计规范 / 架构约定 / B-01 RBAC / API-1 DTO / 业务时区）。
方法：grep/glob 全量扫模式 → 读高信号文件人工确认。**只读分析，未修改任何文件。**
共 40 条，按严重度排序。

---

## Critical（错数据显示 / 写入失守 / RBAC 漏洞）

### C1. 路由级能力守卫只按 pathname 精确匹配 → 一批路由完全绕过（含财务/项目/合同写入口）
`client/src/platform/RequireCapability.tsx:53`（缺陷点）+ `shared/rbac.ts:103-133`（`NAV_CAPABILITY` 只有 25 个精确 key）
**问题**：`const required = capability ?? NAV_CAPABILITY[location.pathname];` 取不到时 `if (!required || hasCapability(...)) return <>{children}</>` —— **取不到就放行**。`NAV_CAPABILITY` 只登记了列表页静态路径，以下真实路由（`client/src/app.tsx`）全部取不到 key，因此**任何登录用户**都能进入：
- `finance/invoices/new`（app.tsx:154，发票登记表单）
- `notes`（app.tsx:133）、`returns`（app.tsx:135）—— 无对应能力码
- `projects/new`(159)、`projects/:id/edit`(161)、`contracts/new`(152)、`contracts/:id`(153)、`crm/leads/new`(138)、`crm/opportunities/new`(140)
- `finance/reports`(193)、`finance/ledgers`(194)、`finance/year-end`(196)、`bi/metrics`(131)
- `admin-rent/:id`(185)、`fin-expense/applies/:id`(170) 等全部 `:id` 详情页
**为什么重要**：这是本审计中影响面最大的结构缺陷。前端守卫的**默认值是"允许"**，于是每新增一个路由都必须记得登记能力码，漏登记不报错、不告警，与 `auth.tsx:60-72` 特意收窄 `Capability` 类型以"让拼错编译期失败"的初衷正好相反。后端 Guard 仍然拦得住写操作，所以不是提权，但只读角色可进入表单、填完点保存才被 403 拒绝（正是 `RequireCapability.tsx:85-86` 自己声明要避免的场景）。
**修复**：改为**最长前缀优先**匹配（`NAV_CAPABILITY` 加 `'/finance/'`、`'/crm/'`、`'/admin-'`、`'/projects'` 等前缀项），并把取不到 `required` 改为 **fail-closed**；同时用 `app.tsx` 的路由表与 `NAV_CAPABILITY` 做一次 CI 校验（列出"有路由无能力码"的路由）。

### C2. `NotesPage` / `ReturnsPage` 完全未挂 `<CanCapabilityWrite>`，且其路由无守卫（C1）
`client/src/pages/notes/NotesPage.tsx:172,222`；`client/src/pages/returns/ReturnsPage.tsx:172,201,203`
**问题**：这两个页面共 5 处写调用（`createNote` / `noteAction` / `createPurchaseReturn` / `purchaseReturnAction` / `salesReturnAction`）**没有任何能力判定**；`notes`、`returns` 也不在 `NAV_CAPABILITY` 中。票据（`erp_note`）与退货都会动账务口径。
**为什么重要**：`finance_viewer`（财务只读）打开 `/notes`，看到"贴现/质押/兑付"按钮并可直接触发。对照 `ArTab.tsx:367-383`、`AP` 等同域页面均已正确包裹，说明这是遗漏而非有意放开。
**修复**：两页所有写按钮包 `<CanCapabilityWrite capability="finance_write">`（退货若属项目域则 `projects_write`），并把 `'/notes'`、`'/returns'` 登记进 `NAV_CAPABILITY`。

### C3. 固定资产域：`/asset` 路由对只读角色可见，但减值/处置写按钮未加判定
`client/src/pages/asset/components/AssetDisposalPanel.tsx:103,129,147,169,225,233`；`client/src/pages/asset/components/AssetImpairmentPanel.tsx:91,118,140,198`
**问题**：`shared/rbac.ts:71-75` 中 `pur_asset` 对 `finance_viewer`、`project_manager` 均为 `r`（只读）；`server/common/auth/route-capability.ts:113-118` 中 `api/asset` 的 `write: null` ⇒ 写能力 = `pur_asset`，而后端要求 `rw`（仅 admin）。但这两个面板的「计提减值」(`AssetImpairmentPanel:133-141`)、「删除」(`:194-201`)、「发起处置」(`AssetDisposalPanel:162-170`)、「完成」(`:221-228`)、「驳回」(`:229-236`) 全是裸 `Button`，**没有 `<CanCapabilityWrite capability="pur_asset">`**。对照：同域的 `AssetPanel.tsx:384`、`AssetChangePanel.tsx:101`、`AssetDepreciationPanel.tsx:135` 都已正确包裹 —— 明显是同批改造漏改两个文件。
**为什么重要**：只读角色能触发**资产处置凭证**（借 1603/1602/1604、贷 1601，收益 6301 / 损失 6711）与**减值凭证**（借 6701 / 贷 1604），并删除已计提减值记录。这是账实不符类风险，不只是体验问题。
**修复**：把上述 5 个按钮（含弹窗底部提交按钮）包进 `<CanCapabilityWrite capability="pur_asset">`。

### C4. 财务对账「解绑」写操作未加判定
`client/src/pages/finance/ReconciliationTab.tsx:54-63,148-154`
**问题**：`unbind()` 调 `financeApi.unbindPurchaseAp(invoiceId)`（`api/finance/index.ts:332-338`），按钮在 `:148`，**没有任何 can* 包裹**，文件也未 import `platform/auth`。所在 `/finance` 路由能力码为 `finance`，`finance_viewer` 有 `r`。
**为什么重要**：解绑进项发票↔应付会改变勾稽结果与总账口径（该页顶部就在展示"收入口径勾稽差异"），只读财务能一键改动。
**修复**：`<CanCapabilityWrite capability="finance_write">` 包裹 `:148` 的按钮。

### C5. `BatchAllocationPanel` 未加判定（同页的单项目分摊却加了）
`client/src/pages/costs/components/BatchAllocationPanel.tsx:103-166,310-313`（渲染点 `client/src/pages/costs/AllocationTab.tsx:106`）
**问题**：`AllocationTab.tsx:191-193` 的「登记分摊」包了 `<CanCapabilityWrite capability="projects_write">`，但**同一页上方**无条件渲染的 `<BatchAllocationPanel>`（`AllocationTab.tsx:106`）内部整个表单与「按权重分摊」按钮无任何判定。
**为什么重要**：`/costs` 能力码是 `projects`，`finance_viewer` 亦有 `r`；批量分摊会一次生成多条项目成本（`costsApi.createAllocationBatch`）。只读角色能看到并提交整个多项目分摊表单，是"同一页面两套权限口径"的典型缺陷。
**修复**：在 `AllocationTab.tsx:106` 用 `<CanCapabilityWrite capability="projects_write">` 包住 `<BatchAllocationPanel>`，或在面板内部包 `:310-313` 的提交按钮（并同步隐藏整个表单）。

### C6. `/settings` 对全员开放，但「字典设置」「参数设置」Tab 无判定
`client/src/pages/settings/SettingsPage.tsx:404-413`；`client/src/pages/settings/DictionarySettings.tsx:175,195,211`；`client/src/pages/settings/ParameterSettings.tsx:74`
**问题**：`shared/rbac.ts:99` 中 `settings_appearance: { admin: 'rw', _default: 'r' }` ⇒ **任何已登录用户**（`roles` 非空但无 `settings_appearance` 时走 `_default`）都能通过守卫（`RequireCapability.tsx:54`）。`SettingsPage.tsx:163/279` 给品牌与飞书卡片加了 `settings_brand`/`settings_feishu` 判定，但 `:404-413` 新增的「字典设置」「参数设置」两个 `TabsTrigger`/`TabsContent` **完全没包**。
**为什么重要**：普通用户可打开参数编辑弹窗、删除字典项、改保留策略。后端 `route-capability.ts:155-160`（`api/system` → `admin_ops`）会拦，但 UI 暴露了必然 403 的写入口，且字典是 B-05 的文案唯一权威，误操作面很大。
**修复**：两个 `TabsTrigger` + `TabsContent` 外层包 `<CanCapabilityWrite capability="admin_ops">`（或把这两 Tab 移到仅 admin 的路由）。

### C7. `ensureNotForbidden` 是死代码 → 403 无中文提示（47 处调用全部无效）
`client/src/utils/api-error.ts:14-19`；调用点如 `api/finance/index.ts:47,60,68`（全仓 161 处引用）
**问题**：注释写"403 是正常 HTTP 响应、不会进 axios catch，需在 then 链路中显式检查"。但 `platform/request.ts:9-51` 的响应拦截器**只处理 `onFulfilled`，未把 403 resolve**，axios 对 403 直接 reject ⇒ 成功分支永远看不到 `status === 403`，`ensureNotForbidden` 的 `if` 永不成立。
**为什么重要**：C1–C6 讨论的"点了被后端拒"场景下，用户看到的是后端原始 403 文案而不是统一的「无操作权限，请联系管理员分配角色」；同时**60 个写接口里另有约 51 个没调它**（如 `api/admin/index.ts:80,91,131,142,177,188,215,226`、`api/costs/index.ts:64,69,87,101`、`api/hr/index.ts:135,166,240`），形成"有的写操作有权限提示、有的没有"的随机体验 —— 说明该函数从未真正起作用，调用点是照着模板抄的。
**修复**：删掉 `ensureNotForbidden` 与全部调用，改在 `platform/request.ts` 拦截器的 `onRejected` 中统一：`status === 403` → `toast.error('无操作权限，请联系管理员分配角色')` 并抛出带该 message 的错误，配合已有的 `data.error.message` 回填（`:42-49`）。

### C8. 用 UTC 计算业务日期默认值（4 处写表单，北京时间 00:00–08:00 差一天）
`client/src/pages/asset/components/AssetImpairmentPanel.tsx:47,50`；`client/src/pages/asset/components/AssetDisposalPanel.tsx:61`；`client/src/pages/returns/ReturnsPage.tsx:104`；`client/src/pages/notes/NotesPage.tsx:88`
**问题**：`new Date().toISOString().slice(0, 10)` 取的是 **UTC** 日期，北京时间 00:00–08:00 之间比业务时区**早一天**（`AGENTS.md:41` 规定业务时区 Asia/Shanghai，`server/common/utils/biz-date.ts todayInShanghai()` 为准）。这些值直接作为 `testDate`/`period`/`applyDate`/`returnDate`/`discountDate` **提交给后端**。
**为什么重要**：`AssetImpairmentPanel:50` 的 `period`（`YYYY-MM`）用于期间闸门与凭证落账，跨月时（如 11-01 早 8 点前）会把减值凭证记到**上一个月**；期间已结账时会被 `assertPeriodOpen` 直接拒绝，表现为"莫名其妙因为期间关闭而失败"。同仓已存在正确实现 `utils/format.ts:36-45 todayIso()/currentPeriod()`，且 `VoucherPanel.tsx:96-97`、`PayBillDialog.tsx:55`、`TimesheetsTab.tsx:90`、`PurOrderPanel.tsx:134` 都在用 —— 这 4 处是漏改。
**修复**：改 `import { todayIso, currentPeriod } from '@client/src/utils/format'`，分别替换 `.slice(0,10)` → `todayIso()`、`.slice(0,7)` → `currentPeriod()`。

---

## High（可能的 bug / 时区 / 陈旧 UI）

### H1. `dayjs()` 走浏览器本地时区，用于"今天/逾期"判定与提交（4 处）
`client/src/pages/projects/components/MilestoneSection.tsx:38`；`client/src/pages/projects/components/DeliverableSection.tsx:179,218`；`client/src/pages/fin-expense/components/FullBudgetPanel.tsx:47`；`client/src/pages/hr/components/AttendancePanel.tsx:289`
**问题**：`dayjs()` 未指定 tz ⇒ 浏览器本地时间。`MilestoneSection:38` 的 `isMilestoneOverdue` 与 `DeliverableSection:247` 的 `v < todayStr` **以本地"今天"判定后端用上海时区生成的日期**，跨时区/UTC 用户会看到提前一天变红（或该红不红）。`DeliverableSection:179` 的 `acceptDate` 只是打印提示，影响小；`FullBudgetPanel:47` 的 `currentYear` 与 `AttendancePanel:289` 的年度初始化同理偏一天。
**为什么重要**：逾期红标与预警（`delivery_warning_weekly` cron 用上海口径）**不一致**，同一交付物在页面上和飞书通知里"过期状态"不同。
**修复**：`MilestoneSection.tsx:38`、`DeliverableSection.tsx:218` 改用 `todayIso()`；`FullBudgetPanel.tsx:47` 改 `todayIso().slice(0,4)`；`AttendancePanel.tsx:289` 改 `currentPeriod().slice(0,4)`。

### H2. `AttendancePanel` 年度用本地时区、月份用上海时区（同屏两套口径）
`client/src/pages/hr/components/AttendancePanel.tsx:99`（`currentPeriod()`，正确）vs `:103`（`new Date().getFullYear()`，本地时区）
**问题**：同一个面板里"月份"按上海算、"年假余额年度"按浏览器本地算。UTC 用户在 1 月 1 日 00:00–08:00 之间会得到 `month = 2027-01` 而 `balanceYear = 2026`（或反之）。
**修复**：`:103` 改 `useState<string>(currentPeriod().slice(0, 4))`，与 `:99` 同源。

### H3. 发票/付款状态文案存在"同名两份、取值不同"
`client/src/pages/finance/ApTab.tsx:69-74`（`PAYMENT_STATUS_LABELS.paid = '已支付'`）、`client/src/pages/finance/ArTab.tsx:58-70`（`AR_STATUS_LABELS.open='未核销'`、`RECEIPT_STATUS_LABELS.matched='已核销'`）vs `client/src/utils/biz-labels.ts:124-155`（`AR_STATUS_LABELS.open='待回款'`、`RECEIPT_STATUS_LABELS`、`PAYMENT_STATUS_LABELS.paid='已核销'`）
**问题**：`ApTab`/`ArTab` 各自本地定义了**与 `biz-labels.ts` 同名**的常量，且取值不同；`ArApSection.tsx:66` 又重复一份 `PAYMENT_STATUS_LABELS`。于是**同一状态在不同页面文案不同**（AP 列表页"已支付" vs 项目详情"已核销"、AR"未核销" vs 共享字典"待回款"）。
**为什么重要**：`AGENTS.md:12` 要求状态文案统一由 `biz-labels.ts` 的 `STATUS_VARIANTS`/字典驱动，B-05 的整个目的是"业务方改字典即生效"。本地副本绕过了字典回退，导致**改字典对这两个主要财务页无效**，且页面间自相矛盾。
**修复**：删除 `ApTab.tsx:62-74`、`ArTab.tsx:58-70`、`ArApSection.tsx:61-71` 的本地定义，统一 `import { AP_STATUS_LABELS, AR_STATUS_LABELS, PAYMENT_STATUS_LABELS, RECEIPT_STATUS_LABELS } from '@client/src/utils/biz-labels'`。

### H4. `TimesheetsTab` 工时登记/确认/退回按钮未加判定
`client/src/pages/costs/TimesheetsTab.tsx:141,184,257,219,225,228,261-269`
**问题**：`/costs` → `projects`（`finance_viewer` 有 `r`）。「登记工时」(`:257`)、表格内「提交」(`:219`)/「确认」(`:225`)/「退回」(`:228`)、「从多维表格导入工时」(`:261-269`) 全部无 can* 包裹，文件也未 import `platform/auth`（仅 `AllocationTab`、`RatesTab`、`CostsTab` 有）。确认工时 = 折算成本（`AGENTS.md:29`），是真正的写入。
**修复**：登记/提交/确认/退回包 `<CanCapabilityWrite capability="projects_write">`；导入按钮 `feishuSyncApi.syncTimesheetsFromBase` 同理（或明确注释为员工自助放行）。

### H5. `useAsyncData` 的 `deps` 以数组引用直接传给 `useCallback`
`client/src/hooks/useAsyncData.ts:3,26-30`
**问题**：`const load = useCallback(async () => {...}, deps)` —— `deps` 是**参数而非字面量数组**，`react-hooks/exhaustive-deps` 不会校验，也永远不会提示"loader 用了某个值但没写进 deps"。当前 62 个调用点都传了字面量数组（行为正确），但 `VoucherPanel.tsx:232` 已经不得不写 `[requiredAuxCodes.join(','), watchedPeriod]` 这种"用字符串造依赖"的绕法，说明这个签名在逼调用方做怪事。
**为什么重要**：一旦某个调用点漏写依赖（例如新增过滤条件忘记加进数组），表现为"改了筛选但列表不变"或"提交后 reload 用旧参数"，且**没有任何静态检查能发现**。这是全仓 62 处数据加载的公共风险点。
**修复**：改为 `useAsyncData(loader, deps)` 内部做 `const key = JSON.stringify(deps)` 再 `useCallback(..., [loader, key])`，或把签名改成 `useAsyncData(loader, deps)` 但用 `useEffect(..., deps)` + `useRef(loader)` 持有最新 loader（避免要求调用方保证 `useCallback` 稳定）。

### H6. `StatementTab` 用 effect 同步对手方，存在竞态覆盖用户选择
`client/src/pages/finance/StatementTab.tsx:92-94`
**问题**：`useEffect(() => { setCounterpartyId(options?.[0]?.id ?? '') }, [options])`。切换 direction 时 `options` 重新请求；若用户在旧请求返回前手选了对手方，旧 `options` 晚到会把选择**复位成第一项**。
**为什么重要**：对账单页是打印/交付给客户的外部单据（`StatementTab.tsx:284` 有 `generatedAt` 打印），静默换成另一个对手方的数据属于"错数据"。
**修复**：把 `direction` 纳入守卫 —— 仅在 `direction` 变化后的首次 `options` 到达时设置默认值（`useRef` 记录上次 direction），或直接在 `setDirection` 的 handler 里清空 `counterpartyId`，effect 只做"当前值为空时补默认"。

### H7. `ProjectEditDialog` 每次打开都覆盖用户未保存的编辑
`client/src/pages/projects/components/ProjectEditDialog.tsx:71-82`
**问题**：`useEffect(..., [open, project, form])` 在 `open` 为 true 时 `form.reset(...)`。`project` 是对象 prop，父组件每次渲染（例如详情页 `onChanged` 后的 reload）都可能给出新对象引用 ⇒ `useEffect` 重跑 ⇒ **正在编辑的表单被重置**。
**为什么重要**：用户填到一半，后台轮询/联动刷新把输入清空，且无任何提示。
**修复**：改为仅在"从关闭变为打开"时 reset：用一个 `useRef<boolean>` 记录上次 `open`，或把 `project` 拆成原始值（`project.id`、`project.updatedAt`）作为依赖。

### H8. `PurOrderPanel` 验收数量无上限校验：可超过未收数量
`client/src/pages/pur/components/PurOrderPanel.tsx:80-83`（`acceptSchema`）、`:137-143`（`openAcceptDialog`）
**问题**：`openAcceptDialog` 用 `order.quantity - order.acceptedQuantity` 预填，但 `acceptSchema` 只有 `z.coerce.number().int().min(1, '验收数量至少为 1')` —— **没有 `max` 上限，也没有"不得超过剩余未收数"的 refine**。
**为什么重要**：超收会让采购订单累计验收量 > 订购量，进而污染后续入库/应付匹配。`orderSchema`（`:62`）的订购数量有 `min(1)` 但验收数量没有任何上界，用户手改输入框即可越过。数量语义完全依赖后端兜底，前端不拦则错误要到提交后（甚至落库后）才暴露。
**修复**：`acceptSchema.quantity` 改为 `.max(...)`，上限由 `openAcceptDialog` 时选中的 `order.quantity - order.acceptedQuantity` 提供（把它一起 `reset` 进表单或用 `z.refine` 对照 `acceptTarget` 校验），并在 `setAcceptTarget(order)` 之后 `await acceptForm.trigger('quantity')`。

### H9. `DataMaskPanel` 的字段删除与授权撤销未加判定
`client/src/pages/data-asset/components/DataMaskPanel.tsx:153-160,299-306,584-595`
**问题**：`removeField`（`deleteDatasetField`）与 `submitRevoke` 均无 can* 包裹。所在 `/data-asset` 能力码为 `audit`（`shared/rbac.ts:86` 仅 admin），所以**当前不可达**，但 `GrantPanel.tsx:221`、`DatasetPanel.tsx:191` 同文件同域都加判定（且用 `projects_write`/`crm_write`），说明这里被漏掉。一旦 `/data-asset` 的能力码放宽（`route-capability.ts:161-166` 的 note 已写明"沿用 audit 能力码"是权宜约定），即成真实漏洞。
**修复**：与 `DatasetPanel`/`GrantPanel` 保持一致补判定，把"为什么用 crm_write/projects_write"的口径写明。

### H10. `/wiki` 与 `/crm/*`、`/suppliers` 的写按钮依赖列表页判定，独立入口无保护
`client/src/pages/wiki/WikiPage.tsx`（`/wiki` 走 `drive` 能力码，`drive_editor` 有 `rw`，`user_admin`/`hr_manager`/`finance_viewer`/`project_manager` 均 `r`；`route-capability.ts:143-148` 明确 `api/wiki` 写 = `drive_write`）；`client/src/pages/crm/LeadDetailPage.tsx:22`、`client/src/pages/finance/InvoiceDetailPage.tsx:41`（详情页从列表全量拉取后自行渲染操作区）
**问题**：`/wiki` 的"同步云文档"写入口（`api/wiki/sync` → 页面上的同步按钮）需 `drive_write`，但 `WikiPage` 未 import `platform/auth`（与 `DrivePage` 同域，`NAV_CAPABILITY['/wiki'] = 'drive'` 只保证可读）。详情页类（leads/invoices/quotations 详情）从 `listLeads()`/`listInvoices()` 取全量后在本地 `find`，操作按钮的显隐只看 `record.status`，不看能力。
**为什么重要**：只读角色（`finance_viewer`）能进 `/wiki` 并看到同步入口；详情页 URL 直连时按钮状态与列表页不一致（列表页按钮藏了，详情页还显示）。
**修复**：`WikiPage` 的同步/写入按钮包 `<CanCapabilityWrite capability="drive_write">`；详情页操作区统一包 `crm_write`/`finance_write`，不再依赖"从列表点进来时按钮恰好被藏住"。

---

## Medium（质量 / 一致性）

### M1. `ProjectCreatePage` / `ProjectEditPage` / `LeadCreatePage` / `OpportunityCreatePage` 无能力判定
`client/src/pages/projects/ProjectCreatePage.tsx:114`；`client/src/pages/projects/ProjectEditPage.tsx:115`；`client/src/pages/crm/LeadCreatePage.tsx:64`；`client/src/pages/crm/OpportunityCreatePage.tsx:65`
**问题**：整页表单（含提交按钮）无 `CanCapabilityWrite`。与 `ProjectsPage.tsx:185`、`OpportunitiesTab.tsx:168`、`LeadsTab.tsx:173` 的列表页判定不一致 —— 列表按钮藏了，直连 URL 仍能填完整表单。
**修复**：页级包 `<CanCapabilityWrite capability="projects_write" fallback={<无权限提示/>}>`（CRM 用 `crm_write`），或按 C1 的 fail-closed 前缀守卫统一拦。

### M2. 日期辅助函数三份重复实现
`client/src/components/erp/DateField.tsx:12-17`、`client/src/pages/admin-bills/components/PayBillDialog.tsx:30-34`、`client/src/pages/finance/InvoicesTab.tsx:89-94`（三份 `toLocalDate`，逻辑完全相同）
**问题**：`AGENTS.md` 要求公共逻辑复用；`DateField` 已导出等价能力却未被复用（`PayBillDialog` 与 `DateField` 内部各写一份）。
**修复**：在 `utils/format.ts` 导出 `toIsoDate(date: Date): string`，三处改 import。

### M3. 状态/类型标签字典在 8+ 个文件中重复定义
`client/src/pages/finance/InvoicesTab.tsx:71-84` 与 `client/src/pages/finance/InvoiceDetailPage.tsx:20-34`（`INVOICE_TYPE_LABELS`/`INVOICE_STATUS_LABELS`/`DIRECTION_LABELS` 三份逐字重复）；`client/src/pages/projects/components/InvoiceSection.tsx:64-70`；`client/src/pages/finance/InvoiceDetailPage.tsx:20`；`client/src/pages/projects/components/DeliverableSection.tsx:43`、`AssetDisposalPanel.tsx:40`、`StatementTab.tsx:49`、`NotesPage.tsx:48`、`ChangeSection.tsx:42,48`
**问题**：`biz-labels.ts` 已是"标签唯一来源（B-05）"，但这些常量各自本地定义，且 `INVOICE_TYPE_LABELS` 在 `biz-labels.ts:163` 与 `InvoicesTab.tsx:71` **取值不同**（共享版缺 `electronic`，本地版有）。新增发票类型时必然漏改其中一处。
**修复**：全部收口到 `utils/biz-labels.ts`（`INVOICE_STATUS_LABELS`、`DIRECTION_LABELS` 等新增导出），删除本地副本。

### M4. `api/**` 内联对象类型（AGENTS.md:39 明令禁止）
`client/src/api/asset/index.ts:145-150`（`listImpairments(params?: { assetId?... })`）、`:177-182`（`previewDisposal`）、`:190-195`（`listDisposals`）、`:123-132`（`getOwnership` 的 `get<{...}>`）；同类：`client/src/api/finance/index.ts:278-286`（`as Array<{...}>`）、`client/src/api/fin-budget/index.ts:80,94`、`client/src/api/finance-reports/index.ts:280,311,325,340,354`、`client/src/api/settings/index.ts:11,37`、`client/src/api/data-asset/index.ts:169`、`client/src/api/voucher/index.ts:91`、`client/src/api/feishu-drive/index.ts:28,97,104,121`、`client/src/api/notes/index.ts:31,72,94`、`client/src/api/returns/index.ts:19,120`、`client/src/api/crm/index.ts:105,115`
**问题**：`client/src/api/` 未定义 `interface`/`type`（这一点是合规的，见"实际上没问题"），但**内联对象类型**随处可见，`api/system-config/index.ts:14-20` 的注释还自称"本模块不声明任何本地类型（check-contract.mjs 会拒绝内联对象类型）"—— 说明约定存在但校验脚本没覆盖这些写法。这 20+ 处类型无法被前后端契约校验发现漂移。
**修复**：把这些参数/返回类型移入 `shared/api.interface.ts`（如 `AssetImpairmentListParams`、`AssetOwnership`、`ArWriteoffItem`），`api/**` 只 import。

### M5. 混用 `.then()` 与 `async/await`
`client/src/pages/contracts/ContractDetailDialog.tsx:174,446,839,913`；`client/src/pages/drive/DrivePage.tsx:291,311,326,345`；`client/src/pages/settings/SettingsPage.tsx:82,92,103`；`client/src/pages/costs/TimesheetsTab.tsx:114`；`client/src/pages/projects/components/TimesheetSection.tsx:118`；`client/src/components/CommandMenu.tsx:90`
**问题**：同文件内两种风格并存（`ContractDetailDialog` 有 4 处 `.then()` 且其余逻辑是 `await`）。`ContractDetailDialog.tsx:839,913` 的 `.then(() => {...})` 把"成功后的状态更新"藏在链尾，异常路径与 `await` 分支不一致。
**修复**：统一改 `async/await` + `try/catch`（`SettingsPage.tsx:82-113` 的三段可合并成一个 `useEffect` 内的 `Promise.all`）。

### M6. 错误提示两种写法并存，部分分支绕开 `getApiErrorMessage`
`client/src/pages/costs/TimesheetsTab.tsx:154,188`；`client/src/pages/projects/components/ProjectEditDialog.tsx:100`；`client/src/pages/costs/AllocationTab.tsx:69`（`err instanceof Error ? err.message : '...'`）vs 同仓 `getApiErrorMessage(err, '...')`（如 `TimesheetsTab.tsx:169`）
**问题**：直接读 `err.message` 依赖 `platform/request.ts:42-49` 的拦截器把 `data.error.message` 回填进 `message` —— 能用但不显式，且拦截器一旦调整（例如改抛新 Error），这些分支会静默退化成英文 "Request failed with status code 400"。
**修复**：统一 `getApiErrorMessage`。

### M7. 42 个组件超过 `AGENTS.md` 的 ~400 行可维护上限
最大者：`client/src/pages/hr/components/EmployeePanel.tsx`(994)、`client/src/pages/finance/ledgers/LedgersPage.tsx`(994)、`client/src/pages/finance/ApTab.tsx`(992/1024)、`client/src/pages/hr/components/AttendancePanel.tsx`(969/1001)、`client/src/pages/finance/InvoicesTab.tsx`(944/972)、`client/src/pages/contracts/ContractDetailDialog.tsx`(912)、`client/src/pages/projects/components/ArApSection.tsx`(899/929)、`client/src/pages/notes/NotesPage.tsx`(891/917)、`client/src/pages/voucher/components/VoucherPanel.tsx`(841/873)
**问题**：`AGENTS.md:31` 已为 `ProjectDetailPage` 定了"主文件只做布局、区块下沉到 components"的模式，但上述 9 个文件把列表 + 4 个弹窗 + 表单 + 打印 + 导出全放一个文件，JSX 嵌套深度普遍 8 层以上（`ApTab` 单文件含 4 个表单 schema + 4 个 Dialog）。
**修复**：按 `ProjectDetailPage` 的模式拆分（每个 Dialog / 每个 Tab 一个文件），优先拆 `ApTab`、`InvoicesTab`、`EmployeePanel`、`AttendancePanel`。

### M8. `ProjectDocSection` / `AttachmentField` 各自实现一份上传删除逻辑
`client/src/pages/projects/components/ProjectDocSection.tsx:264,326-328`；`client/src/components/attachments/AttachmentField.tsx:150,211-213`
**问题**：两处都直接调 `dataloom.storage.from(getDefaultBucketId()).uploadFile/remove`，再各自调 `createAttachment`/`deleteAttachment`。删除时**先删存储再删记录**（`AttachmentField.tsx:211` → `:213`），若第 2 步失败则留下"DB 有记录、文件已没了"的坏数据；且服务端已有 `upload-policy.ts`（`AGENTS.md:48` 扩展名+大小+魔数+扫描结论）与附件版本链，前端直连存储绕过了这条链路的一致性（`AttachmentField.tsx:134-142` 只校验 20MB，与后端策略不同源）。
**修复**：把上传/删除收敛为一个 `useAttachmentActions(resourceType, resourceId)` hook；删除改为**先删记录成功后**再删存储（失败仅告警不阻塞），或全部走后端接口。

---

## Low（风格）

### L1. `MetricsPage` 内联重复 `currentPeriod()`（实现正确但与共享实现重复）
`client/src/pages/dashboard/MetricsPage.tsx:27-32` —— 手写 `+8h` 偏移得上海月份，逻辑与 `utils/format.ts:43-45 currentPeriod()` 等价但绕过了共享口径（手写偏移在夏令时/未来时区规则变化下不如 `Intl` 可靠）。**修复**：`import { currentPeriod } from '@client/src/utils/format'`，删 `:27-32`。

### L2. 6 处日期输入仍是原生 `<Input type="date">`，未用共享 `DateField`
`client/src/pages/asset/components/AssetDisposalPanel.tsx:309`、`AssetImpairmentPanel.tsx:242`、`client/src/pages/finance/InvoiceCreatePage.tsx:400`、`client/src/pages/notes/NotesPage.tsx:744,822`、`client/src/pages/returns/ReturnsPage.tsx:589`
**问题**：`AGENTS.md:10` 要求表单统一 shadcn Form 体系；`DateField`（`components/erp/DateField.tsx`）是全仓标准，这些原生控件外观/交互/无障碍与其余页面不一致，且 `InvoiceCreatePage.tsx:400` 用 `{...field}` 直传字符串到 `type="date"`（空字符串会渲染成空控件）。
**修复**：替换为 `<DateField value={field.value} onChange={field.onChange} />`。

### L3. `any` 使用（5 处）
`client/src/components/business-ui/entity-combobox/popover-wrapper.tsx:100,107,131,138`（`renderTrigger as any` 等 4 处）、`client/src/types/global.d.ts:35`（`const value: any;`）。**修复**：`popover-wrapper` 用泛型 `<T>` 透传 prop 类型，`global.d.ts` 改 `unknown`。

### L4. `DataState.tsx` / `calendar.tsx` 等静态骨架屏用数组下标作 key
`client/src/components/DataState.tsx:35,45`、`client/src/components/print/PrintDocument.tsx:162`、`client/src/components/ui/field.tsx:215`、`client/src/components/ui/slider.tsx:79`、`client/src/components/business-ui/entity-combobox/highlight-text.tsx:43,47`
**问题**：静态列表用下标作 key 无害，但 `PrintDocument.tsx:162` 的 `clauses` 来自可编辑数据，删除中间项会让 React 按位置复用 DOM。对照 `costs/components/BatchAllocationPanel.tsx:26-43` 已用 `utils/row-key.ts` 的 `newRowKey()` 正确解决同类问题（且注释详细解释了为什么不能用下标）——说明约定存在，此处是遗漏。**修复**：`PrintDocument.tsx:162` 改用内容哈希或稳定 id。

### L5. `React` 默认导入在 324 个 `.tsx` 中普遍未使用
例：`client/src/pages/dashboard/MetricsPage.tsx:1`（`import React, { useState } from 'react'`，文件内只用到 `React.FC` 一处，属可接受的类型标注，但 `client/src/pages/projects/components/DeliverableSection.tsx:1` 等大量文件 `React` 完全未被引用）。**修复**：开 `jsx: react-jsx` 后统一改为 `import { useState } from 'react'`，交由 lint 自动清（属批量清理项，不影响运行）。

---

## 实际上没问题（已核查并确认正确，作为覆盖面说明）

- **`client/src/api/**` 未定义 `interface` / `type`**：全 29 个文件的 `^(export )?(interface|type)` 扫描 0 命中，符合 `AGENTS.md:39`。问题只在内联对象类型（见 M4）。
- **未使用 react-query 管理 ERP 数据**：全仓 `useMutation` / `invalidateQueries` / `useQuery` 只出现在 `components/business-ui/api/{users,departments,user-profiles,chats}/queries.ts`（实体缓存）与 `platform/AppContainer.tsx:2,15,91`（Provider）。因此"mutation 后缺 query 失效导致陈旧 UI"这一类**不适用**；ERP 数据一律走 `useAsyncData` + 显式 `reload()`。
- **`useAsyncData` 依赖数组的运行时行为**：虽然签名可疑（H5），但 62 个调用点全部传字面量依赖数组，逐点核对未发现漏依赖导致取错数据的实例。
- **分页/筛选联动**：抽查的页面切换筛选时都同时 `setPage(1)`（`AssetPanel.tsx:321-323,343-346,365-368` 等）；用 `useListQuery` 的页面在关键词变化时删除 `page` 参数（`hooks/useListQuery.ts:63`）—— 未发现"筛选变了但停在不存在的页码"的实际缺陷。
- **表单校验**：全仓不存在"用了 `react-hook-form` 却没挂 `zodResolver`"的表单（逐文件比对 `useForm` 与 `zodResolver` 计数，0 例外），也未发现裸 `<form onSubmit={...}>` 直连写接口。`ParameterSettings.tsx:60-71`、`DictionarySettings.tsx:150-163` 这些非 RHF 表单也做了手工校验（布尔/JSON 格式、键必填、排序号范围）。
- **`<CanCapabilityWrite capability="pur_asset|tax_entity">` 的用法是正确的**（`asset/components/*`、`pur/components/*`、`masterdata/TaxEntities.tsx:208,245`）：这两个能力码在矩阵里对 `finance_viewer` 是 `r`，而后端 `route-capability.ts:90-93,108-118` 的 `write: null` ⇒ 写操作要求 `rw`。`hasWriteCapability` 只认 `rw`，因此与后端口径一致 —— 与 `auth.tsx:121-130` 的说明相符，不是缺陷。
- **`TimesheetsTab` 与 `TimesheetSection` 的"带出当前登录用户绑定员工"逻辑**（`TimesheetsTab.tsx:109-125`、`TimesheetSection.tsx:113-118`）：`.then()` 内先判 `cancelled` 再 `setValue`，且 effect 返回清理函数 —— 竞态保护正确。
- **多处写表单已用业务时区**（作为 C8/H1 的正面参照）：`voucher/components/VoucherPanel.tsx:96-97,217`、`admin-bills/components/PayBillDialog.tsx:55,61,112`、`admin-bills/components/AdminBillFormDialog.tsx:84`、`costs/TimesheetsTab.tsx:90,148`、`crm/QuotationFormDialog.tsx:156,177,296`、`pur/components/PurOrderPanel.tsx:134,140`、`projects/components/TimesheetSection.tsx:69`，以及 20+ 个页面的期间选择器（`currentPeriod()`）。
- **`utils/base-path.ts:3` 读 `process.env.CLIENT_BASE_PATH`**：已在 `vite.config.ts:19-20` 用 `define` 做构建期常量替换，浏览器中没有 `process` 也能正常工作。
