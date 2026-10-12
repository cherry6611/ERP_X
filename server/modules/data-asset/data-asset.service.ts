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
import { and, asc, count, desc, eq, lte } from 'drizzle-orm';
import {
  daDataset,
  daGrant,
  erpContract,
  erpProject,
  mdCustomer,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import type {
  CreateDatasetDto,
  CreateGrantDto,
  DatasetAction,
  DatasetItem,
  DatasetStatus,
  GrantItem,
  GrantStatus,
  GrantWarningItem,
  PagedResult,
  UpdateDatasetDto,
} from '@shared/api.interface';

const DAY_MS = 24 * 60 * 60 * 1000;
const WARN_WINDOW_DAYS = 30;

/** 数据集状态机：active → offline → active 可逆流转 */
const DATASET_STATUS_TRANSITIONS: Record<string, readonly string[]> = {
  active: ['offline'],
  offline: ['active'],
};

function formatLocalDate(date: Date): string {
  const y: number = date.getFullYear();
  const m: string = String(date.getMonth() + 1).padStart(2, '0');
  const d: string = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getToday(): string {
  return formatLocalDate(new Date());
}

function getTodayPlusDays(days: number): string {
  return formatLocalDate(new Date(Date.now() + days * DAY_MS));
}

interface DatasetRow {
  id: string;
  code: string;
  name: string;
  source: string | null;
  maskLevel: string | null;
  contractId: string | null;
  contractName: string | null;
  status: string | null;
  remark: string | null;
  createdAt: Date;
}

interface GrantRow {
  id: string;
  code: string;
  datasetId: string | null;
  datasetName: string | null;
  customerId: string | null;
  customerName: string | null;
  projectId: string | null;
  projectName: string | null;
  scope: string | null;
  startDate: string | null;
  endDate: string | null;
  status: string | null;
  remark: string | null;
  createdAt: Date;
}

@Injectable()
export class DataAssetService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  private toDataset(row: DatasetRow): DatasetItem {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      source: row.source,
      maskLevel: row.maskLevel ?? 'L1',
      contractId: row.contractId,
      contractName: row.contractName,
      status: (row.status ?? 'active') as DatasetStatus,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private toGrant(row: GrantRow): GrantItem {
    return {
      id: row.id,
      code: row.code,
      datasetId: row.datasetId ?? '',
      datasetName: row.datasetName ?? '',
      customerId: row.customerId,
      customerName: row.customerName,
      projectId: row.projectId,
      projectName: row.projectName,
      scope: row.scope,
      startDate: row.startDate,
      endDate: row.endDate,
      status: (row.status ?? 'active') as GrantStatus,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /* ========== 数据集目录 ========== */

  async listDatasets(
    status?: string,
    page = 1,
    pageSize = 20
  ): Promise<PagedResult<DatasetItem>> {
    const where = status ? eq(daDataset.status, status) : undefined;
    const rows: DatasetRow[] = await this.db
      .select({
        id: daDataset.id,
        code: daDataset.code,
        name: daDataset.name,
        source: daDataset.source,
        maskLevel: daDataset.maskLevel,
        contractId: daDataset.contractId,
        contractName: erpContract.name,
        status: daDataset.status,
        remark: daDataset.remark,
        createdAt: daDataset.createdAt,
      })
      .from(daDataset)
      .leftJoin(erpContract, eq(daDataset.contractId, erpContract.id))
      .where(where)
      .orderBy(desc(daDataset.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const totalRows: Array<{ total: number }> = await this.db
      .select({ total: count() })
      .from(daDataset)
      .where(where);
    return {
      items: rows.map((row: DatasetRow) => this.toDataset(row)),
      total: totalRows[0]?.total ?? 0,
      page,
      pageSize,
    };
  }

  async createDataset(dto: CreateDatasetDto): Promise<DatasetItem> {
    if (dto.contractId) {
      await this.ensureContractExists(dto.contractId);
    }
    const code = await generateBizCode(
      this.db,
      daDataset,
      daDataset.code,
      'DS'
    );
    const inserted = await this.db
      .insert(daDataset)
      .values({
        code,
        name: dto.name,
        source: dto.source,
        maskLevel: dto.maskLevel ?? 'L1',
        contractId: dto.contractId,
        status: 'active',
        remark: dto.remark,
      })
      .returning({ id: daDataset.id });
    return this.getDatasetById(inserted[0].id);
  }

  async updateDataset(
    id: string,
    dto: UpdateDatasetDto
  ): Promise<DatasetItem> {
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.source !== undefined) patch.source = dto.source;
    if (dto.maskLevel !== undefined) patch.maskLevel = dto.maskLevel;
    if (dto.status !== undefined) patch.status = dto.status;
    if (dto.remark !== undefined) patch.remark = dto.remark;
    const rows = await this.db
      .update(daDataset)
      .set(patch)
      .where(eq(daDataset.id, id))
      .returning({ id: daDataset.id });
    if (rows.length === 0) throw new NotFoundException('数据集不存在');
    return this.getDatasetById(id);
  }

  async datasetAction(id: string, action: DatasetAction): Promise<DatasetItem> {
    if (action !== 'offline' && action !== 'activate') {
      throw new BadRequestException('非法的状态操作');
    }
    const existing = await this.db
      .select({ id: daDataset.id, status: daDataset.status })
      .from(daDataset)
      .where(eq(daDataset.id, id));
    if (existing.length === 0) throw new NotFoundException('数据集不存在');
    const current = existing[0].status ?? 'active';
    if (!DATASET_STATUS_TRANSITIONS[current]?.includes(action)) {
      throw new BadRequestException(
        `数据集状态 ${current} 不允许执行 ${action}`
      );
    }
    const nextStatus = action === 'offline' ? 'offline' : 'active';
    const rows = await this.db
      .update(daDataset)
      .set({ status: nextStatus, updatedAt: new Date() })
      .where(eq(daDataset.id, id))
      .returning({ id: daDataset.id });
    if (rows.length === 0) throw new NotFoundException('数据集不存在');
    return this.getDatasetById(id);
  }

  private async ensureContractExists(contractId: string): Promise<void> {
    const contracts = await this.db
      .select({ id: erpContract.id })
      .from(erpContract)
      .where(eq(erpContract.id, contractId));
    if (contracts.length === 0) throw new NotFoundException('关联合同不存在');
  }

  private async getDatasetById(id: string): Promise<DatasetItem> {
    const rows: DatasetRow[] = await this.db
      .select({
        id: daDataset.id,
        code: daDataset.code,
        name: daDataset.name,
        source: daDataset.source,
        maskLevel: daDataset.maskLevel,
        contractId: daDataset.contractId,
        contractName: erpContract.name,
        status: daDataset.status,
        remark: daDataset.remark,
        createdAt: daDataset.createdAt,
      })
      .from(daDataset)
      .leftJoin(erpContract, eq(daDataset.contractId, erpContract.id))
      .where(eq(daDataset.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('数据集不存在');
    return this.toDataset(rows[0]);
  }

  /* ========== 授权记录 ========== */

  async listGrants(
    datasetId?: string,
    status?: string,
    page = 1,
    pageSize = 20
  ): Promise<PagedResult<GrantItem>> {
    const conditions = [];
    if (datasetId) conditions.push(eq(daGrant.datasetId, datasetId));
    if (status) conditions.push(eq(daGrant.status, status));
    const where =
      conditions.length > 0 ? and(...conditions) : undefined;
    const rows: GrantRow[] = await this.db
      .select({
        id: daGrant.id,
        code: daGrant.code,
        datasetId: daGrant.datasetId,
        datasetName: daDataset.name,
        customerId: daGrant.customerId,
        customerName: mdCustomer.name,
        projectId: daGrant.projectId,
        projectName: erpProject.name,
        scope: daGrant.scope,
        startDate: daGrant.startDate,
        endDate: daGrant.endDate,
        status: daGrant.status,
        remark: daGrant.remark,
        createdAt: daGrant.createdAt,
      })
      .from(daGrant)
      .leftJoin(daDataset, eq(daGrant.datasetId, daDataset.id))
      .leftJoin(mdCustomer, eq(daGrant.customerId, mdCustomer.id))
      .leftJoin(erpProject, eq(daGrant.projectId, erpProject.id))
      .where(where)
      .orderBy(desc(daGrant.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    const totalRows: Array<{ total: number }> = await this.db
      .select({ total: count() })
      .from(daGrant)
      .where(where);
    return {
      items: rows.map((row: GrantRow) => this.toGrant(row)),
      total: totalRows[0]?.total ?? 0,
      page,
      pageSize,
    };
  }

  async createGrant(dto: CreateGrantDto): Promise<GrantItem> {
    const datasets = await this.db
      .select({ id: daDataset.id, status: daDataset.status })
      .from(daDataset)
      .where(eq(daDataset.id, dto.datasetId));
    if (datasets.length === 0) {
      throw new NotFoundException('数据集不存在');
    }
    if ((datasets[0].status ?? 'active') !== 'active') {
      throw new BadRequestException('数据集已下线，不允许新增授权');
    }
    if (dto.endDate < dto.startDate) {
      throw new BadRequestException('授权结束日期不能早于开始日期');
    }
    const code = await generateBizCode(this.db, daGrant, daGrant.code, 'DS');
    const inserted = await this.db
      .insert(daGrant)
      .values({
        code,
        datasetId: dto.datasetId,
        customerId: dto.customerId,
        projectId: dto.projectId,
        scope: dto.scope,
        startDate: dto.startDate,
        endDate: dto.endDate,
        status: 'active',
        remark: dto.remark,
      })
      .returning({ id: daGrant.id });
    return this.getGrantById(inserted[0].id);
  }

  async expireGrant(id: string): Promise<GrantItem> {
    const existing = await this.db
      .select({ id: daGrant.id, status: daGrant.status })
      .from(daGrant)
      .where(eq(daGrant.id, id));
    if (existing.length === 0) throw new NotFoundException('授权记录不存在');
    if ((existing[0].status ?? 'active') !== 'active') {
      throw new BadRequestException('授权已失效，不允许重复操作');
    }
    const rows = await this.db
      .update(daGrant)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(eq(daGrant.id, id))
      .returning({ id: daGrant.id });
    if (rows.length === 0) throw new NotFoundException('授权记录不存在');
    return this.getGrantById(id);
  }

  private async getGrantById(id: string): Promise<GrantItem> {
    const rows: GrantRow[] = await this.db
      .select({
        id: daGrant.id,
        code: daGrant.code,
        datasetId: daGrant.datasetId,
        datasetName: daDataset.name,
        customerId: daGrant.customerId,
        customerName: mdCustomer.name,
        projectId: daGrant.projectId,
        projectName: erpProject.name,
        scope: daGrant.scope,
        startDate: daGrant.startDate,
        endDate: daGrant.endDate,
        status: daGrant.status,
        remark: daGrant.remark,
        createdAt: daGrant.createdAt,
      })
      .from(daGrant)
      .leftJoin(daDataset, eq(daGrant.datasetId, daDataset.id))
      .leftJoin(mdCustomer, eq(daGrant.customerId, mdCustomer.id))
      .leftJoin(erpProject, eq(daGrant.projectId, erpProject.id))
      .where(eq(daGrant.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('授权记录不存在');
    return this.toGrant(rows[0]);
  }

  /* ========== 到期预警 ========== */

  async listGrantWarnings(): Promise<GrantWarningItem[]> {
    const today = getToday();
    const limitDate = getTodayPlusDays(WARN_WINDOW_DAYS);
    const rows = await this.db
      .select({
        grantId: daGrant.id,
        grantCode: daGrant.code,
        datasetName: daDataset.name,
        customerName: mdCustomer.name,
        endDate: daGrant.endDate,
      })
      .from(daGrant)
      .leftJoin(daDataset, eq(daGrant.datasetId, daDataset.id))
      .leftJoin(mdCustomer, eq(daGrant.customerId, mdCustomer.id))
      .where(and(eq(daGrant.status, 'active'), lte(daGrant.endDate, limitDate)))
      .orderBy(asc(daGrant.endDate));
    return rows.map(
      (row: {
        grantId: string;
        grantCode: string;
        datasetName: string | null;
        customerName: string | null;
        endDate: string | null;
      }): GrantWarningItem => ({
        grantId: row.grantId,
        grantCode: row.grantCode,
        datasetName: row.datasetName ?? '',
        customerName: row.customerName,
        endDate: row.endDate ?? '',
        daysLeft: Math.round(
          (Date.parse(row.endDate ?? today) - Date.parse(today)) / DAY_MS
        ),
      })
    );
  }

  /* ========== 项目立项前校验（供 approve 流程语义说明） ========== */

  /**
   * 立项校验逻辑见 ProjectsService.changeStatus（action=approve），
   * 项目引用合同下存在数据集时，逐个校验是否存在有效授权。
   */
}
