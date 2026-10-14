# 预算与费控模块（`server/modules/fin-budget/`）

覆盖需求书 **C-09 预算承诺与「三算对比」**，以及费用申请/报销的预算占用校验。

## 职责与文件

| 文件 | 职责 |
|---|---|
| `fin-budget.service.ts` | 预算行 CRUD、**维度匹配纯函数**（`budgetMatchesDoc` / `sumMatchedRecords`）、执行率汇总 |
| `budget-commitment.service.ts` | **C-09**：承诺识别、预算 − 承诺 − 实际 三算对比、孤儿承诺清单 |
| `fin-budget.controller.ts` | 路由与能力校验（`finance_write`） |

`fin-expense` 模块复用 `fin-budget.service.ts` 导出的匹配函数做**预算预占校验**，
保证"申请时的校验口径"与"三算表的口径"完全一致（同一份代码）。

## 为什么需要「承诺」这一层

既有实现只区分【预算】与【已执行（报销审批通过）】。但**已签合同/已下采购单的钱
虽然还没花，却已经不能再挪用**。只看"已执行"会让预算看着还有余额，实际一付款就超支。
三算表把这一层显式化，并对「仅承诺就已超预算」单独打红标
（`commitmentAloneExceedsBudget`）——说明在签约阶段就失控了。

## 承诺口径（本次实现采用，**需业务确认**）

| 来源 | 计入条件 | 金额口径 |
|---|---|---|
| 采购订单 `pur_order` | `status ∈ (approved, ordered, accepted)` | `amount`（含税） |
| 合同 `erp_contract` | `status ∈ (active, performing)` | `netAmount`（**不含税净额**，与预算口径一致） |
| 费用申请 `fin_expense_apply` | `status = pending` | `amount` |
| 报销单 `fin_expense_claim` | `status = approved` | `amount` → 计入**实际** |
| 费用申请 | `status = approved` | `amount` → 计入**实际**（不重复计入承诺） |

关键规则：

1. **同一单据只计一次**（按 id 去重）—— 否则一条单据匹配多条预算时占用额会翻倍。
2. **已批准的费用申请归入"实际"而非"承诺"**：保守口径，避免同一笔钱两边都算。
3. **`erp_contract` 无 `project_id` 列**，因此合同承诺只在「按期间/类别」维度参与三算，
   **不参与「按项目」维度**。项目级预算的承诺需通过采购订单/费用申请体现。
4. 预算行的 `department_id` / `project_id` 为 `NULL` 表示**不限**（不是"没有"）。

## 三算表与孤儿承诺

- **三算表**（`GET /api/fin-budget/commitments`）：按 `期间 × 部门 × 项目 × 费用类别`
  分组，返回 预算 / 承诺 / 实际 / 可用余额，以及 `overCommitted`、
  `commitmentAloneExceedsBudget` 两个标记。
- **孤儿承诺**（`GET /api/fin-budget/commitment-gaps`）：**没有任何预算行覆盖**的承诺明细。
  这类承诺在三算表里根本不会出现（没有匹配的预算行可挂），却是最容易漏管的一类，
  需要业务补录预算或调整承诺来源。

## 对外接口

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/fin-budget/budgets` | 登录 |
| POST | `/api/fin-budget/budgets` | `finance_write` |
| PATCH | `/api/fin-budget/budgets/:id` | `finance_write` |
| GET | `/api/fin-budget/executions` | 登录（执行率，BI 用） |
| GET | `/api/fin-budget/commitments?period=YYYY-MM` | 登录（三算对比） |
| GET | `/api/fin-budget/commitment-gaps?period=YYYY-MM` | 登录（孤儿承诺） |

## 前端

`client/src/pages/fin-expense/index.tsx` 的「三算对比」Tab
（`components/BudgetCommitmentPanel.tsx`）：顶部四个合计卡，表格中对超支行加底色，
状态列区分「承诺即超预算 / 已超支 / 接近上限（可用 < 预算 10%）/ 正常」，
下方单列孤儿承诺。

## 测试入口

```bash
npx jest --config jest.config.cjs server/modules/fin-budget
```

`budget-commitment.spec.ts`（11 例）锁定维度匹配语义：期间/类别不等不匹配、
`NULL` 表示不限、同单据只计一次、空金额不产生 NaN。

## 需业务确认

1. 合同用**不含税净额**还是含税金额计入承诺（当前不含税，与预算口径对齐）。
2. 采购订单是否应按 `accepted_quantity` 折算已到货部分（当前按订单全额承诺）。
3. 「已批准费用申请」归入实际还是承诺（当前归实际）。
4. 是否需要对"仅承诺即超预算"做**阻断**（当前仅红色提示，不阻断签约）。
