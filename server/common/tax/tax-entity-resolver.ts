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
 * 查询本身失败（断连、超时、权限），不是“没有匹配的合同”。
 * 调用方必须失败，不能再落到默认纳税主体。
 */
export class TaxEntityLookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxEntityLookupError';
  }
}

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

  /*
   * ③ 兜底。启用主体恰好 1 个时用它。
   * 多于 1 个时不再用默认主体填任何来源类型的缺口。
   */
  const active = await listActiveTaxEntityIds(db);
  return active.length === 1 ? active[0] : null;
}

/** 折旧、报销、采购退货、销售退货：多主体下禁止默认主体兜底。 */
export function isStrictTaxEntitySource(sourceType: string | null | undefined): boolean {
  return (
    sourceType === 'expense' ||
    sourceType === 'depreciation' ||
    sourceType === 'purchase_return' ||
    sourceType === 'sales_return'
  );
}

export async function listActiveTaxEntityIds(db: PostgresJsDatabase): Promise<string[]> {
  const rows = await safeQuery<{ id: string }>(
    db,
    sql`SELECT id FROM md_tax_entity WHERE status = 'active' ORDER BY id`,
  );
  return rows.map((row) => row.id);
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
          SELECT coalesce(pc.tax_entity_id, c.tax_entity_id) AS tax_entity_id
          FROM erp_project_cost pc
          LEFT JOIN erp_contract c ON c.id = pc.contract_id
          WHERE pc.code = ${code}
            AND coalesce(pc.tax_entity_id, c.tax_entity_id) IS NOT NULL
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
    case 'expense': {
      const rows = await safeQuery<{ tax_entity_id: string | null }>(
        db,
        sql`
          SELECT coalesce(cl.tax_entity_id, c.tax_entity_id) AS tax_entity_id
          FROM fin_expense_claim cl
          LEFT JOIN erp_project p ON p.id = cl.project_id
          LEFT JOIN erp_contract c ON c.id = p.contract_id
          WHERE cl.code = ${code}
            AND coalesce(cl.tax_entity_id, c.tax_entity_id) IS NOT NULL
          LIMIT 1
        `,
      );
      return rows[0]?.tax_entity_id ?? null;
    }
    case 'purchase_return': {
      const rows = await safeQuery<{ tax_entity_id: string | null }>(
        db,
        sql`
          SELECT coalesce(oc.tax_entity_id, pc.tax_entity_id, s.tax_entity_id) AS tax_entity_id
          FROM pur_return r
          JOIN pur_order o ON o.id = r.order_id
          LEFT JOIN erp_contract oc ON oc.id = o.contract_id
          LEFT JOIN erp_project p ON p.id = coalesce(r.project_id, o.project_id)
          LEFT JOIN erp_contract pc ON pc.id = p.contract_id
          LEFT JOIN md_supplier s ON s.id = coalesce(r.supplier_id, o.supplier_id)
          WHERE r.code = ${code}
            AND coalesce(oc.tax_entity_id, pc.tax_entity_id, s.tax_entity_id) IS NOT NULL
          LIMIT 1
        `,
      );
      return rows[0]?.tax_entity_id ?? null;
    }
    case 'sales_return': {
      const rows = await safeQuery<{ tax_entity_id: string | null }>(
        db,
        sql`
          SELECT coalesce(c.tax_entity_id, rc.tax_entity_id) AS tax_entity_id
          FROM sales_return s
          LEFT JOIN erp_contract c ON c.id = s.contract_id
          LEFT JOIN erp_project_revenue rev ON rev.id = s.revenue_id
          LEFT JOIN erp_contract rc ON rc.id = rev.contract_id
          WHERE s.code = ${code}
            AND coalesce(c.tax_entity_id, rc.tax_entity_id) IS NOT NULL
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
 *   · **必须失败**：其余任何错误（连接断开、权限、超时、语法）——
 *     记日志并抛出 `TaxEntityLookupError`。不能当成“查不到”再落到默认主体，
 *     否则一次数据库抖动会把成本、收入、发票凭证记到错误的主体上。
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
    const code = extractPgCode(error) ?? 'unknown';
    const message =
      `纳税主体查询失败（code=${code}）。本次不使用默认主体填缺口，凭证进入补偿队列。` +
      `这不是"确实没有匹配合同"，请检查数据库连通性与权限。`;
    resolverLogger.error(
      message,
      error instanceof Error ? error.stack : String(error),
    );
    throw new TaxEntityLookupError(message);
  }
}


