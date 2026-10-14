# D-09：等保/内控合规加固

> 对应需求书 **D-09**（P1，60–100 h）与非功能需求 **NFR-S6/S7/S8**。
> 本文件记录**已落地**的部分、**验证方式**与**仍未做**的部分 —— 不夸大覆盖度。

## 1. 已落地：审计日志防篡改（NFR-S8）

需求原文：*审计日志不可篡改（追加写 + 校验和 + 归档）* —— 原状态是"可 UPDATE"。

### 1.1 链式校验和

`2026-10-15-upgrade-d09-audit-immutability.sql` 给 `comp_audit_log` 增加三列：

| 列 | 含义 |
|---|---|
| `chain_seq` | 链序号（显式顺序，避免 `_created_at` 毫秒并列导致排序不稳定） |
| `prev_hash` | 上一行的 `chain_hash`；首行为 `GENESIS` |
| `chain_hash` | `md5(prev_hash\|seq\|actor\|action\|object_type\|object_id\|object_code\|创建时间\|detail)` |

`trg_comp_audit_log_chain` 触发器在 INSERT 时自动串链，并用
`pg_advisory_xact_lock(hashtext('comp_audit_log_chain'))` 串行化
"读上一行 hash → 写入"这一对操作。**不加锁会导致并发插入读到同一个 `prev_hash`，
链分叉且校验必然失败** —— 这是该设计里最容易漏掉的一点。

### 1.2 只追加约束

`trg_comp_audit_log_immutable` 触发器：

- **UPDATE 一律拒绝**（`ERRCODE = restrict_violation`，消息为可读中文）；
- **DELETE 仅允许**在会话内显式设置 `app.retention_purge = 'on'` 时执行。

为什么给 DELETE 留例外：`retention.service.ts` 的归档流程是"先复制进
`comp_audit_log_archive` 再删在线行"（语义是**移出在线表**，不是销毁）。
若直接封死 DELETE，归档功能会失效。留例外的代价是"清理动作本身必须显式"，
这恰好符合内控要求：**谁在什么时候清理了审计日志，是一次有意为之的操作**，
而不是被某段业务代码顺手删掉。`SET LOCAL`（`set_config(..., true)`）保证标记
不会泄漏到事务外。

归档表同步记录 `source_chain_hash` / `source_chain_seq`，便于事后比对。

### 1.3 校验与锚点

| 接口 | 作用 |
|---|---|
| `GET /api/audit/chain-verification` | 在线重算整条链，返回 `intact` 与最多 50 条异常明细 |
| `GET /api/audit/chain-anchor` | 导出 `(lastSeq, lastHash, totalRows, checkedAt)` 供**外发留存** |
| `GET /api/audit/immutability-probe` | 真的去 UPDATE/DELETE 一次并断言被拒（等保演示用） |

前端「审计日志」页顶部有校验面板（校验链 / 只追加自检 / 导出锚点）。

## 2. 验证方式（这是本节的重点）

| 层次 | 手段 | 能证明什么 |
|---|---|---|
| 迁移可执行 | `npm run migrate:dryrun`（pglite） | 迁移语法与依赖顺序正确 |
| DB 行为（离线） | `server/test/integration/audit-immutability.spec.ts`（8 例） | 触发器在 PostgreSQL 语义下真的拒绝 UPDATE/DELETE；`SET LOCAL` 不泄漏 |
| **DB 行为（真实库）** | `npm run check:audit-immutability`（10 项） | 在**真实 PostgreSQL** 上验证约束、异常码、归档例外与标记不泄漏 |

第三层是必需的：pglite 与真实 PostgreSQL 在触发器与异常码上不保证一致，
"迁移 dryrun 通过"**不等于**"生产库上改删会被拒绝"。CI 在配置了
`secrets.DATABASE_URL` 时执行第三层，未配置时打印 `::warning::` 并跳过
（不静默通过）。

### 2.1 一个值得记录的验证陷阱

`check-audit-immutability.mjs` 第一版第 ⑨ 项误报"`SET LOCAL` 泄漏"。
真实原因是第 ⑧ 项已经把探针行删掉了，第 ⑨ 项的
`DELETE ... WHERE actor='d09-probe'` 影响 **0 行**，而触发器是
`FOR EACH ROW` —— **0 行即不触发**，于是"没有报错"被误读为"允许删除"。

教训：验证"约束会拒绝"时，必须**先确认待操作的行确实存在**，
否则断言的是一个永远为真的空操作。

## 3. 仍未做（如实记录）

### 3.1 威胁模型的边界（必须让读者知道）

链式校验和能**检测**篡改，**不能阻止**拥有数据库写权限的人篡改 ——
对方可以改完内容再重算其后所有行的 hash。要真正不可抵赖，必须把
`(chain_seq, chain_hash)` **定期外发**到独立日志系统或可信时间戳服务。
本实现已提供锚点导出接口，**但外发通道与定时任务未实现**。

### 3.2 NFR-S6 外部渗透测试

未做，且**不是本仓库能完成的**：需要第三方安全厂商在真实部署环境执行。
需求书自己也写"上线满 6 个月后建议做一次"。

### 3.3 NFR-S7 密钥托管（KMS / secret manager）

未做。现状：`docker-compose` 的 `environment` 明文、`.env` 文件承载
`JWT_SECRET`、飞书 app secret、数据库口令。要做需接入 KMS 或
Vault/AWS Secrets Manager，并改造 `platform/` 的配置读取。
这属于**基础设施改造**，不是应用代码改动。

### 3.4 NFR-S1 全站 HTTPS / 禁用 TLS < 1.2

未做。属于反向代理/入口层配置（Nginx / 网关 / 云 LB），不在应用代码内。
本项目已在 `docs/RUNBOOK.md` 记录发布流程，但未落地 TLS 终止配置。

### 3.5 NFR-S2 关键操作二次确认 + 理由必填

**部分完成**：前端已有 `confirmDanger`（AlertDialog 统一二次确认），
后端在若干关键动作上强制理由（如反年结 `reason ≥4 字 + approved`、
C-13 的 L4 授权回收需复核人 + 销毁凭证）。但**缺少逐项清单核对** ——
需求书要求的是"逐项确认清单"，即把哪些操作必须二次确认、哪些必须填理由
固化成一份可审计的矩阵。清单未产出。

## 4. 运维入口

```bash
# 真实库自检（建议每月一次，以及渗透测试/等保测评前）
npm run check:audit-immutability

# 只查结构与链完整性，不写探针
node ./scripts/check-audit-immutability.mjs --dry-run
```

发现不符合项时：先确认迁移是否已应用（`schema_migrations` 是否含
`2026-10-15-upgrade-d09-audit-immutability.sql`），再检查触发器是否存在：

```sql
SELECT tgname FROM pg_trigger
WHERE tgrelid = 'comp_audit_log'::regclass AND NOT tgisinternal;
-- 期望两行：trg_comp_audit_log_chain、trg_comp_audit_log_immutable
```
