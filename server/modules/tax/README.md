# 税务模块（`server/modules/tax/`）

管理**纳税主体**与其默认税率；供应商/客户的开票信息、发票进销项税率来源都读这里。

## 职责

| 文件 | 职责 |
|---|---|
| `tax-entity.service.ts` | 纳税主体 CRUD、默认主体设置、启停、纳税人资格（一般/小规模）校验 |
| `tax-entity.dto.ts` | 请求体 class DTO（`CreateTaxEntityDto` / `UpdateTaxEntityDto`） |
| `tax-entity.controller.ts` | 路由 `api/master-data/tax-entities`，能力码 `tax_entity` |

## 涉及表

`md_tax_entity`：`code` / `name` / `uscc`（统一社会信用代码）/ `taxpayer_type` /
`default_output_rate` / `default_input_rate` / 开票信息（`invoice_title` / `address` /
`phone` / `bank` / `account`）/ `is_default` / `status`。

## 对外接口

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/master-data/tax-entities` | 登录 |
| POST | `/api/master-data/tax-entities` | `tax_entity` |
| PATCH | `/api/master-data/tax-entities/:id` | `tax_entity` |
| POST | `/api/master-data/tax-entities/:id/set-default` | `tax_entity` |
| POST | `/api/master-data/tax-entities/:id/toggle-status` | `tax_entity` |

## 与其他模块的关系（容易搞错的地方）

1. **税率是百分数**（`6` 表示 6%），不是小数。`shared/tax.ts` 的 `VAT_RATES` 与
   `splitTax(gross, rate)` 都按百分数口径工作；传入 `0.06` 会把 6% 变成 0.06%。
2. **`default_output_rate` / `default_input_rate` 只是"缺省值"**：实际开票税率
   优先取合同 `tax_rate`，其次取纳税主体默认值（见 `crm/quotation` 与 `finance/invoice`）。
3. **`is_default` 全局唯一**：`set-default` 会先清空其它主体的该标记（事务内）。
4. **一个主体停用前必须先确认没有未结单据引用**：停用后单据开票会找不到税率来源。
5. 增值税申报底稿（A-06）按 `tax_entity_id` 分组，因此**主体不能删除，只能停用**。

## 测试入口

```bash
npx jest --config jest.config.cjs server/common/tax
```

`split-tax.spec.ts`（价税分离）、`tax-rules.spec.ts`（税率档位与纳税人资格）、
`posting.spec.ts` + `posting-asset.spec.ts`（分录模板，含 D-08 处置）。

## 需财务确认

1. 小规模纳税人的征收率（当前 `VAT_RATES` 含 1% / 3%；1% 为阶段性优惠，需按现行政策调整）。
2. 差额征税、免税项目是否需要单独的税率档位。
3. 跨主体交易（一个主体开票给同一集团另一主体）是否需要视同销售处理。
