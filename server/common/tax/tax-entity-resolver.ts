import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from '@server/platform';
import { unwrapRows } from '@server/common/utils/rows';

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

/** 兜底查询：任何失败都降级为「查不到」，绝不向上抛（避免拖垮凭证生成） */
async function safeQuery<T>(
  db: PostgresJsDatabase,
  query: ReturnType<typeof sql>,
): Promise<T[]> {
  try {
    return unwrapRows<T>(await db.execute(query));
  } catch {
    return [];
  }
}
