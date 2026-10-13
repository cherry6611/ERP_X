# 数据库备份与恢复（RTO）

本文说明如何使用仓库内脚本完成 PostgreSQL 备份与恢复，支撑故障恢复演练与上线前快照。

## 前置条件

- 已配置环境变量 `DATABASE_URL`（形如 `postgres://user:pass@host:5432/dbname`）
- 本机已安装 `pg_dump` / `psql`，**或** 可通过 `docker compose` 访问名为 `postgres` 的服务
- 工作目录为项目根目录 `code/`（脚本相对路径依赖此约定）

## 备份（RPO 快照）

脚本：`scripts/backup-db.mjs`

```bash
# 默认输出 backup-YYYY-MM-DD.sql
DATABASE_URL=postgres://... node scripts/backup-db.mjs

# 指定文件名
DATABASE_URL=postgres://... BACKUP_FILE=backup-pre-release.sql node scripts/backup-db.mjs
```

行为摘要：

1. 优先调用本机 `pg_dump --dbname $DATABASE_URL --file $BACKUP_FILE`
2. 若本机无 `pg_dump`，回退为 `docker compose exec -T postgres pg_dump ...` 并将 stdout 写入文件
3. 成功后控制台打印 `已写入 <文件路径>`

建议：重大迁移 / 上线前执行一次，并将文件复制到异地或对象存储。

## 恢复（RTO 步骤）

脚本：`scripts/restore-db.mjs`  
**危险操作**：会向目标库执行备份 SQL，可能覆盖现有数据。

### 推荐流程（目标 RTO：按库体积约 15–60 分钟）

1. **确认目标**：`DATABASE_URL` 指向拟恢复的库（切勿误连生产未确认窗口）
2. **停写 / 停服务**：停止应用进程与定时任务，避免恢复中途写入
3. **（可选）再做一次当前库快照**：`BACKUP_FILE=backup-before-restore.sql node scripts/backup-db.mjs`
4. **执行恢复**：

```bash
DATABASE_URL=postgres://... BACKUP_FILE=backup-YYYY-MM-DD.sql node scripts/restore-db.mjs
```

5. **校验**：抽查关键表行数、最近凭证/合同；跑 `npm run type:check:server` 与冒烟脚本（如有）
6. **启服务**：恢复应用与 cron，观察错误日志与凭证补偿队列

### 失败回滚

若恢复中断或校验失败：用步骤 3 的 `backup-before-restore.sql` 再次 `restore-db.mjs`，或从异地副本重建实例后重跑备份文件。

## 环境变量一览

| 变量 | 用途 |
|------|------|
| `DATABASE_URL` | 连接串（备份与恢复均必填） |
| `BACKUP_FILE` | 备份输出路径 / 恢复输入路径 |
| `POSTGRES_USER` / `POSTGRES_DB` | 仅 docker 回退路径使用，默认 `erp` / `shengseerp` |

## 注意

- `restore-db.mjs` 要求显式设置 `BACKUP_FILE`，避免误用空路径
- 逻辑备份（SQL）适合中小库；超大库请评估物理备份 / PITR
- 含密钥的库恢复后应轮换应用密钥与飞书密钥（若备份含密文）
