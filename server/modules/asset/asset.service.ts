import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import {
  astAsset,
  astChange,
  erpProject,
  hrDepartment,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import type {
  AssetChangeAction,
  AssetChangeItem,
  AssetChangeType,
  AssetItem,
  AssetOverview,
  AssetStatus,
  CreateAssetChangeDto,
  CreateAssetDto,
  PagedResult,
} from '@shared/api.interface';

const ASSET_STATUSES: readonly AssetStatus[] = [
  'in_use',
  'idle',
  'repair',
  'scrapped',
];

const ASSET_STATUS_LABELS: Record<string, string> = {
  in_use: '在用',
  idle: '闲置',
  repair: '维修',
  scrapped: '已报废',
};

export interface AssetListParams {
  page?: number;
  pageSize?: number;
  status?: string;
  category?: string;
  projectId?: string;
}

export interface AssetChangeListParams {
  page?: number;
  pageSize?: number;
  status?: string;
}

interface AssetRow {
  id: string;
  code: string;
  name: string;
  category: string | null;
  originalValue: string | null;
  residualValue: string | null;
  netValue: string | null;
  departmentId: string | null;
  departmentName: string | null;
  projectId: string | null;
  projectName: string | null;
  purchaseDate: string | null;
  usefulMonths: number | null;
  status: string | null;
  remark: string | null;
  createdAt: Date;
}

interface AssetChangeRow {
  id: string;
  code: string;
  assetId: string | null;
  assetCode: string | null;
  assetName: string | null;
  changeType: string | null;
  beforeValue: string | null;
  afterValue: string | null;
  /** D-08：转交目标（结构化），审批通过时写回资产 */
  targetDepartmentId: string | null;
  targetDepartmentName: string | null;
  targetProjectId: string | null;
  targetProjectName: string | null;
  status: string | null;
  remark: string | null;
  createdAt: Date;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

@Injectable()
export class AssetService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  private toAssetItem(row: AssetRow): AssetItem {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      category: (row.category ?? 'other') as AssetItem['category'],
      originalValue: Number(row.originalValue ?? 0),
      residualValue: Number(row.residualValue ?? 0),
      netValue: Number(row.netValue ?? 0),
      departmentId: row.departmentId,
      departmentName: row.departmentName,
      projectId: row.projectId,
      projectName: row.projectName,
      purchaseDate: row.purchaseDate,
      usefulMonths: row.usefulMonths ?? 36,
      status: (row.status ?? 'in_use') as AssetStatus,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toAssetChangeItem(row: AssetChangeRow): AssetChangeItem {
    return {
      id: row.id,
      code: row.code,
      assetId: row.assetId ?? '',
      assetCode: row.assetCode ?? '',
      assetName: row.assetName ?? '',
      changeType: (row.changeType ?? 'receive') as AssetChangeType,
      beforeValue: row.beforeValue,
      afterValue: row.afterValue,
      targetDepartmentId: row.targetDepartmentId,
      targetDepartmentName: row.targetDepartmentName,
      targetProjectId: row.targetProjectId,
      targetProjectName: row.targetProjectName,
      status: (row.status ?? 'pending') as AssetChangeItem['status'],
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private assetSelection() {
    return {
      id: astAsset.id,
      code: astAsset.code,
      name: astAsset.name,
      category: astAsset.category,
      originalValue: astAsset.originalValue,
      residualValue: astAsset.residualValue,
      netValue: astAsset.netValue,
      departmentId: astAsset.departmentId,
      departmentName: hrDepartment.name,
      projectId: astAsset.projectId,
      projectName: erpProject.name,
      purchaseDate: astAsset.purchaseDate,
      usefulMonths: astAsset.usefulMonths,
      status: astAsset.status,
      remark: astAsset.remark,
      createdAt: astAsset.createdAt,
    };
  }

  /* ========== 资产 ========== */

  async listAssets(params: AssetListParams): Promise<PagedResult<AssetItem>> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, params.pageSize ?? 20));
    if (params.status && !ASSET_STATUSES.includes(params.status as AssetStatus)) {
      throw new BadRequestException('非法的资产状态筛选');
    }
    const conditions = [];
    if (params.status) conditions.push(eq(astAsset.status, params.status));
    if (params.category) conditions.push(eq(astAsset.category, params.category));
    if (params.projectId) {
      conditions.push(eq(astAsset.projectId, params.projectId));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const totalRows: Array<{ total: number }> = await this.db
      .select({ total: count() })
      .from(astAsset)
      .where(where);
    const rows: AssetRow[] = await this.db
      .select(this.assetSelection())
      .from(astAsset)
      .leftJoin(hrDepartment, eq(astAsset.departmentId, hrDepartment.id))
      .leftJoin(erpProject, eq(astAsset.projectId, erpProject.id))
      .where(where)
      .orderBy(desc(astAsset.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      items: rows.map((row: AssetRow) => this.toAssetItem(row)),
      total: Number(totalRows[0]?.total ?? 0),
      page,
      pageSize,
    };
  }

  async createAsset(dto: CreateAssetDto): Promise<AssetItem> {
    const originalValue = round2(dto.originalValue);
    const residualValue = round2(dto.residualValue ?? 0);
    const usefulMonths = dto.usefulMonths ?? 36;
    if (originalValue <= 0) {
      throw new BadRequestException('资产原值必须大于 0');
    }
    if (residualValue < 0) {
      throw new BadRequestException('残值不能为负');
    }
    if (residualValue > originalValue) {
      throw new BadRequestException('残值不能大于原值');
    }
    if (usefulMonths < 1) {
      throw new BadRequestException('折旧月数至少为 1');
    }
    const code = await generateBizCode(
      this.db,
      astAsset,
      astAsset.code,
      'AST'
    );
    const inserted = await this.db
      .insert(astAsset)
      .values({
        code,
        name: dto.name,
        category: dto.category,
        originalValue: originalValue.toFixed(2),
        residualValue: residualValue.toFixed(2),
        netValue: round2(originalValue - residualValue).toFixed(2),
        departmentId: dto.departmentId ?? null,
        projectId: dto.projectId ?? null,
        purchaseDate: dto.purchaseDate ?? null,
        usefulMonths,
        status: 'in_use',
        remark: dto.remark ?? null,
      })
      .returning({ id: astAsset.id });
    if (inserted.length === 0) {
      throw new NotFoundException('资产创建失败');
    }
    return this.getAssetById(inserted[0].id);
  }

  private async getAssetById(id: string): Promise<AssetItem> {
    const rows: AssetRow[] = await this.db
      .select(this.assetSelection())
      .from(astAsset)
      .leftJoin(hrDepartment, eq(astAsset.departmentId, hrDepartment.id))
      .leftJoin(erpProject, eq(astAsset.projectId, erpProject.id))
      .where(eq(astAsset.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('资产不存在');
    return this.toAssetItem(rows[0]);
  }

  async getOverview(): Promise<AssetOverview> {
    const rows: Array<{
      totalOriginalValue: number;
      totalNetValue: number;
      inUseCount: number;
      scrappedCount: number;
      gpuCount: number;
    }> = await this.db
      .select({
        totalOriginalValue: sql<number>`coalesce(sum(${astAsset.originalValue}), 0)::float8`,
        totalNetValue: sql<number>`coalesce(sum(${astAsset.netValue}), 0)::float8`,
        inUseCount: sql<number>`(count(*) filter (where ${astAsset.status} = 'in_use'))::int`,
        scrappedCount: sql<number>`(count(*) filter (where ${astAsset.status} = 'scrapped'))::int`,
        gpuCount: sql<number>`(count(*) filter (where ${astAsset.category} = 'server_gpu'))::int`,
      })
      .from(astAsset);
    const row = rows[0];
    return {
      totalOriginalValue: Number(row?.totalOriginalValue ?? 0),
      totalNetValue: Number(row?.totalNetValue ?? 0),
      inUseCount: Number(row?.inUseCount ?? 0),
      scrappedCount: Number(row?.scrappedCount ?? 0),
      gpuCount: Number(row?.gpuCount ?? 0),
    };
  }

  /* ========== 资产变更 ========== */

  async listChanges(
    params: AssetChangeListParams
  ): Promise<PagedResult<AssetChangeItem>> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, params.pageSize ?? 20));
    const conditions = [];
    if (params.status) conditions.push(eq(astChange.status, params.status));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const totalRows: Array<{ total: number }> = await this.db
      .select({ total: count() })
      .from(astChange)
      .where(where);
    const rows: AssetChangeRow[] = await this.db
      .select({
        id: astChange.id,
        code: astChange.code,
        assetId: astChange.assetId,
        assetCode: astAsset.code,
        assetName: astAsset.name,
        changeType: astChange.changeType,
        beforeValue: astChange.beforeValue,
        afterValue: astChange.afterValue,
        targetDepartmentId: astChange.targetDepartmentId,
        targetDepartmentName: hrDepartment.name,
        targetProjectId: astChange.targetProjectId,
        targetProjectName: erpProject.name,
        status: astChange.status,
        remark: astChange.remark,
        createdAt: astChange.createdAt,
      })
      .from(astChange)
      .leftJoin(astAsset, eq(astChange.assetId, astAsset.id))
      .leftJoin(hrDepartment, eq(astChange.targetDepartmentId, hrDepartment.id))
      .leftJoin(erpProject, eq(astChange.targetProjectId, erpProject.id))
      .where(where)
      .orderBy(desc(astChange.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      items: rows.map((row: AssetChangeRow) => this.toAssetChangeItem(row)),
      total: Number(totalRows[0]?.total ?? 0),
      page,
      pageSize,
    };
  }

  async createChange(dto: CreateAssetChangeDto): Promise<AssetChangeItem> {
    const asset = await this.getAssetById(dto.assetId);
    const status = asset.status;
    if (dto.changeType === 'receive' && status !== 'idle') {
      throw new BadRequestException('仅闲置状态资产可发起领用');
    }
    if (dto.changeType === 'scrap' && status === 'scrapped') {
      throw new BadRequestException('资产已报废，不能再发起变更');
    }
    // D-08：转交必须有**结构化目标**，否则审批通过后不会发生任何归属变更
    // —— 转交单会"看起来成功但实际什么都没发生"，属最危险的一类缺陷。
    if (dto.changeType === 'transfer') {
      if (!dto.targetDepartmentId && !dto.targetProjectId) {
        throw new BadRequestException(
          '转交必须指定目标部门或目标项目（至少一个），否则审批通过后归属不会变化'
        );
      }
      // 目标不存在时提前拒绝，避免把无效 uuid 存进变更单、
      // 到审批时才因外键失败（那时单据已进入流程，处理成本更高）
      if (dto.targetDepartmentId) {
        const dept = await this.db
          .select({ id: hrDepartment.id })
          .from(hrDepartment)
          .where(eq(hrDepartment.id, dto.targetDepartmentId))
          .limit(1);
        if (dept.length === 0) {
          throw new BadRequestException('目标部门不存在');
        }
      }
      if (dto.targetProjectId) {
        const project = await this.db
          .select({ id: erpProject.id })
          .from(erpProject)
          .where(eq(erpProject.id, dto.targetProjectId))
          .limit(1);
        if (project.length === 0) {
          throw new BadRequestException('目标项目不存在');
        }
      }
    }
    const beforeValue = [
      `状态:${ASSET_STATUS_LABELS[status] ?? status}`,
      `部门:${asset.departmentName ?? '未分配'}`,
      `项目:${asset.projectName ?? '无'}`,
    ].join('；');
    let afterValue: string | null = dto.afterValue ?? null;
    if (!afterValue) {
      if (dto.changeType === 'receive') afterValue = '状态:在用';
      if (dto.changeType === 'scrap') afterValue = '状态:已报废，终止折旧';
      if (dto.changeType === 'transfer') {
        // 自动生成可读快照；真实生效靠下面的结构化字段
        const parts: string[] = [];
        if (dto.targetDepartmentId) {
          const name = await this.departmentNameOf(dto.targetDepartmentId);
          parts.push(`部门:${name ?? dto.targetDepartmentId}`);
        }
        if (dto.targetProjectId) {
          const name = await this.projectNameOf(dto.targetProjectId);
          parts.push(`项目:${name ?? dto.targetProjectId}`);
        }
        afterValue = parts.join('；') || null;
      }
    }
    const code = await generateBizCode(
      this.db,
      astChange,
      astChange.code,
      'AST'
    );
    const inserted = await this.db
      .insert(astChange)
      .values({
        code,
        assetId: asset.id,
        changeType: dto.changeType,
        beforeValue,
        afterValue,
        targetDepartmentId: dto.targetDepartmentId ?? null,
        targetProjectId: dto.targetProjectId ?? null,
        status: 'pending',
        remark: dto.remark ?? null,
      })
      .returning({ id: astChange.id });
    if (inserted.length === 0) {
      throw new NotFoundException('变更单创建失败');
    }
    return this.getChangeById(inserted[0].id);
  }

  async changeAction(
    id: string,
    action: AssetChangeAction
  ): Promise<AssetChangeItem> {
    const changes = await this.db
      .select()
      .from(astChange)
      .where(eq(astChange.id, id))
      .limit(1);
    if (changes.length === 0) throw new NotFoundException('变更单不存在');
    const change = changes[0];
    if ((change.status ?? 'pending') !== 'pending') {
      throw new BadRequestException('变更单已处理，不能重复审批');
    }
    const assets = await this.db
      .select({ id: astAsset.id, status: astAsset.status })
      .from(astAsset)
      .where(eq(astAsset.id, change.assetId ?? ''))
      .limit(1);
    if (assets.length === 0) throw new NotFoundException('资产不存在');

    await this.db.transaction(async (tx) => {
      const updated = await tx
        .update(astChange)
        .set({
          status: action === 'approve' ? 'approved' : 'rejected',
          updatedAt: new Date(),
        })
        .where(eq(astChange.id, id))
        .returning({ id: astChange.id });
      if (updated.length === 0) throw new NotFoundException('变更单不存在');

      if (action === 'approve' && change.changeType === 'receive') {
        const applied = await tx
          .update(astAsset)
          .set({ status: 'in_use', updatedAt: new Date() })
          .where(eq(astAsset.id, change.assetId ?? ''))
          .returning({ id: astAsset.id });
        if (applied.length === 0) throw new NotFoundException('资产不存在');
      }
      if (action === 'approve' && change.changeType === 'scrap') {
        const applied = await tx
          .update(astAsset)
          .set({ status: 'scrapped', updatedAt: new Date() })
          .where(eq(astAsset.id, change.assetId ?? ''))
          .returning({ id: astAsset.id });
        if (applied.length === 0) throw new NotFoundException('资产不存在');
      }
      // D-08：**转交必须真正写回归属**。
      //
      // 这是需求书点名的缺陷（"ast_change 存在但 transfer 不落归属"）：
      // 原实现只处理 receive / scrap，transfer 审批通过后**什么都不发生**，
      // 资产仍挂在原部门 —— 折旧分摊与部门成本归集就此错位，
      // 而界面上单据显示"已批准"，缺陷表现为成功。
      //
      // 只写提供了的目标维度：允许"只转部门"或"只转项目"
      // （例如人跟着项目走但部门不变）；两者都为空的情况在创建时已被拒绝。
      if (action === 'approve' && change.changeType === 'transfer') {
        const patch: Record<string, unknown> = { updatedAt: new Date() };
        if (change.targetDepartmentId) {
          patch.departmentId = change.targetDepartmentId;
        }
        if (change.targetProjectId) {
          patch.projectId = change.targetProjectId;
        }
        if (Object.keys(patch).length > 1) {
          const applied = await tx
            .update(astAsset)
            .set(patch)
            .where(eq(astAsset.id, change.assetId ?? ''))
            .returning({ id: astAsset.id });
          if (applied.length === 0) throw new NotFoundException('资产不存在');
        }
      }
    });
    return this.getChangeById(id);
  }

  private async getChangeById(id: string): Promise<AssetChangeItem> {
    const rows: AssetChangeRow[] = await this.db
      .select({
        id: astChange.id,
        code: astChange.code,
        assetId: astChange.assetId,
        assetCode: astAsset.code,
        assetName: astAsset.name,
        changeType: astChange.changeType,
        beforeValue: astChange.beforeValue,
        afterValue: astChange.afterValue,
        targetDepartmentId: astChange.targetDepartmentId,
        targetDepartmentName: hrDepartment.name,
        targetProjectId: astChange.targetProjectId,
        targetProjectName: erpProject.name,
        status: astChange.status,
        remark: astChange.remark,
        createdAt: astChange.createdAt,
      })
      .from(astChange)
      .leftJoin(astAsset, eq(astChange.assetId, astAsset.id))
      .leftJoin(hrDepartment, eq(astChange.targetDepartmentId, hrDepartment.id))
      .leftJoin(erpProject, eq(astChange.targetProjectId, erpProject.id))
      .where(eq(astChange.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('变更单不存在');
    return this.toAssetChangeItem(rows[0]);
  }

  /** D-08：按 id 取部门名（仅用于生成变更单的可读 `after_value` 快照） */
  private async departmentNameOf(id: string): Promise<string | null> {
    const rows = await this.db
      .select({ name: hrDepartment.name })
      .from(hrDepartment)
      .where(eq(hrDepartment.id, id))
      .limit(1);
    return rows[0]?.name ?? null;
  }

  /** D-08：按 id 取项目名（同上，仅用于可读快照） */
  private async projectNameOf(id: string): Promise<string | null> {
    const rows = await this.db
      .select({ name: erpProject.name })
      .from(erpProject)
      .where(eq(erpProject.id, id))
      .limit(1);
    return rows[0]?.name ?? null;
  }
}
