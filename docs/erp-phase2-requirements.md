# 晟笙数据服务 ERP 二期需求书（联动增强版）

版本：V2.0（联动设计稿）｜日期：2026-10-10｜关联系统：晟笙数据服务 ERP 一期（已上线 11 个模块 / 27 张表）

## 一、目标与设计原则

在现有 11 个模块之上新增 6 个板块，每个板块的新数据流必须接入现有闭环：

- 写操作自动进 `comp_audit_log` 审计（AuditInterceptor 全局挂载，新模块零成本覆盖）
- 状态机沿用 service 层 FLOW 校验模式，非法流转抛 `BadRequestException`
- 编号沿用 `generateBizCode`（前缀+YYYYMM+4 位流水），新增前缀：EMP/DPT/SAL/REC/PRF/BGT/EXP/PR/PO/AST/VCH/DS
- 金额一律 numeric 字符串；月份 `YYYY-MM`；业务时区 Asia/Shanghai
- 外键为裸 uuid 无 FK 约束，关联完整性由 service 层校验（沿用现状）
- 敏感数据（薪酬）：service 层读 `req.userContext.roles` 做角色拦截，无角色抛 `ForbiddenException`
- 契约先行：接口先落 `shared/api.interface.ts`；聚合文件由主 agent 预填
- DDL 走数据库操作 skill 通道，改完重新生成并复读 schema.ts

## 二、P0 人力资源（HR）

**表设计**：扩展 `md_employee`（DDL 加 departmentId/positionId/hireDate/employmentType，status 扩展为 probation→active→resigned）；新建 `hr_department`（树形 parentId）、`hr_position`（含默认 roleName，对齐 `erp_labor_rate.roleName`）、`hr_attendance`、`hr_leave_balance`、`hr_leave_request`、`hr_payroll`（月薪单，敏感）、`hr_recruit_req`、`hr_candidate`、`hr_appraisal`、`hr_training`。

**联动点**：
- 工时登记改造：`erp_timesheet` DDL 加 employeeId 列（employeeName 保留为快照）；登记时从员工选择器选人，roleName 由岗位自动带出（hr_position.roleName → erp_labor_rate 取费率，费率查询逻辑不动）
- 工时确认生成成本链路零改动，仍走 sourceRef=timesheet:code
- 薪酬联动：工资单审批通过 → 按员工当月工时占比自动生成 `erp_cost_allocation` 分摊（costType=labor，sourceRef=payroll:code）到其工时所在项目；无工时部分生成部门公共分摊待手工指定
- 招聘闭环：候选人入职确认 → 自动创建 md_employee 档案
- 绩效结果等级（S/A/B/C/D）→ 绩效工资系数（hr_payroll 生成时读取）
- BI 新增人力区块：headcount 趋势、入离职率、人均产出（营收/在册人数，复用 getOverview 收入口径）

**业务校验**：请假扣减余额不足拒绝；工资单每月每人一次、重复月份 BadRequest；离职员工不能再登记工时。

## 三、P1 费用报销与预算费控

**表设计**：`fin_budget`（部门/项目/费用科目/期间 YYYY-MM 多维度，预算额、已占用、已执行）、`fin_expense_apply`（差旅/采购前申请，预占预算）、`fin_expense_claim`（报销单：关联申请、费用科目、projectId 归集）。

**联动点**：
- 报销审批通过 → 事务内两写：① 生成 `erp_ap_bill`（source=expense；DDL 将 supplierId 改 nullable，source=expense 时豁免供应商校验）② 生成 `erp_project_cost`（costType=travel，sourceRef=expense:code）
- 付款核销零改造：复用现有付款（金额≤未付余额）与应付核销流程
- 预算校验（事中）：提交申请/报销时校验 Σ已执行 + Σ在途占用 + 本次 ≤ fin_budget；项目维度同时校验 `erp_project.budget` 基线
- BI 新增预算执行率区块

**业务校验**：报销关联申请时金额不得超申请额；超预算走升级审批（状态机加 escalated 状态）。

## 四、P2 采购申请与审批

**表设计**：`pur_request`、`pur_order`。

**联动点**：
- 采购订单金额校验对齐 Call-off 口径：framework 合同 Σ已下单+本次 ≤ 合同 amount；普通合同同样累计校验
- 订单验收确认 → 事务生成 `erp_ap_bill`（source=purchase，supplierId 取订单供应商）；服务类采购同时生成 `erp_project_cost`（costType=outsource，sourceRef=po:code）；设备类走 P3 资产入库
- 供应商下拉直接用 md_supplier；采购看板：申请→订单→验收→应付→付款全链路状态

**业务校验**：验收数量 ≤ 订单数量；供应商必须 status=active。

## 五、P3 固定资产

**表设计**：`ast_asset`（类别 server_gpu|office|other、原值、归属部门、可选 projectId、状态 in_use→idle→repair→scrapped）、`ast_depreciation`（月度折旧）、`ast_change`（领用/调拨/报废审批留痕）。

**联动点**：
- 设备类采购订单验收 → 自动创建 ast_asset 卡片（对接 P2）
- 月度折旧计提批量任务 → GPU 服务器折旧生成 `erp_project_cost`（costType=compute，sourceRef=asset:code，归集 projectId；无项目归属走公共成本分摊）
- 报废审批通过 → 终止后续折旧

**业务校验**：净值 ≥ 0；折旧月份不重复；已报废资产禁止折旧。

## 六、P4 总账凭证（轻量）

**表设计**：`fin_account`（科目表）、`fin_voucher`（凭证头，期间 YYYY-MM，status=draft→posted→voided）、`fin_voucher_line`（借贷分录）。

**联动点（事件驱动生成凭证草稿）**：
- 回款登记 → 借银行/贷应收
- 付款审批通过 → 借应付/贷银行
- 报销付款、工资单审批、折旧计提、发票 issued → 各生成对应凭证草稿
- 期间结账：当期凭证全部 posted 且试算平衡，结账后禁止补录

**业务校验**：过账前借贷合计必须相等；已结账期间禁止新增/作废凭证。

## 七、P5 数据资产授权

**表设计**：`da_dataset`（数据集目录：脱敏等级、来源、关联协议合同）、`da_grant`（授权记录：customerId/projectId/期限/范围，status=active→expired）。

**联动点**：项目立项前置校验——项目引用的数据集必须存在 status=active 且未过期的授权，否则 BadRequest；列表/BI 展示到期前 30 天预警。

## 八、对现有代码的侵入改动清单（兼容性风险点）

- `erp_timesheet` 加 employeeId 列：旧数据 employeeName 快照保留，列表展示不受影响
- `erp_ap_bill.supplierId` 改 nullable + source 枚举扩展：应付列表需兜底"内部报销"文案
- `md_employee` 加列：员工下拉接口返回多字段，向前兼容
- 项目立项增加授权校验：仅 P5 实施时生效，无数据集引用则跳过
- 其余全部为新增模块，不触碰一期逻辑；每期上线后复跑一期 10 条验收用例防回归

## 九、实施分期

- 二期 A：HR 全部（P0）+ BI 人力区块 + 工时登记员工选择改造
- 二期 B：预算费控（P1）+ 采购（P2）+ ap_bill source 扩展
- 三期：固定资产（P3）+ 总账凭证（P4）+ 数据资产授权（P5）

## 十、验收标准（联动闭环用例）

- 入职 → 员工档案出现 → 工时登记可选该员工 → 工时确认 → 成本生成（费率取岗位对应角色）
- 报销提交 → 审批 → 应付列表出现 source=expense 记录 → 付款 → 核销闭环；项目成本表同步出现 travel 成本
- 采购订单 → 验收 → 应付生成 → 付款；framework 合同超限被拦截
- 工资单审批 → 分摊记录进入项目成本 → 项目毛利自动更新
- 折旧计提 → compute 成本 → 项目核算卡片毛利变化；凭证借贷平衡、期间结账通过
- 项目立项引用未授权数据集被拦截
- 一期 10 条 E2E 用例全部复测通过（无回归）

## 十一、未决事项

1. 员工是否需要系统登录账号自助填报（影响考勤/工时入口形态：自助 vs HR/PM 代录）——默认按代录实现
2. 薪酬是否对接外部代发/报税——默认纯台账
3. 工资单自动分摊（按工时占比）是否需支持手工调整比例——默认自动生成后可作废重分摊
