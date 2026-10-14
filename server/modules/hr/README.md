# 人力资源模块（`server/modules/hr/`）

覆盖需求书 **A-07（个税累计预扣预缴）/ A-08（社保城市规则）** 与 HR 全流程
（员工档案、考勤、请假、薪酬、招聘、考核、培训、员工自助）。

## 职责与文件

| 文件 | 职责 |
|---|---|
| `hr-core.controller.ts` / `hr-core.service.ts` | 部门、岗位、员工档案、考勤、请假、**数据级权限（部门隔离，B-02）** |
| `hr-pay.controller.ts` / `hr-pay.service.ts` | 薪酬（工资单状态机、社保、成本归集）、招聘、考核、培训、社保城市规则 |
| `hr-self-service.controller.ts` / `hr-self-service.service.ts` | 员工自助（我的档案/考勤/余额/工资单、补卡、请假） |
| `payroll-engine.ts` | **纯函数试算引擎**：社保按城市比例 + 个税累计预扣预缴法 |
| `payroll-tax.service.ts` | **A-07**：专项附加扣除登记（员工 × 年度 × 类型）+ 累计口径查询 + 年度汇算辅助 |

## 涉及表

- `md_employee`（`ss_city_code` / `ss_base` / `platform_user_id` / `supplier_id` / `department_id`）
- `hr_payroll`（含 A-07 累计字段：`ytd_income` / `ytd_deduction` / `ytd_additional_deduction` /
  `ytd_tax_withheld` / `ytd_taxable_income` / `tax_rate` / `quick_deduction` / `ytd_net`）
- `hr_employee_tax_deduction`（专项附加扣除，`uq_hr_emp_tax_deduction` 防重复登记）
- `hr_ss_city_rule`（社保/公积金比例与基数上下限，按 `effective_from` 生效）
- `hr_attendance` / `hr_attendance_amendment`（补卡）/ `hr_leave_request` / `hr_leave_balance`
- `hr_recruit_req` / `hr_candidate` / `hr_appraisal` / `hr_training` / `hr_training_record`

## 个税口径（A-07，**需财务确认**）

依据《国家税务总局公告 2018 年第 61 号》：

```
本期应预扣预缴税额 = (累计预扣预缴应纳税所得额 × 预扣率 − 速算扣除数) − 累计已预扣预缴税额
累计应纳税所得额 = 累计收入 − 累计免税收入 − 5000×月份数
                 − 累计专项扣除（三险一金个人部分）− 累计专项附加扣除 − 累计其他扣除
```

- 七级预扣率表与速算扣除数写在 `payroll-engine.ts` 的 `CUMULATIVE_TAX_BRACKETS`，
  由 `payroll-engine.spec.ts` 逐项断言（含跨档边界 `36000.01`）。
- 专项附加扣除 7 类：子女教育 / 继续教育 / 大病医疗 / 住房贷款利息 / 住房租金 /
  赡养老人 / 3 岁以下婴幼儿照护；**按月定额**登记，支持起止月份。
- 本期税额**不允许为负**；累计多扣时返回 `refundable` 供人工复核（不自动退税）。
- **连续 12 个月发放时，累计已预扣必须等于全年应纳税额** —— 这条恒等式由单测锁定。

## 社保口径（A-08）

- 基数按 `hr_ss_city_rule.base_min/base_max` 夹取；员工可显式指定 `ss_base`。
- 员工个人部分 = 基数 × (养老 + 医疗 + 失业 + 公积金)%；企业部分另计（`*_co`）。
- **期间无匹配规则时必须报 400**（禁止静默回落到最近一条），
  否则会按过期比例计算社保，属于财务重大风险。

## 对外接口（摘要）

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/hr/my/summary` | 登录（员工自助，按绑定员工） |
| GET/POST | `/api/hr/employees...` | `hr` / `hr_write` |
| GET | `/api/hr/tax-deductions`、`/tax-deductions/types`、`/tax-deductions/annual-summary` | `hr`（读） |
| POST | `/api/hr/tax-deductions`、`/tax-deductions/:id/delete` | `hr_write` |
| POST | `/api/hr/payrolls/preview` | `hr_write`（试算，`PreviewPayrollDto` 带完整校验） |
| GET/POST | `/api/hr/payrolls...`（`submit`/`approve`/`reject`） | `hr` / `hr_write` |
| GET/POST | `/api/hr/ss-city-rules` | `hr` / `hr_write` |

## 状态机

- 工资单：`draft → submitted → approved`；任一状态 → `rejected`，
  **`rejected → submitted` 允许重开**（避免该月永久死锁）。
- 员工：`probation → active → resigned`；离职走 `POST /api/hr/employees/:id/offboard`，
  返回近 60 天确认工时的待交接项目。
- 补卡：审批通过后在**同一事务内**生成 `hr_attendance`。

## 成本归集

- 工资审批通过后按项目分摊生成 `erp_project_cost`（`allocationGenerated` 防重复）。
- 兼职工（`part_time` / `flex`）工时确认自动归集为 `flex_labor` 成本类型，
  并回填 `md_employee.supplier_id` 以支持外协结算。

## 测试入口

```bash
npx jest --config jest.config.cjs server/modules/hr
```

`payroll-engine.spec.ts`（13 例）覆盖：税率表、跨档边界、专项附加扣除按月过滤与累计、
社保基数上下限、首月逐项数值、**连续 12 个月递推恒等**、年中入职、免税收入与其他扣除、
累计多扣、显式基数优先、月份越界夹取。
