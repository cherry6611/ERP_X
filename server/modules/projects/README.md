# 项目管理模块（`server/modules/projects/`）

覆盖项目全生命周期：立项 → 里程碑 → 交付物验收 → 变更 → 结项，以及 EVM 挣值、
数据级权限（项目可见范围）、周报与纪要。

## 职责与文件

| 文件 | 职责 |
|---|---|
| `projects.controller.ts` | 路由与权限（`projects` 读 / `projects_write` 写） |
| `projects.service.ts` | 项目查询、建改、合同链路（商机/合同 → 项目） |
| `projects-status.service.ts` | **状态机与结项闭环**（交付物全 accepted + 里程碑全 reached + closeSummary 必填） |
| `projects.transform.ts` | `toProject` 与状态机表（唯一的状态流转定义处） |
| `projects.dto.ts` | 请求体 class DTO（API-1，class 必须定义在 controller 之前） |
| `project-acl.service.ts` | **B-02 项目可见范围**（复用 `DataScopeService`） |
| `deliverable.service.ts` | 交付物状态机 `pending → submitted → accepted | returned` |
| `minutes.service.ts` | 周报/纪要（`weekly_report` / `meeting`） |
| `delivery-warning.automation.ts` | `delivery_warning_weekly`（周一 09:00）逾期/临期里程碑 + SPI/CPI<0.9 预警 |

## 涉及表

`erp_project`（`estimated_total_cost` / `close_summary` / `close_at`）、`erp_project_milestone`
（`baseline_date` / `forecast_date` / `weight_pct`）、`erp_deliverable`（`accept_conclusion`）、
`erp_project_change`、`erp_project_minutes`、`erp_project_revenue`、`erp_project_cost`、
`erp_project_drive_sync`。

## 对外接口（摘要）

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/projects`、`/api/projects/:id`、`/api/projects/:id/accounting`、`/chain-overview` | `projects`（读，且受项目可见范围过滤） |
| POST/PATCH | `/api/projects`、`/api/projects/:id` | `projects_write` |
| POST | `/api/projects/:id/status` | `projects_write`（结项需 `closeSummary`） |
| GET/POST | `/api/projects/:id/milestones`、`/deliverables`、`/changes`、`/minutes`、`/revenues` | `projects` / `projects_write` |
| POST | `/api/projects/deliverables/:id/accept`、`/return` | `projects_write` |

## 状态机

项目（`projects.transform.ts`）：

```
draft → active → accepting → closed
              ↘ suspended ↗
任意非终态 → cancelled
```

结项前置（缺一不可，否则 400）：

1. 全部交付物 `accepted`；
2. 全部里程碑 `reached`；
3. `closeSummary` 非空。

结项副作用：同合同项目全部结项时回写合同 `completed`；
并向 admin 推送结项报告通知（复用 `send_erp_approval_notification_1`，**失败不阻塞结项**）。

## 进度与挣值

- **有加权里程碑**时，进度 = 已达成里程碑权重 / 总权重（自动重算）；
  **无权重**项目保持手动进度（不强行覆盖，避免历史项目进度跳变）。
- EVM 采用**里程碑权重法**（`common/utils/evm.ts`）：SPI / CPI / EAC；
  无加权里程碑或分母为 0 时返回 `null`（而不是 0 —— 0 会被误读为"严重滞后"）。

## 数据级权限（B-02）

`project-acl.service.ts` 把 `sys_data_scope` 解析为 SQL 条件注入项目列表/详情查询：

- `all` → 不加条件；
- `self` → 按项目负责人/成员列过滤；
- `dept` / `dept_and_child` → 按归属部门过滤；
- 需要收窄但拿不到可用值 → `1 = 0`（**fail-closed**，返回空集而不是全量）。

越权访问（绕过 UI 直连接口）会被 `assertVisible` 拒绝并记 warn 日志。

## 测试入口

```bash
npx jest --config jest.config.cjs server/modules/projects server/common/auth
```

`server/common/auth/data-scope.service.spec.ts` 逐条断言每种 scope 生成的 SQL 条件语义
（`all` 不加条件、`self` 绑定本人、`dept` 绑定本部门、无值 fail-closed）。
