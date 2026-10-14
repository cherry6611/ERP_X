# BI 与指标中心模块（`server/modules/bi/`）

覆盖经营看板、项目财务健康、客户贡献、税务分布、趋势分析，以及
需求书 **D-12 指标中心 / 下钻 / 预警订阅**。

## 职责与文件

| 文件 | 职责 |
|---|---|
| `bi.service.ts` | 既有看板：总览、项目毛利、项目财务健康、成本结构、客户贡献、税务分布、月度趋势、HR 概览、预警汇总 |
| `bi-metrics.service.ts` | **D-12**：指标注册表（含口径与下钻路由）、指标计算、预警订阅 CRUD 与扫描 |
| `bi-alert.automation.ts` | `bi_alert_daily`（每日 08:30）按订阅阈值扫描并推送 |
| `bi.controller.ts` | 路由；`UpsertBiAlertSubscriptionDto` **必须定义在 controller 之前**（TDZ 约束） |

## 指标注册表（D-12 的核心设计）

`BiMetricsService.METRICS` 是**唯一权威**：每个指标同时声明
`key / name / unit / formula（可读中文口径）/ drillUrl`。

| key | 指标 | 口径要点 |
|---|---|---|
| `revenue` | 营业收入 | 已确认收入的不含税净额（`amount × 100/(100+taxRate)`）+ 已生效调整 |
| `cost` | 营业成本 | `erp_project_cost` 全部成本类型 |
| `gross_profit` / `gross_margin` | 毛利 / 毛利率 | 收入 − 成本；收入为 0 时毛利率记 0（不是 NaN） |
| `receipt_rate` | 回款率 | 已确认回款 / 累计应收（**历史累计口径**，非本期） |
| `ar_turnover_days` | 应收周转天数 | 期末应收余额 /（本期不含税收入 / 30） |
| `invoice_net` | 本期净开票额 | 本期销项 − 本期进项（仅 `status=issued`） |
| `active_projects` | 在管项目数 | `status ∈ (active, delivering, accepting)` |
| `over_budget_projects` | 超预算项目数 | 实际成本 > `estimated_total_cost` |
| `unpaid_ap` | 未付应付余额 | 应付未结清金额 |

**两条治理规则由单测强制**（`bi-metrics.spec.ts`）：

1. 每个指标必须有**非空中文口径**（`/[一-鿿]/` 校验）—— 否则指标中心退化成
   "只能看不能信"的仪表盘；
2. `drillUrl` 必须指向**仓库中真实存在的前端路由**（白名单与 `client/src/app.tsx` 同步）。

新增指标时必须同时：① 在 `METRICS` 登记口径与下钻；② 在 `metrics()` 的 `values`
中补计算；③ 若新增下钻页面，更新单测白名单。

## 预警订阅

- 唯一键 `(user_id, metric_key, channel)`：重复订阅返回 409，改为更新。
- 阈值方向 `gt`（高于触发）/ `lt`（低于触发）；渠道 `feishu` / `inbox`。
- 扫描逻辑：逐条订阅独立 `try/catch`（一条坏订阅不能让全部预警停摆）；
  **通知在事务外发送**（外部 IO 禁止在事务内）；触发后写 `last_triggered_at`
  便于排障"为什么今天没提醒"。

## 对外接口

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/bi/overview`、`project-margins`、`project-financial-health`、`customer-contributions`、`tax-distribution`、`monthly-trends`、`alerts` | `finance`（读） |
| GET | `/api/bi/hr-overview` | `hr`（读） |
| GET | `/api/bi/projects/:id/cost-breakdown` | 登录 + **项目可见范围校验**（B-02） |
| GET | `/api/bi/metrics?period=YYYY-MM` | `finance`（读） |
| GET | `/api/bi/metric-definitions` | 登录（前端渲染下拉用） |
| GET | `/api/bi/alert-subscriptions` | 登录（仅本人订阅） |
| POST | `/api/bi/alert-subscriptions` | `finance_write` |
| POST | `/api/bi/alert-subscriptions/:id/delete` | `finance_write`（仅本人） |
| GET | `/api/bi/alert-subscriptions/all` | `finance`（运维视图） |

## 定时任务

| trigger | 周期 | 行为 |
|---|---|---|
| `bi_alert_daily` | `30 8 * * *` | 计算当期指标 → 逐条订阅判定 → 命中即推送 |

通过 `comp_automation_config` 的 `bi_alert_daily` 总开关停用。
8:30 执行是为了让业务方**上午上班就能看到**前一日的预警。

## 测试入口

```bash
npx jest --config jest.config.cjs server/modules/bi
```

## 需业务确认

1. 回款率是"历史累计"还是"当期"口径（当前为累计，更贴近业务口语）。
2. 应收周转天数按 30 天/月折算是否合适（部分企业用 365/12≈30.42）。
3. 哪些角色应看到指标中心（当前限定 `finance` 读权限）。
