import { BadRequestException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from '@server/platform';
import { listActiveTaxEntityIds } from './tax-entity-resolver';

/**
 * 单据写入时的我方主体校验（R2）。
 * 多主体 = status=active 的纳税主体多于 1 个。
 */
export async function resolveDocumentTaxEntity(
  db: PostgresJsDatabase,
  input: {
    projectId?: string | null;
    taxEntityId?: string | null;
    /** asset：合同无主体时允许用资产自身主体。expense：有项目时必须用合同主体。 */
    kind: 'asset' | 'expense';
  },
): Promise<string | null> {
  const active = await listActiveTaxEntityIds(db);
  const multi = active.length > 1;
  const sole = active.length === 1 ? active[0] : null;
  const contractEntity = input.projectId
    ? await projectContractTaxEntity(db, input.projectId)
    : null;
  const own = input.taxEntityId?.trim() || null;

  if (input.kind === 'expense') {
    if (own) return own;
    if (contractEntity) return contractEntity;
    if (!multi) return sole;
    throw new BadRequestException(
      input.projectId
        ? '请选择我方纳税主体'
        : '多主体下无项目时必须选择我方纳税主体',
    );
  }

  if (input.kind === 'asset' && contractEntity) {
    return contractEntity;
  }

  if (own) return own;
  if (!multi) return sole;
  throw new BadRequestException(
    input.projectId
      ? '项目合同没有纳税主体，请在单据上选择我方纳税主体'
      : '多主体下无项目时必须选择我方纳税主体',
  );
}

async function projectContractTaxEntity(
  db: PostgresJsDatabase,
  projectId: string,
): Promise<string | null> {
  const rows = await db.execute(sql`
    SELECT c.tax_entity_id AS tax_entity_id
    FROM erp_project p
    LEFT JOIN erp_contract c ON c.id = p.contract_id
    WHERE p.id = ${projectId}
    LIMIT 1
  `);
  const list = Array.isArray(rows)
    ? (rows as unknown as { tax_entity_id: string | null }[])
    : ((rows as { rows?: { tax_entity_id: string | null }[] }).rows ?? []);
  return list[0]?.tax_entity_id ?? null;
}
