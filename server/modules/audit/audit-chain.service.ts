import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { sql } from 'drizzle-orm';
import { unwrapRows } from '@server/common/utils/rows';
import type { AuditChainVerification } from '@shared/api.interface';

/**
 * D-09 / NFR-S8：审计日志防篡改校验链。
 *
 * ## 威胁模型（必须说清楚，否则会给人虚假的安全感）
 *
 * 链式校验和能**检测**篡改，但**不能阻止**拥有数据库写权限的人篡改 ——
 * 对方可以改完内容再重算其后所有行的 hash。要真正不可抵赖，必须把
 * `(chain_seq, chain_hash)` 定期外发到独立的日志系统或时间戳服务
 * （见 `docs/升级落地状态台账` 的遗留清单）。
 *
 * 因此本服务提供两个层次：
 *   1. `verify()`：在线校验整条链，回答"**有没有被改过**"；
 *   2. `anchor()`：导出一份可外发的锚点（seq + hash + 条数），
 *      把它发到别处就获得"当时链长这样"的独立证据。
 *
 * ## 归档导致链断裂是正常的
 *
 * `retention.service.ts` 会定期把超期行**移出**在线表（复制进
 * `comp_audit_log_archive` 后删除）。删除后，剩下第一行的 `prev_hash`
 * 指向一个不存在的 hash —— 这**不是**篡改。因此校验规则是：
 * - 从**最早一行**开始重算链，每行必须满足 `chain_hash = md5(prev|内容)`；
 * - 最早一行的 `prev_hash` 只要求"不是凭空出现的非 GENESIS 值"，
 *   且该值必须能在归档表中找到（证明它是被归档掉了，而不是被抹掉了）。
 */
@Injectable()
export class AuditChainService {
  private readonly logger = new Logger(AuditChainService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  /**
   * 校验链完整性。
   *
   * @param limit 最多校验多少行（从最早开始），默认 5000；
   *              审计量大时可用 `fromSeq` 分段校验
   */
  async verify(options?: { limit?: number }): Promise<AuditChainVerification> {
    const limit = Math.min(Math.max(options?.limit ?? 5000, 1), 50000);

    const rows = unwrapRows<{
      id: string;
      chain_seq: string | number | null;
      prev_hash: string | null;
      chain_hash: string | null;
      computed: string | null;
    }>(
      await this.db.execute(sql`
        SELECT id,
               chain_seq,
               prev_hash,
               chain_hash,
               md5(
                 coalesce(prev_hash, 'GENESIS') || '|' || chain_seq::text || '|' ||
                 coalesce(actor, '') || '|' || coalesce(action, '') || '|' ||
                 coalesce(object_type, '') || '|' ||
                 coalesce(object_id::text, '') || '|' || coalesce(object_code, '') || '|' ||
                 to_char(_created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '|' ||
                 coalesce(detail, '')
               ) AS computed
        FROM comp_audit_log
        WHERE chain_hash IS NOT NULL
        ORDER BY chain_seq ASC NULLS LAST
        LIMIT ${limit}
      `)
    );

    const totalRows = unwrapRows<{ total: number }>(
      await this.db.execute(sql`
        SELECT count(*)::int AS total FROM comp_audit_log WHERE chain_hash IS NOT NULL
      `)
    )[0];

    const broken: AuditChainVerification['broken'] = [];
    let expectedPrev: string | null = null;

    for (const row of rows) {
      const seq = Number(row.chain_seq ?? 0);
      const stored = row.chain_hash ?? '';
      const computed = row.computed ?? '';
      const prev = row.prev_hash ?? '';

      // ① 本行内容与校验和不一致 → 内容被改过
      if (stored !== computed) {
        broken.push({
          id: row.id,
          chainSeq: seq,
          reason: '校验和不匹配（该行内容被修改过）',
          expected: computed,
          actual: stored,
        });
      }

      // ② 链断裂：本行 prev_hash 应等于上一行的 chain_hash
      if (expectedPrev !== null && prev !== expectedPrev) {
        broken.push({
          id: row.id,
          chainSeq: seq,
          reason: '链断裂（prev_hash 与上一行校验和不一致，中间可能有行被删除）',
          expected: expectedPrev,
          actual: prev,
        });
      }

      // ③ 最早一行的 prev_hash：GENESIS 或"归档表中能找到"才算正常
      if (expectedPrev === null && prev !== 'GENESIS') {
        const anchored = unwrapRows<{ total: number }>(
          await this.db.execute(sql`
            SELECT count(*)::int AS total
            FROM comp_audit_log_archive
            WHERE source_chain_hash = ${prev}
          `)
        )[0];
        if (Number(anchored?.total ?? 0) === 0) {
          broken.push({
            id: row.id,
            chainSeq: seq,
            reason:
              '链根异常（最早一行的 prev_hash 既不是 GENESIS，也不在归档表中 —— 疑似在线日志被抹除）',
            expected: 'GENESIS 或归档表中存在的校验和',
            actual: prev,
          });
        }
      }

      expectedPrev = stored;
    }

    const last = rows[rows.length - 1];
    const verification: AuditChainVerification = {
      checkedAt: new Date().toISOString(),
      totalOnlineRows: Number(totalRows?.total ?? 0),
      checkedRows: rows.length,
      firstSeq: rows.length > 0 ? Number(rows[0].chain_seq ?? 0) : null,
      lastSeq: last ? Number(last.chain_seq ?? 0) : null,
      lastHash: last?.chain_hash ?? null,
      intact: broken.length === 0,
      broken: broken.slice(0, 50),
    };
    if (!verification.intact) {
      this.logger.error(
        `审计链校验失败：${broken.length} 处异常（已检查 ${rows.length} 行）`
      );
    }
    return verification;
  }

  /**
   * 导出链锚点：`(lastSeq, lastHash, totalRows, checkedAt)`。
   *
   * 用途：由外部系统（另一台机器 / 另一份日志 / 时间戳服务）保存这个四元组。
   * 事后只要再跑一次 `verify()` 并对比锚点，就能证明"这段日志没有被整体重写" ——
   * 这是纯在线校验和做不到的（改完重算 hash 可以骗过在线校验，但骗不过外部锚点）。
   */
  async anchor(): Promise<{
    lastSeq: number | null;
    lastHash: string | null;
    totalRows: number;
    checkedAt: string;
  }> {
    const row = unwrapRows<{
      chain_seq: string | number | null;
      chain_hash: string | null;
    }>(
      await this.db.execute(sql`
        SELECT chain_seq, chain_hash
        FROM comp_audit_log
        WHERE chain_hash IS NOT NULL
        ORDER BY chain_seq DESC NULLS LAST
        LIMIT 1
      `)
    )[0];
    const total = unwrapRows<{ total: number }>(
      await this.db.execute(sql`
        SELECT count(*)::int AS total FROM comp_audit_log WHERE chain_hash IS NOT NULL
      `)
    )[0];
    return {
      lastSeq: row?.chain_seq === null || row?.chain_seq === undefined
        ? null
        : Number(row.chain_seq),
      lastHash: row?.chain_hash ?? null,
      totalRows: Number(total?.total ?? 0),
      checkedAt: new Date().toISOString(),
    };
  }

  /** 篡改演练：尝试直接 UPDATE 一行并断言被数据库拒绝（供运维自检/等保演示） */
  async assertImmutableProbe(): Promise<{
    updateBlocked: boolean;
    deleteBlocked: boolean;
    message: string;
  }> {
    let updateBlocked = false;
    let deleteBlocked = false;
    try {
      await this.db.execute(sql`
        UPDATE comp_audit_log SET detail = 'probe'
        WHERE id = (SELECT id FROM comp_audit_log LIMIT 1)
      `);
    } catch {
      updateBlocked = true;
    }
    try {
      await this.db.execute(sql`
        DELETE FROM comp_audit_log
        WHERE id = (SELECT id FROM comp_audit_log LIMIT 1)
      `);
    } catch {
      deleteBlocked = true;
    }
    return {
      updateBlocked,
      deleteBlocked,
      message:
        updateBlocked && deleteBlocked
          ? '只追加约束生效：直接修改与删除均被数据库拒绝（NFR-S8）'
          : '只追加约束未生效，请检查迁移 2026-10-15-upgrade-d09-audit-immutability.sql 是否已应用',
    };
  }
}
