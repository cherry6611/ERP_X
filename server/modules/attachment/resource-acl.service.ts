import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { sql } from 'drizzle-orm';
import { ATTACHMENT_RESOURCE_TYPES } from '@shared/api.interface';
import type { AttachmentResourceType } from '@shared/api.interface';
import { ActorAccessService } from '@server/common/auth/actor-access.service';
import type { RequestActor } from '@server/common/auth/actor';
import {
  applyTaxEntityScope,
  DataScopeService,
  type DataScopeResource,
} from '@server/common/auth/data-scope.service';
import { isAllowedFeishuUrl } from '@server/common/security/feishu-url';
import { ProjectAclService } from '@server/modules/projects/project-acl.service';

/** resourceType → 物理表。值全部来自常量，不接受请求拼表名。 */
const RESOURCE_TABLE: Record<AttachmentResourceType, string> = {
  fin_expense_claim: 'fin_expense_claim',
  erp_contract: 'erp_contract',
  pur_request: 'pur_request',
  hr_leave_request: 'hr_leave_request',
  fin_voucher: 'fin_voucher',
  fin_expense_apply: 'fin_expense_apply',
  pur_order: 'pur_order',
  ast_asset: 'ast_asset',
  da_dataset: 'da_dataset',
  da_grant: 'da_grant',
  erp_project: 'erp_project',
  crm_lead: 'crm_lead',
  crm_opportunity: 'crm_opportunity',
  admin_rent_contract: 'erp_admin_rent_contract',
  admin_bill: 'erp_admin_bill',
  erp_invoice: 'erp_invoice',
  crm_quotation: 'crm_quotation',
  hr_payroll: 'hr_payroll',
  erp_project_cost: 'erp_project_cost',
  erp_deliverable: 'erp_deliverable',
  erp_project_minutes: 'erp_project_minutes',
};

const PROJECT_LINKED = new Set<AttachmentResourceType>([
  'erp_project',
  'erp_project_cost',
  'erp_deliverable',
  'erp_project_minutes',
]);

const FINANCE_RESOURCES = new Set<AttachmentResourceType>([
  'fin_expense_claim',
  'fin_expense_apply',
  'fin_voucher',
  'erp_invoice',
  'erp_contract',
  'erp_project_cost',
]);

/** 财务只读不再无条件放行：这些单据按纳税主体配置收窄。未配置时仍全量。 */
const FINANCE_TAX_SCOPE: Partial<Record<AttachmentResourceType, DataScopeResource>> = {
  fin_voucher: 'voucher',
  erp_invoice: 'finance_ledger',
  erp_contract: 'contract',
  fin_expense_claim: 'finance_ledger',
  fin_expense_apply: 'finance_ledger',
};

const TAX_ENTITY_TABLES = new Set<AttachmentResourceType>([
  'fin_voucher',
  'erp_invoice',
  'erp_contract',
  'fin_expense_claim',
  'fin_expense_apply',
]);

const HR_RESOURCES = new Set<AttachmentResourceType>(['hr_leave_request', 'hr_payroll']);

const ADMIN_RESOURCES = new Set<AttachmentResourceType>([
  'admin_rent_contract',
  'admin_bill',
]);

@Injectable()
export class ResourceAclService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly actorAccess: ActorAccessService,
    private readonly projectAcl: ProjectAclService,
    private readonly dataScope: DataScopeService,
  ) {}

  async assertCanAccess(
    actor: RequestActor,
    resourceType: string,
    resourceId: string
  ): Promise<void> {
    if (!isResourceType(resourceType)) {
      throw new BadRequestException('不支持的附件类型');
    }
    const row = await this.loadResource(resourceType, resourceId);
    if (!row) throw new NotFoundException('关联单据不存在');

    if (await this.actorAccess.hasAnyRole(actor.userId, ['admin'])) return;
    if (row.ownerUserId && row.ownerUserId === actor.userId) return;

    if (
      PROJECT_LINKED.has(resourceType) &&
      row.projectId
    ) {
      await this.projectAcl.assertVisible(row.projectId, actor);
      return;
    }
    if (resourceType === 'erp_project') {
      await this.projectAcl.assertVisible(resourceId, actor);
      return;
    }
    if (
      FINANCE_RESOURCES.has(resourceType) &&
      (await this.actorAccess.hasAnyRole(actor.userId, ['finance_viewer']))
    ) {
      await this.assertFinanceScope(actor, resourceType, resourceId);
      return;
    }
    if (
      HR_RESOURCES.has(resourceType) &&
      (await this.actorAccess.hasAnyRole(actor.userId, ['hr_manager']))
    ) {
      return;
    }
    if (ADMIN_RESOURCES.has(resourceType)) {
      throw new ForbiddenException('无权访问该单据附件');
    }
    throw new ForbiddenException('无权访问该单据附件');
  }

  /**
   * 财务只读角色下载附件时跟随行级配置。
   * 范围是 all 或尚未配置时保持原来的全量放行；配成指定纳税主体后，单据主体不在名单里就拒绝。
   */
  private async assertFinanceScope(
    actor: RequestActor,
    resourceType: AttachmentResourceType,
    resourceId: string,
  ): Promise<void> {
    if (resourceType === 'erp_project_cost') {
      const resolved = await this.dataScope.resolveScope(actor.roles ?? [], 'cost');
      if (resolved.from !== 'default' && resolved.scope !== 'all') {
        throw new ForbiddenException('无权访问该单据附件');
      }
      return;
    }
    const resource = FINANCE_TAX_SCOPE[resourceType];
    if (!resource) return;
    const resolved = await this.dataScope.resolveScope(actor.roles ?? [], resource);
    if (
      resolved.from === 'default' ||
      resolved.from === 'bypass' ||
      resolved.scope === 'all'
    ) {
      return;
    }
    const filter = applyTaxEntityScope(resolved);
    if (filter.kind === 'unrestricted') return;
    if (filter.kind === 'denied') {
      throw new ForbiddenException('无权访问该单据附件');
    }
    const taxEntityId = await this.taxEntityOf(resourceType, resourceId);
    if (!taxEntityId || !filter.taxEntityIds.includes(taxEntityId)) {
      throw new ForbiddenException('无权访问该单据附件');
    }
  }

  private async taxEntityOf(
    resourceType: AttachmentResourceType,
    resourceId: string,
  ): Promise<string | null> {
    if (!TAX_ENTITY_TABLES.has(resourceType)) return null;
    const tableName = RESOURCE_TABLE[resourceType];
    const rows: unknown = await this.db.execute(
      sql`SELECT tax_entity_id::text AS tax_entity_id
          FROM ${sql.raw(`"${tableName}"`)}
          WHERE id = ${resourceId}
          LIMIT 1`,
    );
    const list = Array.isArray(rows)
      ? (rows as { tax_entity_id: string | null }[])
      : ((rows as { rows?: { tax_entity_id: string | null }[] }).rows ?? []);
    return list[0]?.tax_entity_id ?? null;
  }

  assertFileUrl(fileUrl: string): void {
    if (!isAllowedFeishuUrl(fileUrl)) {
      throw new BadRequestException('附件链接仅允许飞书域名（https）');
    }
  }

  private async loadResource(
    resourceType: AttachmentResourceType,
    resourceId: string
  ): Promise<{ ownerUserId: string | null; projectId: string | null } | null> {
    const tableName: string = RESOURCE_TABLE[resourceType];
    const projectExpr =
      resourceType === 'erp_project_cost' ||
      resourceType === 'erp_deliverable' ||
      resourceType === 'erp_project_minutes'
        ? sql`x.project_id::text`
        : sql`NULL::text`;
    const rows: unknown = await this.db.execute(
      sql`SELECT (x._created_by).user_id AS owner_user_id,
                 ${projectExpr} AS project_id
          FROM ${sql.raw(`"${tableName}"`)} x
          WHERE x.id = ${resourceId}
          LIMIT 1`
    );
    const list = Array.isArray(rows)
      ? (rows as { owner_user_id: string | null; project_id: string | null }[])
      : ((
          rows as {
            rows?: { owner_user_id: string | null; project_id: string | null }[];
          }
        ).rows ?? []);
    const first = list[0];
    if (!first) return null;
    return {
      ownerUserId: first.owner_user_id,
      projectId: first.project_id,
    };
  }
}

function isResourceType(value: string): value is AttachmentResourceType {
  return (ATTACHMENT_RESOURCE_TYPES as readonly string[]).includes(value);
}
