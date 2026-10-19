# 运维手册（RUNBOOK）

> 适用范围：单机/单容器部署的晟笙数据服务 ERP（NestJS + PostgreSQL + 静态前端）。
> 对应需求书 **B-11（CI/CD 与发布工程完善）** 与 **NFR-O 系列（可用性与运维）**。

生产入口只绑定 `127.0.0.1:3000`，由 HTTPS 反代对外。不要把 `COOKIE_SECURE=false` 用于生产，否则纯 HTTP 下会话 Cookie 不会被浏览器保存。

## 0. 快速定位

| 症状 | 先看这里 |
|---|---|
| 服务起不来 | §2 启动失败排查 |
| 接口 401/403 异常 | §3 权限问题 |
| 账务数字不对 | §4 账务核对 |
| 迁移失败 | §5 迁移与回滚 |
| 备份/恢复 | §6 备份与恢复演练 |
| 定时任务没跑 | §7 自动化任务 |

---

## 1. 健康检查与基本观测

```bash
curl -s http://127.0.0.1:PORT/api/health
```

- 日志：容器/进程 stdout（JSON 行）。关键前缀：`[migrate]`、`定时任务`、`凭证状态 voucherStatus=failed`。
- 数据库连接：`DATABASE_URL`（见 `.env`）。连接池 `max: 20`（`server/platform/database.ts`）。

## 2. 启动失败排查

按出现频率排序：

1. **缺少环境变量**：`DATABASE_URL`、`JWT_SECRET` 必需；缺 `JWT_SECRET` 时登录直接 401。
2. **初始管理员未创建**：首次启动需要 `BOOTSTRAP_ADMIN_PASSWORD`（≥8 位且需通过密码策略）。
   创建后会打 `已创建初始账号 …` 警告日志，**创建完请立即清空该变量**。
3. **迁移未执行**：表现为 `relation "xxx" does not exist`。见 §5。
4. **端口占用 / 静态目录缺失**：检查 `dist/client/index.html` 是否存在。

## 3. 权限问题（403 / 页面空白）

本项目 RBAC 的**唯一权威**是 `shared/rbac.ts` 的 `MATRIX`；后端装饰器只用
`@CanCapability`（写语义）/ `@CanCapabilityRead`（读语义）。

- 先跑一致性检查定位代码层问题：

```bash
npm run check:rbac
```

它会拦下：残留 `@CanRole`、能力码不在矩阵中、写方法使用只读装饰器、控制器缺 `@NeedLogin`。

- 用户报"按钮点了 403"：对照 `MATRIX` 看该角色对该能力是否为 `rw`。
  注意 **可读不等于可写**（`finance_viewer` 对 `finance` 是 `r`，对 `finance_write` 无权限）。
- 用户报"页面空白"：前端 `RequireCapability` 会渲染明确的"无访问权限"提示，
  若仍是空白，说明该路由未登记 `NAV_CAPABILITY`。

## 4. 账务核对（出报表前必做）

```bash
# 试算平衡（期间借贷必须相等）
curl -s "$BASE/api/finance/ledgers/trial-balance?period=2026-10"
```

三项恒等式（报表接口都会返回 `checks` 数组，`balanced=false` 时页头红色告警）：

1. **资产负债表**：资产总计 = 负债和所有者权益总计。
2. **利润表**：净利润 = 利润总额 − 所得税费用；净利润 ≈ 资产负债表未分配利润变动。
3. **现金流量表**：期初现金 + 现金净增加额 = 期末现金 = 资产负债表货币资金期末余额。

数字不符时的排查顺序：

1. 是否存在 **草稿凭证** 未过账（`GET /api/voucher/periods` 看 `draftCount`）。
2. 是否存在 **作废凭证**（账务取数一律排除 `status = 'voided'`）。
3. 是否 **跨期记账**。期间由 `voucher_date` 前 7 位决定，两者必须一致。
4. 分录是否挂在 **非末级科目**（`fin_account.is_leaf = 0`）。历史数据里若有，
   用 `GET /api/finance/ledgers/account-balance` 观察父科目与子科目是否重复计入。
5. 年结后该年度期间只读；如需调整必须先**反年结**（`POST /api/finance/year-end/:year/reverse`，
   需 reason ≥4 字 + `approved: true`）。

## 5. 迁移与回滚

```bash
npm run migrate:dryrun     # 无数据库即可跑：在 pglite（WASM PostgreSQL）上全量执行迁移链
npm run db:migrate         # 真实库；单条迁移事务化，失败即整体回滚且不登记
```

- **改名迁移文件的顺序陷阱**（本项目已踩过）：迁移按**文件名排序**执行。
  新增迁移的文件名必须排在它所依赖的建表迁移**之后**。
  例：`...-batch1z-code-rules-seed.sql` 里的 `z` 就是为了排到
  `...-batch1-system-config.sql` 之后。改名前先跑 `npm run migrate:dryrun` 验证。
- `schema_migrations` 表记录已应用的文件名；**重命名已应用的迁移会导致重复执行**，
  因此所有迁移的 DDL 必须幂等（`IF NOT EXISTS` / `DO $$ ... EXCEPTION WHEN duplicate_object`）。

**回滚**：数据库无自动 down 迁移。回滚策略是"恢复到上一版本备份 + 回滚应用镜像"：

```bash
node ./scripts/restore-db.mjs <备份文件>    # 见 §6
git checkout <上一 tag> && npm run build:prod && 重启
```

## 6. 备份与恢复演练（NFR-O2/O3/O5）

```bash
node ./scripts/backup-db.mjs            # 产出备份文件
node ./scripts/restore-db.mjs <文件>     # 恢复
```

演练要求：

- **每季度一次**，并在 `deliverables/drills/` 下留档（负责人、时间、RPO/RTO 实测）。
- 恢复后必须复跑 §4 的三项恒等式确认数据可用，而不是只看进程起来了。

## 7. 自动化任务

任务总开关在 `comp_automation_config`，页面 `/admin-automation`（仅 admin）。

| trigger | 周期 | 用途 |
|---|---|---|
| `ar_due_reminder_daily` | `0 9 * * *` | 应收逾期/临期提醒 |
| `delivery_warning_weekly` | `0 9 * * 1` | 交付里程碑/SPI/CPI 预警 |
| `customer_credit_alert` | `0 9 * * *` | 客户信用预警 |
| `admin_rent_expiry_remind` | `0 9 * * *` | 行政租约到期 |
| `voucher_job_retry` | `*/10 * * * *` | 凭证失败队列重试（最多 8 次） |
| `session_cleanup_daily` | `15 3 * * *` | 登录会话清理 |
| `retention_daily` | `30 3 * * *` | 数据保留归档（B-07）+ MFA 挑战票据清理（B-04） |
| `year_end_reminder_daily` | `0 9 * * *` | 12 月 20 日起年结前置检查提醒 |

时区统一 `Asia/Shanghai`；`ENABLE_SCHEDULER=false` 可整体关闭（本地开发用）。
多实例部署时由 `pg_try_advisory_xact_lock` 保证同一任务只有一个实例执行。

## 8. 凭证失败队列

业务成功但凭证生成失败时写入 `comp_voucher_job`（`status='failed'`），
由 `voucher_job_retry` 自动重试。

```sql
SELECT source_type, source_ref, attempts, last_error FROM comp_voucher_job
WHERE status = 'failed' ORDER BY next_retry_at NULLS FIRST LIMIT 20;
```

- `attempts >= 8` 或 `status = 'dead'` 的需人工补录：
  用 `POST /api/voucher/vouchers` 手工建凭证，或在源单据上重触发业务动作。
- **不要在业务成功后手工删源单据**，否则凭证与业务永久不一致。

## 9. 发布流程

```bash
npm run type:check && npm run lint && npm run check:rbac && npm run check:contract
npm run migrate:dryrun && npm test && npm run test:cov
npm run build:prod
```

- 数据库迁移必须作为**独立步骤**在应用启动前执行（`docker-compose` 中的 one-shot `migrate` 服务）。
- 上线前确认已打 tag（不可变），并记录发布说明与回滚点。
