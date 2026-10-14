# 账务报表与账簿模块（`server/modules/finance-reports/`）

覆盖需求书 **A-01 资产负债表 / A-02 利润表与现金流量表 / A-03 账簿 / A-04 期末结转与年结 /
A-05 会计辅助核算 / A-06 增值税申报底稿**。

## 职责

- **报表引擎**：从 `fin_report_template` 读取报表行与取数公式，按期间求值。
  口径改动用 SQL 迁移改模板即可，**不需要发版**。
- **账簿**：科目余额表、总账、明细账、辅助余额表、试算平衡。
- **年结**：结转损益 + 年结状态 + 反年结（审批留痕）。
- **增值税**：申报底稿生成（发票台账口径 vs 总账口径勾稽）。

## 涉及表

| 表 | 用途 | 创建位置 |
|---|---|---|
| `fin_account` | 会计科目（多级 + `is_leaf` 末级校验 + `aux_required`） | `2026-10-15-upgrade-batch1-chart-of-accounts.sql` |
| `fin_voucher` / `fin_voucher_line` | 凭证与分录（`fin_voucher_line.account_code` 为账簿取数冗余列） | `0000_baseline.sql` + `...-accounting-base.sql` |
| `fin_report_template` | 报表模板（`row_no` / `formula` / `section` / `indent` / `bold`） | `...-accounting-base.sql` + `...-report-templates.sql` |
| `fin_aux_dimension` / `fin_voucher_line_aux` | 辅助核算维度与凭证行辅助值 | `...-accounting-base.sql` |
| `fin_account_balance_snapshot` | 月度科目余额快照（性能预留） | `...-accounting-base.sql` |
| `fin_year_end_close` / `fin_year_end_log` | 年结状态与反年结留痕 | `...-accounting-base.sql` |
| `fin_vat_declaration` | 增值税申报底稿 | `...-vat-declaration.sql` |

## 对外接口

全部在 `finance-reports.controller.ts`，路由前缀 `api/finance`。

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/reports/balance-sheet`、`/reports/income-statement`、`/reports/cash-flow` | `finance`（读） |
| GET | `/reports/:reportCode` | `finance` |
| GET | `/reports/templates/:reportCode` | `finance` |
| GET | `/ledgers/account-balance`、`/ledgers/general`、`/ledgers/detail`、`/ledgers/aux-balance`、`/ledgers/trial-balance` | `finance` |
| GET | `/ledgers/aux-dimensions` | `finance` |
| POST | `/ledgers/aux-dimensions`、`/ledgers/aux-dimensions/:code/enabled` | `finance_write` |
| GET | `/year-end/preview`、`/year-end/status`、`/year-end/log` | `finance` |
| POST | `/year-end/carry-forward` | `finance_write` |
| POST | `/year-end/:fiscalYear/reverse` | `finance_write`（需 `reason` ≥4 字 + `approved: true`） |
| GET | `/tax-declaration`、`/tax-declaration/list` | `finance` |
| POST | `/tax-declaration/confirm` | `finance_write`（勾稽不一致时 `differenceReason` 必填） |

## 取数公式 DSL

见 `report-formula.ts`。支持：

```
科目余额(1122, 借)   科目发生(6602, 借)   期初余额(1002, 借)   科目变动(2202)
行(1)   上期(3)   ABS(...)   -1 * (...)   + - * ( )
```

- `科目余额/科目发生/期初余额` 的方向参数：`净`（缺省，借−贷，可负）、`借`、`贷`（两者取 `max(净,0)`）。
- `科目变动(N)` = 期末(借−贷) − 期初(借−贷)，用于间接法现金流量表推算营运资本变动。
  **注意符号**：贷方性质负债（2202/2203/2211）增加时该值为负，公式里必须整体取反。
- 汇总科目（如 `6602`/`1002`）在账簿层会逐级上卷，因此公式直接写一级科目编码即可。

## 状态机与关键约束

- 凭证期间：`fin_period_close` 记录已结账期间；`assertPeriodOpen` 拒绝已结账期间的写入。
- 年结：`fin_year_end_close.status` = `closed | open`；年结后该年度期间只读（`assertPeriodWritable`）。
- 反年结：必须带 `reason`（≥4 字）与 `approved: true`，作废结转凭证并写 `fin_year_end_log`。
- **只能对末级科目做账**：`fin_account.is_leaf = 0` 的科目在凭证录入时被拒；
  分录模板写的语义编码由 `AccountResolverService` 自动下钻到末级。

## 测试入口

```bash
npx jest --config jest.config.cjs server/modules/finance-reports
```

- `report-formula.spec.ts`：DSL 解析与求值（含非法公式、括号、乘法、方向语义）。
- `report-templates.spec.ts`：**直接解析迁移文件里的模板 SQL**，验证三类报表的
  会计恒等式（资产=负债+权益、净利润=利润总额−所得税、期初现金+净增加额=期末现金）。
  这条用例是防止"模板 SQL 与 DSL 语法漂移"的回归保护。

## 需财务确认的口径

1. 现金流量表采用**间接法**（不改凭证模型）；直接法（现金流量项目标记）为批次三可选项。
2. 资产负债表"未分配利润"行 = `4104` + `4103`（本年利润），即未年结时含本年利润。
3. 哪些科目必须挂哪些辅助维度（当前种子只给 `6602*` 系列要求 `department`）。
4. 报表行次与《企业会计准则》报表格式的对应关系。
