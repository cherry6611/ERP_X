# 应收应付与资金模块（`server/modules/finance/`）

覆盖应收（AR）、应付（AP）、回款/付款、发票台账、核销与反核销、勾稽中心、
现金流预测、外协结算。账务报表与账簿见 `../finance-reports/`。

## 职责与文件

| 文件 | 职责 |
|---|---|
| `ar.service.ts` | 应收单、回款登记/作废、应收核销与反核销、账龄、**行级锁防并发超核销** |
| `ap.service.ts` | 应付单、付款审批/作废、应付核销与反核销 |
| `invoice.service.ts` | 发票台账（销项/进项）、开票额度校验、作废、进销项关联 |
| `cash-flow.service.ts` | 13 周滚动现金流预测（业务时区周一为周界） |
| `reconciliation.service.ts` | 勾稽中心三链：销售-应收 / 采购-应付 / 回款-核销 |
| `vendor-settlement.service.ts` | 外协结算（供应商 + 月份，可选项目） |
| `ar-reminder.automation.ts` | `ar_due_reminder_daily`（09:00）逾期/临期按责任人分组提醒 |
| `finance.dto.ts` | 请求体 class DTO（API-1） |
| `ar-match.ts` + `ar-match.spec.ts` | 回款匹配/核销状态的纯函数判定 |

## 涉及表

`erp_ar` / `erp_receipt` / `erp_ar_writeoff`、`erp_ap_bill` / `erp_payment` / `erp_ap_writeoff`、
`erp_invoice`、`erp_contract`、`erp_project`、`erp_project_cost`、`md_customer` / `md_supplier` / `md_tax_entity`。

## 对外接口（摘要）

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/finance/ars`、`/receipts`、`/aps`、`/payments`、`/invoices` | `finance`（读） |
| POST | `/api/finance/ars`、`/receipts`、`/aps`、`/payments`、`/invoices` | `finance_write` |
| POST | `/api/finance/receipts/:id/void`、`/payments/:id/actions/approve`、`/invoices/:id/void` | `finance_write` |
| PATCH | `/api/finance/invoices/:id` | `finance_write` |
| POST | `/api/finance/ar-writeoffs`、`/ap-writeoffs`、`.../reverse` | `finance_write` |
| GET | `/api/finance/cash-flow/forecast?weeks=` | `finance` |
| GET | `/api/finance/aging`、`/summary`、`/reconciliation` | `finance` |
| GET/POST | `/api/finance/vendor-settlement/{preview,generate}` | `finance` / `finance_write` |

## 状态机

- 应收：`open → partial → settled`；回款：`unmatched → matched`，未核销可 `voided`。
- 应付：`open → partial → settled`；付款：`pending → approved → paid`，`approved`/`pending` → `voided`。
- 发票：`issued → voided`（仅 `issued` 可作废，作废释放可开金额）。

## 关键约束与易踩的坑

1. **并发超核销**：核销额度校验必须在事务内 `SELECT ... FOR UPDATE` 锁行；
   仅靠应用层先查后写会在并发下重复核销（已修）。
2. **作废付款单前必须无核销记录**：部分核销后付款单仍是 `approved`，
   直接作废会释放额度却留下核销行与 `paidAmount`，导致可重复付款。
3. **反核销**：`*_writeoff.reversal_of` 指向被冲回的核销行，唯一索引防重复冲回。
4. **销项开票额度**：事务内锁合同行校验可开金额，防止超额开票。
5. **进项费用化科目**：进项发票走 `6602 管理费用`（`inputIssueLines`），
   **不进 6401 主营业务成本** —— 否则毛利口径失真。
6. **回款/付款的银行存款科目**是 `100201`（`ACCOUNT_BANK_PRIMARY`），
   不是 `1001`（`1001` 是库存现金）。历史实现误用 `1001`，已由 A-10 迁移纠正。
7. `GenerateVendorSettlementDto` 的 `projectId` 允许 `null`（表示"该供应商全部项目"）；
   查重键 `source_ref = VS:{period}:{supplierId}:{projectId|ALL}`，重复生成 409。

## 测试入口

```bash
npx jest --config jest.config.cjs server/modules/finance
```

`ar-match.spec.ts` 覆盖回款匹配与核销状态判定；集成链路由
`server/test/integration/accounting-chain.spec.ts` 覆盖到凭证层。
