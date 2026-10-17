import { Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from '@server/platform';
import { unwrapRows } from '@server/common/utils/rows';
import {
  extractPgCode,
  isSilentSchemaDegrade,
} from './resolver-error-classification';

/** 模块级 logger：`safeQuery` 是纯函数（不注入），但失败必须可观测 */
const resolverLogger = new Logger('TaxEntityResolver');

/**
 * 凭证纳税主体归属的唯一解析口径（手工凭证与自动/钩子凭证共用）。
 *
 * 归属规则（与 `voucher.service.ts` 的历史注释一致，逐级兜底、不确定就不猜）：
 * ① 显式指定（DTO 传值 / 自动凭证调用点传入）；
 * ② `sourceRef` 命中合同（`erp_contract.code` 或 `id::text`）；
 * ③ 库中**恰有一个**启用中的默认纳税主体时用它顶替。
 *
 * 第 ③ 条刻意加了「恰有一个」：多主体下用默认主体顶替会让该主体报表虚增
 * ——「一个看起来正确的错误数字，比一个明显的缺口更危险」。推导不出时返回
 * `null`，由视图 `v_fin_voucher_unassigned_entity` 暴露为缺口。
 */
export async function resolveVoucherTaxEntityId(
  db: PostgresJsDatabase,
  options: {
    explicit?: string | null;
    sourceRef?: string | null;
    sourceType?: string | null;
  } = {},
): Promise<string | null> {
  const explicit = options.explicit?.trim();
  if (explicit) return explicit;

  const ref = options.sourceRef?.trim();
  // ②a sourceRef 直接就是合同编号 / 合同 id
  if (ref) {
    const found = await safeQuery<{ tax_entity_id: string | null }>(
      db,
      sql`
        SELECT tax_entity_id FROM erp_contract
        WHERE (code = ${ref} OR id::text = ${ref})
          AND tax_entity_id IS NOT NULL
        LIMIT 1
      `,
    );
    if (found[0]?.tax_entity_id) return found[0].tax_entity_id;
  }

  // ②b sourceRef 是业务单据编号：沿「业务单据 → 合同 → 主体」一跳取回。
  // 覆盖那些调用点尚未显式传参、但单据本身挂着合同的自动凭证（成本/收入/发票）。
  const code = ref?.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref;
  if (code) {
    const byDoc = await lookupBySourceType(db, options.sourceType, code);
    if (byDoc) return byDoc;
  }

  // ③ 库中恰有一个启用中的默认主体
  const candidates = await safeQuery<{ id: string }>(
    db,
    sql`
      SELECT id FROM md_tax_entity
      WHERE is_default = 1 AND status = 'active'
    `,
  );
  return candidates.length === 1 ? candidates[0].id : null;
}

/**
 * 按来源类型把单据编号解析到纳税主体。
 *
 * 只覆盖**一跳可达且已核对过表结构**的路径；其余返回 null 让上层逐级兜底。
 * 每次查询都裹在 try/catch 里：这里只是"兜底增强"，任何 schema 漂移都绝不能
 * 让调用方（凭证生成）整体失败 —— 失败时静默降级到下一级兜底。
 */
async function lookupBySourceType(
  db: PostgresJsDatabase,
  sourceType: string | null | undefined,
  code: string,
): Promise<string | null> {
  switch (sourceType) {
    case 'cost': {
      const rows = await safeQuery<{ tax_entity_id: string | null }>(
        db,
        sql`
          SELECT c.tax_entity_id
          FROM erp_project_cost pc
          JOIN erp_contract c ON c.id = pc.contract_id
          WHERE pc.code = ${code} AND c.tax_entity_id IS NOT NULL
          LIMIT 1
        `,
      );
      return rows[0]?.tax_entity_id ?? null;
    }
    case 'revenue': {
      const rows = await safeQuery<{ tax_entity_id: string | null }>(
        db,
        sql`
          SELECT c.tax_entity_id
          FROM erp_project_revenue r
          JOIN erp_contract c ON c.id = r.contract_id
          WHERE r.code = ${code} AND c.tax_entity_id IS NOT NULL
          LIMIT 1
        `,
      );
      return rows[0]?.tax_entity_id ?? null;
    }
    case 'invoice': {
      const rows = await safeQuery<{ tax_entity_id: string | null }>(
        db,
        sql`
          SELECT tax_entity_id FROM erp_invoice
          WHERE (invoice_no = ${code} OR code = ${code})
            AND tax_entity_id IS NOT NULL
          LIMIT 1
        `,
      );
      return rows[0]?.tax_entity_id ?? null;
    }
    default:
      return null;
  }
}

/**
 * §6.10 (7)：兜底查询 —— 可静默的 schema 错误与其他错误**分开处置**。
 *
 * ## 为什么要区分
 *
 * 原实现是 `catch { return [] }`：任何 DB 失败都降级为"查不到"。
 * 方向上是 fail-closed（不猜主体，不制造错误的归属），这一点是对的。
 * 但**一次 DB 故障会静默产生一批无主体凭证**，而日志里与
 * "确实没有匹配的合同"**无法区分** —— 运维既看不到故障、也看不到影响面。
 *
 * 现在分两类：
 *   · **可静默**：`42P01`（表不存在）/ `42703`（列不存在）——
 *     这两个是"环境尚未迁移完成"的特征码，是**预期内**的降级条件
 *     （例如补偿队列在迁移前被调用、单测用最小 schema）。它们不记日志，
 *     否则每次都会刷一条噪声，反而淹没真实故障。
 *   · **必须记录**：其余任何错误（连接断开、权限、超时、语法）——
 *     一律 `logger.error`，因为"查不到主体"与"数据库挂了"对业务的影响
 *     完全不同，前者是个别凭证待补，后者是**整批凭证都会无主体**。
 */
async function safeQuery<T>(
  db: PostgresJsDatabase,
  query: ReturnType<typeof sql>,
): Promise<T[]> {
  try {
    return unwrapRows<T>(await db.execute(query));
  } catch (error: unknown) {
    /*
     * 失败分类与 SQLSTATE 提取已抽到 `./resolver-error-classification`
     * （纯函数 + 12 条断言，含"code 藏在 cause 链里"与"取不到码不可静默"）。
     */
    if (isSilentSchemaDegrade(error)) {
      // 42P01 = undefined_table / 42703 = undefined_column（环境尚未迁移完成）
      resolverLogger.debug(
        `纳税主体兜底查询跳过（schema 未就绪 ${extractPgCode(error)}）：将按"查不到主体"处理`,
      );
      return [];
    }
    resolverLogger.error(
      `纳税主体兜底查询失败（code=${extractPgCode(error) ?? 'unknown'}）：本次将降级为"查不到主体"，` +
        `该批凭证会以无主体落库并出现在 v_fin_voucher_unassigned_entity 视图中待补。` +
        `这不是"确实没有匹配合同"，请检查数据库连通性与权限。`,
      error instanceof Error ? error.stack : String(error),
    );
    return [];
  }
}


