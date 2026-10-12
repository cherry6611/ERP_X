# 晟笙数据服务 ERP

数据服务公司独立 ERP 系统：CRM → 合同 → 项目 → 成本/收入核算 → 应收应付 → BI 看板 → 审计，全链路业务闭环。NestJS + React 全栈，Drizzle + PostgreSQL。

## 设计规范

- 风格：企业后台管理系统，紧凑密度。主色用 shadcn 默认 primary，背景 `bg-background`，卡片白色。
- 布局：固定左侧栏 `w-56`（分组导航），主内容区最小宽度自适应，页面容器统一 `p-6`，区块纵向 `gap-6`，并列卡片 `gap-4`。
- 排版：页面标题 `text-2xl font-semibold`，区块标题 `text-base font-semibold`，正文/表格 `text-sm`，辅助说明 `text-sm text-muted-foreground`。
- 组件：表格用 `@lark-apaas/client-toolkit/antd-table`（见 table-skill）；表单用 shadcn Form + Dialog（见 forms-skill）；图表用 ReactECharts，色板统一从 `utils/chart-colors.ts` 导入（见 charts-skill）；图标只用 lucide-react。Card 禁止嵌套 Card。
- 共享组件（components/erp/）：StatCard 指标卡（icon + tone + delta，替代裸 border 卡）、FilterBar 筛选区卡片容器；PageShell 支持 actions 插槽（页头右侧主操作按钮）。Layout 含顶栏（面包屑 + 用户区 UserDisplay）。
- 状态展示：业务状态用 Badge（含 success/warning/info 语义 variant，映射见 utils/biz-labels.ts STATUS_VARIANTS）：草稿/待审批=灰，已生效/待回款=蓝，进行中/部分完成=黄，终态成功（完成/结项/回款/批准）=绿，驳回/逾期/超限=红。
- 所有交互按钮必须挂真实 handler；列表页必须有真实空态文案与失败反馈（toast 用 sonner，仅用于操作结果反馈）。
- 响应式：最小适配 1280px 宽即可。

## 架构约定

- 模块目录：`server/modules/<name>/`，页面 `client/src/pages/<name>/`，前端 API `client/src/api/<name>/`。
- 飞书集成：插件实例 `send_erp_approval_notification_1`（审批通知，收件人=单据提交人+admin）、`erp_bitable_two_way_sync_1`（成本出向）、`contract_ledger_archiving_1`（合同出向）、`flexible_labor_hours_sync_1`（工时入向）；后三个为 feishu-bitable 插件，appToken/tableID 需用户在插件配置页填写。同步模块 `server/modules/feishu-sync/`，幂等映射表 `comp_feishu_sync_record`，cron 触发器 `feishu_daily_sync`（未激活）。
- 飞书云空间/知识库直连：`server/modules/feishu-drive/`（feishu-client/drive/wiki/config service），凭证存 `comp_feishu_drive_config` 单行配置表（RLS 不放行 anon），tenant_access_token 内存缓存提前 5 分钟刷新；前端页面 `/drive`、`/wiki`。云空间支持浏览/新建文件夹/新建文档/上传（限 10MB，base64 经 upload_all）/重命名/删除；知识库支持节点树浏览与云文档同步（`POST /api/wiki/sync`）。重命名/删除/同步/配置读写为 `@CanRole(['admin'])`，浏览/新建/上传登录即可。知识库空间需用户在飞书侧把应用加为空间成员（可编辑），未授权时 131006→页面显示引导提示。
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
- 前后端契约唯一权威：`shared/api.interface.ts`，属性一律 camelCase；请求参数类型（各 ListParams/Payload）也统一定义在 shared，`client/src/api/` 不得再本地定义 interface/type。
- 业务编号：service 内生成，`前缀+YYYYMM+4位流水`（按表内当月计数），如 CTR2026100001（报价 QUO、合同 CTR）。
- 期间/日期：业务时区 Asia/Shanghai，月份用 `YYYY-MM` 字符串；时间字段传输 ISO 字符串。
- 接口鉴权：全部业务 controller 类级 `@NeedLogin()`；敏感写操作叠加方法级 `@CanRole(['admin'])`（财务/成本/HR 工资、HR 招聘/考核/培训、考勤补录、行政租约/账单/资产/事务、附件删除、手动成本/分摊等），前端对应按钮用 `<CanRole roles={['admin']}>` 包裹同步隐藏；员工自助保留登录态：补卡、请假、工时填报与确认、资产变更申请、采购申请、附件上传/云文档链接登记。
- 状态机变更在 service 校验前置状态，非法流转抛 `BadRequestException`。
- 数据库表前缀：`md_`（主数据）、`crm_`（前端业务）、`erp_`（核算/合同/项目/财务）、`comp_`（合规）。
- 测试/演示数据：一律以 `[API_TEST]` 前缀命名；接口自测数据用后即删，删除前留档至 `docs/api-test-data-archive/`；生产库不保留演示数据。
