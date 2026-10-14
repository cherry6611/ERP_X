import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, asc, count, desc, eq, lte } from 'drizzle-orm';
import {
  daDataset,
  daDatasetField,
  daGrant,
  daGrantRevokeLog,
  erpContract,
  erpProject,
  mdCustomer,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import {
  GRANT_REVOKE_REASON_LABELS,
  MASK_LEVELS,
  MASK_LEVEL_DESCRIPTIONS,
  MASK_LEVEL_LABELS,
  SENSITIVE_FIELD_KINDS,
  maskRows,
  normalizeMaskLevel,
  requiresDestructionProof,
  validateRevoke,
  type GrantRevokeReason,
  type MaskLevel,
  type SensitiveFieldKind,
} from './mask-policy';
import type {
  CreateDatasetDto,
  CreateGrantDto,
  DatasetAction,
  DatasetFieldItem,
  DatasetItem,
  DatasetStatus,
  GrantItem,
  GrantRevokeLogItem,
  GrantStatus,
  GrantWarningItem,
  PagedResult,
  RevokeGrantDto,
  RevokeGrantResult,
  UpdateDatasetDto,
  UpsertDatasetFieldDto,
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
  private readonly logger = new Logger(DataAssetService.name);

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

  /* ========== C-13 授权回收审计（双人确认 + 销毁凭证） ========== */

  /**
   * 带审计的授权回收。
   *
   * 与 `expireGrant` 的区别：`expireGrant` 是**到期自动失效**（系统行为，无需复核）；
   * 本方法用于**人工主动回收 / 合同终止 / 违规回收**，必须留痕并能回答
   * "谁回收的、谁复核的、有没有要求对方删副本"。
   *
   * L4 核心数据额外要求：复核人 ≠ 操作人 + 销毁凭证
   * （应用层校验 + 数据库 CHECK 约束双重兜底，防止绕过接口直连库）。
   */
  async revokeGrant(
    id: string,
    dto: RevokeGrantDto,
    operator: string
  ): Promise<{ grant: GrantItem; logId: string }> {
    const existing = await this.db
      .select({
        id: daGrant.id,
        code: daGrant.code,
        status: daGrant.status,
        datasetId: daGrant.datasetId,
        datasetName: daDataset.name,
        maskLevel: daDataset.maskLevel,
      })
      .from(daGrant)
      .leftJoin(daDataset, eq(daGrant.datasetId, daDataset.id))
      .where(eq(daGrant.id, id))
      .limit(1);
    if (existing.length === 0) throw new NotFoundException('授权记录不存在');
    const grant = existing[0];
    if ((grant.status ?? 'active') !== 'active') {
      throw new BadRequestException('授权已失效，不允许重复操作');
    }
    const maskLevel = normalizeMaskLevel(grant.maskLevel);

    const errors = validateRevoke({
      maskLevel,
      reason: dto.reason,
      operator,
      reviewedBy: dto.reviewedBy ?? null,
      destructionProof: dto.destructionProof ?? null,
    });
    if (errors.length > 0) {
      throw new BadRequestException(errors.join('；'));
    }

    const destroyRequired = requiresDestructionProof(maskLevel);
    await this.db
      .update(daGrant)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(eq(daGrant.id, id));
    const logged = await this.db
      .insert(daGrantRevokeLog)
      .values({
        grantId: grant.id,
        grantCode: grant.code,
        datasetId: grant.datasetId ?? '',
        datasetName: grant.datasetName,
        maskLevel,
        reason: dto.reason,
        operator,
        reviewedBy: dto.reviewedBy ?? null,
        destructionProof: dto.destructionProof ?? null,
        remark: dto.remark ?? null,
        destroyRequired: destroyRequired ? 1 : 0,
      })
      .returning({ id: daGrantRevokeLog.id });
    this.logger.warn(
      `授权回收 grant=${grant.code} level=${maskLevel} reason=${dto.reason} operator=${operator} reviewer=${dto.reviewedBy ?? '-'}`
    );
    return { grant: await this.getGrantById(id), logId: logged[0].id };
  }

  /** 授权回收审计记录 */
  async listRevokeLogs(params: {
    grantId?: string;
    datasetId?: string;
    page?: number;
    pageSize?: number;
  }): Promise<PagedResult<GrantRevokeLogItem>> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 200);
    const conditions = [];
    if (params.grantId) {
      conditions.push(eq(daGrantRevokeLog.grantId, params.grantId));
    }
    if (params.datasetId) {
      conditions.push(eq(daGrantRevokeLog.datasetId, params.datasetId));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const totalRows = await this.db
      .select({ total: count() })
      .from(daGrantRevokeLog)
      .where(where);
    const rows = await this.db
      .select()
      .from(daGrantRevokeLog)
      .where(where)
      .orderBy(desc(daGrantRevokeLog.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      items: rows.map((row) => ({
        id: row.id,
        grantId: row.grantId,
        grantCode: row.grantCode,
        datasetId: row.datasetId,
        datasetName: row.datasetName,
        maskLevel: row.maskLevel,
        reason: row.reason as GrantRevokeReason,
        reasonLabel:
          GRANT_REVOKE_REASON_LABELS[row.reason as GrantRevokeReason] ??
          row.reason,
        operator: row.operator,
        reviewedBy: row.reviewedBy,
        destructionProof: row.destructionProof,
        remark: row.remark,
        destroyRequired: Number(row.destroyRequired ?? 0) === 1,
        createdAt: row.createdAt.toISOString(),
      })),
      total: Number(totalRows[0]?.total ?? 0),
      page,
      pageSize,
    };
  }

  /* ========== C-13 脱敏字段登记与预览 ========== */

  async listDatasetFields(datasetId: string): Promise<DatasetFieldItem[]> {
    await this.ensureDatasetExists(datasetId);
    const rows = await this.db
      .select()
      .from(daDatasetField)
      .where(eq(daDatasetField.datasetId, datasetId))
      .orderBy(asc(daDatasetField.columnName));
    return rows.map((row) => this.toDatasetField(row));
  }

  /** 登记/更新脱敏字段（列名在数据集内唯一，重复则更新语义） */
  async upsertDatasetField(
    datasetId: string,
    dto: UpsertDatasetFieldDto
  ): Promise<DatasetFieldItem> {
    await this.ensureDatasetExists(datasetId);
    if (!SENSITIVE_FIELD_KINDS.includes(dto.fieldKind)) {
      throw new BadRequestException(
        `字段语义仅支持 ${SENSITIVE_FIELD_KINDS.join(' / ')}`
      );
    }
    const existing = await this.db
      .select({ id: daDatasetField.id })
      .from(daDatasetField)
      .where(
        and(
          eq(daDatasetField.datasetId, datasetId),
          eq(daDatasetField.columnName, dto.columnName)
        )
      )
      .limit(1);
    if (existing.length > 0) {
      await this.db
        .update(daDatasetField)
        .set({
          fieldKind: dto.fieldKind,
          fieldLabel: dto.fieldLabel ?? null,
          remark: dto.remark ?? null,
          updatedAt: new Date(),
        })
        .where(eq(daDatasetField.id, existing[0].id));
    } else {
      await this.db.insert(daDatasetField).values({
        datasetId,
        columnName: dto.columnName,
        fieldKind: dto.fieldKind,
        fieldLabel: dto.fieldLabel ?? null,
        remark: dto.remark ?? null,
      });
    }
    const list = await this.listDatasetFields(datasetId);
    return list.find((item) => item.columnName === dto.columnName) ?? list[0];
  }

  async deleteDatasetField(
    datasetId: string,
    columnName: string
  ): Promise<{ ok: true }> {
    const removed = await this.db
      .delete(daDatasetField)
      .where(
        and(
          eq(daDatasetField.datasetId, datasetId),
          eq(daDatasetField.columnName, columnName)
        )
      )
      .returning({ id: daDatasetField.id });
    if (removed.length === 0) throw new NotFoundException('字段登记不存在');
    return { ok: true };
  }

  /**
   * 脱敏预览：给出样例数据在该数据集等级下的脱敏结果。
   *
   * 存在的意义：让业务方在**导出前**就看到 L3/L4 会变成什么样，
   * 避免"导出后才发现关键列被抹掉或阻断"而返工。
   */
  async previewMasking(
    datasetId: string,
    sample: Record<string, unknown>
  ): Promise<{
    maskLevel: MaskLevel;
    maskLevelLabel: string;
    masked: Record<string, unknown>;
    blockedColumns: string[];
  }> {
    const dataset = await this.getDatasetById(datasetId);
    const fields = await this.listDatasetFields(datasetId);
    const fieldKinds: Record<string, SensitiveFieldKind> = {};
    for (const field of fields) {
      fieldKinds[field.columnName] = field.fieldKind;
    }
    const level = normalizeMaskLevel(dataset.maskLevel);
    const { rows, blockedColumns } = maskRows([sample], fieldKinds, level);
    return {
      maskLevel: level,
      maskLevelLabel: MASK_LEVEL_LABELS[level],
      masked: rows[0] ?? {},
      blockedColumns,
    };
  }

  /** 脱敏等级字典（前端下拉与审计报告用） */
  listMaskLevels(): Array<{
    level: MaskLevel;
    label: string;
    description: string;
    destroyProofRequired: boolean;
  }> {
    return MASK_LEVELS.map((level) => ({
      level,
      label: MASK_LEVEL_LABELS[level],
      description: MASK_LEVEL_DESCRIPTIONS[level],
      destroyProofRequired: requiresDestructionProof(level),
    }));
  }

  private toDatasetField(row: {
    id: string;
    datasetId: string;
    columnName: string;
    fieldKind: string;
    fieldLabel: string | null;
    remark: string | null;
    createdAt: Date;
  }): DatasetFieldItem {
    return {
      id: row.id,
      datasetId: row.datasetId,
      columnName: row.columnName,
      fieldKind: row.fieldKind as SensitiveFieldKind,
      fieldLabel: row.fieldLabel,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async ensureDatasetExists(id: string): Promise<void> {
    const rows = await this.db
      .select({ id: daDataset.id })
      .from(daDataset)
      .where(eq(daDataset.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('数据集不存在');
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
