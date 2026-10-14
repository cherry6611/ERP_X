# 固定资产模块（`server/modules/asset/`）

覆盖需求书 **D-08 资产全生命周期**：采购建卡 → 变更领用/调拨 → 折旧计提 →
减值测试 → 处置/报废 → 生命周期追溯。

## 职责与文件

| 文件 | 职责 |
|---|---|
| `asset.service.ts` | 资产卡片 CRUD、总览统计、变更单（领用/调拨/报废申请）与审批 |
| `asset-depreciation.service.ts` | 月度折旧计提（年限平均法）+ 成本归集 + 凭证 |
| `asset-lifecycle.service.ts` | **D-08**：减值测试与计提、处置/报废、生命周期时间线、归属与保管人 |
| `asset.controller.ts` | 路由与能力校验（`pur_asset` 能力） |

## 涉及表

`ast_asset`（`original_value` / `residual_value` / `net_value` / `useful_months` /
`impairment_amount` / `impairment_date` / `net_value_after`）、
`ast_depreciation`（折旧明细，**累计折旧的唯一事实来源**）、
`ast_change`（变更单，`before_value` / `after_value`）、
`ast_impairment`（减值单）、`ast_disposal`（处置单）。

> ⚠️ **`ast_asset` 没有 `accumulated_depreciation` 列**：累计折旧必须从
> `ast_depreciation` 汇总（见 `AssetLifecycleService.totalDepreciation`）。
> 曾出现过按不存在的列取数导致账面价值算错的问题，新增查询时注意。

## 会计口径（**需财务确认**）

见迁移 `2026-10-15-upgrade-batch3-asset-accounts.sql` 头部注释。核心：

```
计提减值：借 6701 资产减值损失  / 贷 1604 固定资产减值准备
处置转入：借 1603 固定资产清理（净值）+ 借 1602 累计折旧 + 借 1604 减值准备
        / 贷 1601 固定资产（原值）
处置收入：借 100201 银行存款（含税）/ 贷 1603 清理 + 贷 222101 销项税
清理净额：损失 → 借 6711 营业外支出；收益 → 贷 6301 营业外收入
```

**不变量**（由 `server/common/tax/posting-asset.spec.ts` 11 例锁定）：

1. 每笔分录借贷平衡；
2. `1603 固定资产清理` 在完整分录中轧平为 **0**；
3. `gainLoss = 处置收入 − 销项税 − (原值 − 累计折旧 − 减值准备)`；
4. 减值**不触碰 1601**（原值必须保留，减值走备抵科目 1604）。

## 状态机

- 资产：`in_use ↔ idle ↔ repair`；处置完成 → `disposed` / `scrapped`。
- 处置单：`disposing → disposed | scrapped | rejected`。
  **同一资产同时只允许一张 `disposing` 单**（否则会重复出凭证）。
- 减值：同资产同期间只允许一次测试（防重复计提）。

## 对外接口

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/asset/assets`、`/overview` | 登录 |
| POST | `/api/asset/assets` | `pur_asset` |
| GET | `/api/asset/assets/:id/lifecycle`、`/:id/ownership` | 登录 |
| GET | `/api/asset/impairment-test`、`/impairments` | 登录 |
| POST | `/api/asset/impairments`、`/impairments/:id/delete` | `pur_asset` |
| GET | `/api/asset/disposal-preview`、`/disposals` | 登录 |
| POST | `/api/asset/disposals`、`/disposals/:id/actions/:action` | `pur_asset` |
| GET | `/api/asset/changes`、`/depreciations` | 登录 |
| POST | `/api/asset/changes`、`/changes/:id/actions/:action` | 登录 / `pur_asset` |
| POST | `/api/asset/depreciate` | `pur_asset` |

## 凭证失败的处理

减值/处置的凭证走 `VoucherHookService.generateVoucherDraft`；失败时写入
`comp_voucher_job` 补偿队列，**业务状态照常推进**，接口返回 `voucherRef: null`。
前端会显示"待补录（已入补偿队列）"，由运维通过 `voucher_job_retry` 或人工补录。
这样设计是为了避免"凭证服务抖动导致资产无法处置"。

## 测试入口

```bash
npx jest --config jest.config.cjs server/modules/asset server/common/tax
```

## 需财务确认

1. 减值损失是否一律走 6701（部分企业要求"固定资产减值损失"单列 6702）。
2. 处置报废损失是否走 6711 营业外支出（而非资产处置损益 6115）。
3. 处置收入是否一律计销项税（旧固定资产简易计税/免税情形未区分）。
4. 残值率与折旧年限的默认值（当前 `useful_months` 默认 36）。
