-- 批次三 / D-09 + NFR-S8：审计日志防篡改（追加写 + 校验和链）
-- requires: 2026-10-15-upgrade-batch1-system-config.sql
--
-- 背景：NFR-S8 明确要求「审计日志不可篡改（追加写 + 校验和 + 归档）」，
-- 而 `comp_audit_log` 当前**可以被任意 UPDATE**（表上没有只追加约束），
-- 也没有校验和，因此"日志被改过"这件事本身无法被发现。等保测评会把这条列为不符合项。
--
-- 本迁移做两件事：
--   ① 为每条日志计算**链式校验和**（prevc链 + 本行内容的 md5），
--      任何一行被改动都会导致其后所有行校验失败 —— 篡改可被检测；
--   ② 安装**只允许追加**的触发器：UPDATE 一律拒绝；
--      DELETE 仅允许"归档清理"这一个明确的、带会话标记的例外。
--
-- 【为什么用 md5 而不是 sha256】pgcrypto 的 `digest()` 在 pglite（WASM PostgreSQL）
-- 上不可用，而迁移链必须在 pglite 上可跑（CI 门 `migrate:dryrun`）。`md5()` 是
-- 内置函数，两地都可用。审计场景要的是"篡改可检测"，md5 的碰撞抗性足够；
-- 若贵司等保要求 SHA-256，可改用 pgcrypto 并让 dryrun 容忍该扩展缺失。
--
-- 【口径需合规确认】
--   1. 链式校验只能**检测**篡改，不能**阻止**直接改库的超级用户（数据库层无此能力）。
--      若要强不可抵赖，需把 (seq, chain_hash) 定期外发到独立日志系统/时间戳服务。
--   2. 归档清理会**删除在线行**（`retention.service.ts` 的 archiveAuditLogs 先复制到
--      `comp_audit_log_archive` 再删）。删除会打断链（后一行的 prev_hash 指向已删除行），
--      因此校验器把"链根不被现有行引用"视为**正常**（归档导致），而不是篡改。
--      这条口径必须与审计沟通确认。

/* ========== ① 链式校验和列 ========== */

-- 链序号：显式记录顺序，避免 _created_at 毫秒级并列时排序不稳定而误报篡改
ALTER TABLE comp_audit_log ADD COLUMN IF NOT EXISTS chain_seq bigint;
ALTER TABLE comp_audit_log ADD COLUMN IF NOT EXISTS prev_hash varchar(64);
ALTER TABLE comp_audit_log ADD COLUMN IF NOT EXISTS chain_hash varchar(64);

CREATE INDEX IF NOT EXISTS idx_comp_audit_log_chain_seq
  ON comp_audit_log (chain_seq);
CREATE INDEX IF NOT EXISTS idx_comp_audit_log_chain_hash
  ON comp_audit_log (chain_hash);

-- 历史数据回填：按插入顺序（_created_at, id）编号并逐行串链。
-- 用 DO 块 + 游标，因为链式计算必须严格按顺序逐行（集合式 UPDATE 无法引用上一行结果）。
DO $$
DECLARE
  r record;
  v_seq bigint := 0;
  v_prev varchar(64) := 'GENESIS';
  v_hash varchar(64);
BEGIN
  -- 已有链的行不动（幂等：重复执行不会重算已串好的链）
  IF EXISTS (SELECT 1 FROM comp_audit_log WHERE chain_hash IS NOT NULL) THEN
    -- 但确保 seq 连续（补 NULL 的行）
    UPDATE comp_audit_log SET chain_seq = sub.rn
    FROM (SELECT id, row_number() OVER (ORDER BY _created_at, id) AS rn
          FROM comp_audit_log WHERE chain_seq IS NULL) sub
    WHERE comp_audit_log.id = sub.id;
    RETURN;
  END IF;

  FOR r IN
    SELECT id, actor, action, object_type, coalesce(object_id::text, '') AS object_id,
           coalesce(object_code, '') AS object_code, detail,
           _created_at
    FROM comp_audit_log
    ORDER BY _created_at, id
  LOOP
    v_seq := v_seq + 1;
    v_hash := md5(
      v_prev || '|' || v_seq::text || '|' || coalesce(r.actor, '') || '|' ||
      coalesce(r.action, '') || '|' || coalesce(r.object_type, '') || '|' ||
      r.object_id || '|' || r.object_code || '|' ||
      to_char(r._created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '|' ||
      coalesce(r.detail, '')
    );
    UPDATE comp_audit_log
    SET chain_seq = v_seq, prev_hash = v_prev, chain_hash = v_hash
    WHERE id = r.id;
    v_prev := v_hash;
  END LOOP;
END $$;

/* ========== ② 只追加约束 ========== */

-- 插入时自动串链。
--
-- 并发安全：用事务级 advisory lock 串行化"读上一行 hash → 写入"这一对操作。
-- 若不加锁，两个并发插入会读到同一个 prev_hash，链出现分叉且校验必然失败。
CREATE OR REPLACE FUNCTION comp_audit_log_chain_on_insert()
RETURNS trigger AS $$
DECLARE
  v_prev varchar(64);
  v_seq bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('comp_audit_log_chain'));

  SELECT chain_hash, chain_seq INTO v_prev, v_seq
  FROM comp_audit_log
  WHERE chain_hash IS NOT NULL
  ORDER BY chain_seq DESC NULLS LAST
  LIMIT 1;

  IF v_prev IS NULL THEN
    v_prev := 'GENESIS';
    v_seq := 0;
  END IF;

  NEW.chain_seq := v_seq + 1;
  NEW.prev_hash := v_prev;
  NEW.chain_hash := md5(
    v_prev || '|' || NEW.chain_seq::text || '|' || coalesce(NEW.actor, '') || '|' ||
    coalesce(NEW.action, '') || '|' || coalesce(NEW.object_type, '') || '|' ||
    coalesce(NEW.object_id::text, '') || '|' || coalesce(NEW.object_code, '') || '|' ||
    to_char(NEW._created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '|' ||
    coalesce(NEW.detail, '')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_comp_audit_log_chain ON comp_audit_log;
CREATE TRIGGER trg_comp_audit_log_chain
  BEFORE INSERT ON comp_audit_log
  FOR EACH ROW
  EXECUTE FUNCTION comp_audit_log_chain_on_insert();

-- 篡改防护：UPDATE / DELETE 一律拒绝。
--
-- 唯一的例外是归档清理：`retention.service.ts` 先把超期行复制进
-- `comp_audit_log_archive`，再从在线表删除（表名带 `_archive`，语义是"移出在线表"
-- 而非"销毁"）。允许它需要显式设置会话标记 `app.retention_purge = 'on'`，
-- 这样"谁在什么时候清理了审计日志"本身也是一次有意为之的操作，
-- 而不是某个业务代码顺手 DELETE。
CREATE OR REPLACE FUNCTION comp_audit_log_block_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION
      '审计日志不可修改（NFR-S8 只追加约束）。如需更正请追加一条新的更正记录，action=%', OLD.action
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    IF coalesce(current_setting('app.retention_purge', true), '') <> 'on' THEN
      RAISE EXCEPTION
        '审计日志不可删除（NFR-S8 只追加约束）。归档清理需显式设置 app.retention_purge=on，action=%', OLD.action
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_comp_audit_log_immutable ON comp_audit_log;
CREATE TRIGGER trg_comp_audit_log_immutable
  BEFORE UPDATE OR DELETE ON comp_audit_log
  FOR EACH ROW
  EXECUTE FUNCTION comp_audit_log_block_mutation();

/* ========== ③ 归档表也记录来源校验和，便于事后比对 ========== */

ALTER TABLE comp_audit_log_archive ADD COLUMN IF NOT EXISTS source_chain_hash varchar(64);
ALTER TABLE comp_audit_log_archive ADD COLUMN IF NOT EXISTS source_chain_seq bigint;

CREATE INDEX IF NOT EXISTS idx_comp_audit_archive_chain
  ON comp_audit_log_archive (source_chain_seq);
