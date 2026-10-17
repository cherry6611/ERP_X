import {
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import {
  CapabilityService,
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import {
  compFeishuSyncRecord,
  erpContract,
  erpProject,
  erpProjectCost,
  erpTimesheet,
  mdCustomer,
  mdEmployee,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { extractPostgresErrorCode } from '@server/common/utils/postgres-error';
import { nextRetryDelaySec } from './retry';
import type {
  FeishuSyncDirection,
  FeishuSyncRecordItem,
  FeishuSyncResult,
  PagedResult,
} from '@shared/api.interface';
import type {
  ContractLedgerArchivingOneInput,
  ErpBitableTwoWaySyncOneInput,
  FlexibleLaborHoursSyncOneSearchrecordsInput,
} from '@shared/plugin-types';

/** 插件实例 ID（appToken/tableID 由用户在插件配置页填写，当前为占位值） */
const COST_SYNC_PLUGIN_ID = 'erp_bitable_two_way_sync_1';
const CONTRACT_SYNC_PLUGIN_ID = 'contract_ledger_archiving_1';
const TIMESHEET_SYNC_PLUGIN_ID = 'flexible_labor_hours_sync_1';

const BATCH_SIZE = 500;
const SEARCH_PAGE_SIZE = 500;
const MAX_SEARCH_PAGES = 100;

/** 出向成本表 Base 字段「成本类型」选项值 */
const COST_TYPE_BASE_LABELS: Record<string, string> = {
  labor: '人力成本',
  outsource: '外包成本',
  compute: '算力成本',
  storage: '存储成本',
  tool: '工具成本',
  travel: '差旅成本',
  flex_labor: '灵活用工',
};

/** 出向合同表 Base 字段「状态」选项值 */
const CONTRACT_STATUS_BASE_LABELS: Record<string, string> = {
  draft: '草稿',
  approving: '审批中',
  active: '已生效',
  performing: '履约中',
  completed: '已完成',
  closed: '已关闭',
};

type SyncMappingRow = typeof compFeishuSyncRecord.$inferSelect;

interface OutboundCandidate {
  bizId: string;
  bizCode: string;
  /** Base 记录字段（中文列名 → 写入值） */
  fields: Record<string, string | number>;
}

/** cause-aware 提取 PostgreSQL SQLSTATE（Drizzle 可能把原始错误放在 cause 链里） */
/** 提取插件/未知错误的可读文本，真实透传给前端，禁止吞错或 mock */
function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  if (error !== null && typeof error === 'object') {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === 'string' && msg) return msg;
    try {
      return JSON.stringify(error);
    } catch (stringifyError: unknown) {
      return String(stringifyError);
    }
  }
  return String(error);
}

/** Base 文本字段读取值兼容 string / number / { text } 三种形态 */
function readTextField(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (value !== null && typeof value === 'object') {
    const text = (value as { text?: unknown }).text;
    if (typeof text === 'string') return text;
    if (typeof text === 'number') return String(text);
  }
  return null;
}

/** Base 日期字段读取值归一为 YYYY-MM-DD（兼容时间戳毫秒 / ISO 字符串 / { text }） */
function toDateString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString().slice(0, 10);
  }
  if (typeof value === 'string') {
    if (/^\d{4}-\d{2}-\d{2}/u.test(value)) return value.slice(0, 10);
    const parsed: Date = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString().slice(0, 10);
    }
    return null;
  }
  if (value !== null && typeof value === 'object') {
    return toDateString((value as { text?: unknown }).text);
  }
  return null;
}

@Injectable()
export class FeishuSyncService {
  private readonly logger = new Logger(FeishuSyncService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Inject(CapabilityService)
    private readonly capabilityService: CapabilityService
  ) {}

  /** 成本台账出向同步：erp_project_cost → 飞书多维表格 */
  async syncCostsToBase(): Promise<FeishuSyncResult> {
    const rows = await this.db
      .select({
        cost: erpProjectCost,
        projectCode: erpProject.code,
        projectName: erpProject.name,
      })
      .from(erpProjectCost)
      .leftJoin(erpProject, eq(erpProjectCost.projectId, erpProject.id));

    const candidates: OutboundCandidate[] = [];
    for (const row of rows) {
      candidates.push({
        bizId: row.cost.id,
        bizCode: row.cost.code,
        fields: {
          成本编号: row.cost.code,
          项目编号: row.projectCode ?? '',
          项目名称: row.projectName ?? '',
          成本类型:
            COST_TYPE_BASE_LABELS[row.cost.costType ?? ''] ?? row.cost.costType ?? '',
          金额: Number(row.cost.amount ?? 0),
          业务日期: row.cost.occurredDate ?? '',
          备注: row.cost.remark ?? '',
        },
      });
    }
    return this.runOutboundSync('cost', COST_SYNC_PLUGIN_ID, candidates);
  }

  /** 合同台账出向同步：erp_contract → 飞书多维表格 */
  async syncContractsToBase(): Promise<FeishuSyncResult> {
    const rows = await this.db
      .select({
        contract: erpContract,
        customerName: mdCustomer.name,
      })
      .from(erpContract)
      .leftJoin(mdCustomer, eq(erpContract.customerId, mdCustomer.id));

    const candidates: OutboundCandidate[] = [];
    for (const row of rows) {
      candidates.push({
        bizId: row.contract.id,
        bizCode: row.contract.code,
        fields: {
          合同编号: row.contract.code,
          合同名称: row.contract.name,
          客户名称: row.customerName ?? '',
          合同金额: Number(row.contract.amount ?? 0),
          状态:
            CONTRACT_STATUS_BASE_LABELS[row.contract.status ?? ''] ??
            row.contract.status ??
            '',
          生效日期: row.contract.startDate ?? '',
        },
      });
    }
    return this.runOutboundSync('contract', CONTRACT_SYNC_PLUGIN_ID, candidates);
  }

  /** 入向同步：多维表格灵活用工工时 → erp_timesheet 草稿 */
  async syncTimesheetsFromBase(): Promise<FeishuSyncResult> {
    const allRecords: Array<{ id: string; record: Record<string, unknown> }> = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
      const input: FlexibleLaborHoursSyncOneSearchrecordsInput = {
        pageSize: SEARCH_PAGE_SIZE,
      };
      if (pageToken) input.pageToken = pageToken;
      let output: unknown;
      try {
        output = await this.capabilityService
          .load(TIMESHEET_SYNC_PLUGIN_ID)
          .call('searchRecords', input);
      } catch (error: unknown) {
        const errText: string = errorText(error);
        this.logger.error(
          `飞书多维表格入向读取失败 bizType=timesheet page=${page + 1}`,
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        );
        // 真实透传插件错误（含未配置 appToken 等），禁止 mock 成功
        throw new HttpException(
          `多维表格工时读取失败：${errText}`,
          HttpStatus.BAD_GATEWAY
        );
      }
      const parsed = this.parseSearchOutput(output);
      allRecords.push(...parsed.records);
      if (!parsed.hasMore || !parsed.pageToken) break;
      pageToken = parsed.pageToken;
    }

    // 幂等：已 success 的 Base 记录不再生成工时
    const recordIds: string[] = allRecords.map((r) => r.id);
    const existing: SyncMappingRow[] =
      recordIds.length > 0
        ? await this.db
            .select()
            .from(compFeishuSyncRecord)
            .where(
              and(
                eq(compFeishuSyncRecord.direction, 'inbound'),
                eq(compFeishuSyncRecord.bizType, 'timesheet'),
                inArray(compFeishuSyncRecord.baseRecordId, recordIds)
              )
            )
        : [];
    const successIds = new Set<string>();
    for (const row of existing) {
      if (row.baseRecordId && row.status === 'success') {
        successIds.add(row.baseRecordId);
      }
    }

    // 项目编号 / 员工编码 主数据映射
    const projects: Array<{ id: string; code: string }> = await this.db
      .select({ id: erpProject.id, code: erpProject.code })
      .from(erpProject);
    const projectByCode = new Map<string, string>(
      projects.map((p: { id: string; code: string }) => [p.code, p.id])
    );
    const employees: Array<{ id: string; code: string }> = await this.db
      .select({ id: mdEmployee.id, code: mdEmployee.code })
      .from(mdEmployee);
    const employeeByCode = new Map<string, string>(
      employees.map((e: { id: string; code: string }) => [e.code, e.id])
    );

    let synced = 0;
    let skipped = 0;
    let failed = 0;
    let firstError: string | null = null;

    for (const rec of allRecords) {
      if (successIds.has(rec.id)) {
        skipped += 1;
        continue;
      }
      // 首次出现的 Base 记录先落 pending 占位行；并发冲突（23505）按跳过处理
      try {
        await this.db.insert(compFeishuSyncRecord).values({
          direction: 'inbound',
          bizType: 'timesheet',
          baseRecordId: rec.id,
          status: 'pending',
        });
      } catch (error: unknown) {
        if (extractPostgresErrorCode(error) === '23505') {
          skipped += 1;
          continue;
        }
        throw error;
      }

      const fields: Record<string, unknown> = rec.record;
      const employeeCode = readTextField(fields['员工编码']);
      const employeeName = readTextField(fields['员工姓名']) ?? '';
      const roleName = readTextField(fields['角色']);
      const projectCode = readTextField(fields['项目编号']);
      const workDate = toDateString(fields['日期']);
      const remark = readTextField(fields['备注']);
      const hoursRaw = fields['小时数'];
      const hours = typeof hoursRaw === 'number' ? hoursRaw : Number(hoursRaw);

      // 校验：项目编号必须能查到 erp_project；小时数必须为正数
      let validationError: string | null = null;
      if (!projectCode || !projectByCode.has(projectCode)) {
        validationError = `项目编号不存在：${projectCode ?? '（空）'}`;
      } else if (!Number.isFinite(hours) || hours <= 0) {
        validationError = `小时数非法：${String(hoursRaw)}`;
      }
      if (validationError !== null) {
        failed += 1;
        if (firstError === null) firstError = validationError;
        await this.markInboundMapping(rec.id, {
          status: 'failed',
          errorMsg: validationError,
        });
        this.logger.warn(`入向工时校验失败 baseRecordId=${rec.id} ${validationError}`);
        continue;
      }

      const code: string = await generateBizCode(
        this.db,
        erpTimesheet,
        erpTimesheet.code,
        'TS'
      );
      const inserted: Array<{ id: string }> = await this.db
        .insert(erpTimesheet)
        .values({
          code,
          projectId: projectByCode.get(projectCode as string),
          employeeName: employeeName || '未知员工',
          roleName,
          workDate,
          hours: String(hours),
          status: 'draft',
          costGenerated: false,
          remark,
          employeeId: employeeCode
            ? employeeByCode.get(employeeCode) ?? null
            : null,
        })
        .returning({ id: erpTimesheet.id });
      await this.markInboundMapping(rec.id, {
        status: 'success',
        errorMsg: null,
        bizId: inserted[0]?.id,
        bizCode: code,
      });
      synced += 1;
    }

    const pending: number = await this.countPending('inbound', 'timesheet');
    const message =
      failed > 0
        ? `导入失败：成功 ${synced} 条，跳过 ${skipped} 条，失败 ${failed} 条；最新错误：${firstError ?? ''}`
        : `导入完成：成功 ${synced} 条，跳过 ${skipped} 条，失败 ${failed} 条`;
    return {
      direction: 'inbound',
      bizType: 'timesheet',
      total: allRecords.length,
      synced,
      skipped,
      failed,
      message,
      pending,
    };
  }

  /** 同步记录分页查询（传统分页，1-indexed） */
  async listSyncRecords(
    direction?: string,
    bizType?: string,
    page = 1,
    pageSize = 20
  ): Promise<PagedResult<FeishuSyncRecordItem>> {
    const conditions = [];
    if (direction === 'outbound' || direction === 'inbound') {
      conditions.push(eq(compFeishuSyncRecord.direction, direction));
    }
    if (bizType) {
      conditions.push(eq(compFeishuSyncRecord.bizType, bizType));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const totalRows: Array<{ total: number }> = await this.db
      .select({ total: count() })
      .from(compFeishuSyncRecord)
      .where(where);
    const rows: SyncMappingRow[] = await this.db
      .select()
      .from(compFeishuSyncRecord)
      .where(where)
      .orderBy(desc(compFeishuSyncRecord.updatedAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      items: rows.map((row: SyncMappingRow): FeishuSyncRecordItem => ({
        id: row.id,
        direction: row.direction as FeishuSyncDirection,
        bizType: row.bizType,
        bizCode: row.bizCode,
        baseRecordId: row.baseRecordId,
        status: row.status as 'pending' | 'success' | 'failed',
        errorMsg: row.errorMsg,
        updatedAt: row.updatedAt.toISOString(),
      })),
      total: Number(totalRows[0]?.total ?? 0),
      page,
      pageSize,
    };
  }

  /** 出向同步通用流程：幂等映射 + 分批写入 Base + 结果回写 */
  private async runOutboundSync(
    bizType: 'cost' | 'contract',
    pluginInstanceId: string,
    candidates: OutboundCandidate[]
  ): Promise<FeishuSyncResult> {
    const total: number = candidates.length;

    // 已 success 的业务记录直接跳过
    const mappings: SyncMappingRow[] = await this.db
      .select()
      .from(compFeishuSyncRecord)
      .where(
        and(
          eq(compFeishuSyncRecord.direction, 'outbound'),
          eq(compFeishuSyncRecord.bizType, bizType)
        )
      );
    const successBizIds = new Set<string>();
    const retryable = new Set<string>();
    const now = Date.now();
    for (const row of mappings) {
      if (!row.bizId) continue;
      if (row.status === 'success') successBizIds.add(row.bizId);
      const due = !row.nextRetryAt || row.nextRetryAt.getTime() <= now;
      // U-20：failed 到期可重放；pending 卡死（冲突插入后无人推进）也纳入重试
      if (row.status === 'failed' && row.retryCount < 5 && due) {
        retryable.add(row.bizId);
      }
      if (row.status === 'pending' && due) {
        retryable.add(row.bizId);
      }
    }
    const pendingCandidates: OutboundCandidate[] = candidates.filter(
      (c: OutboundCandidate) => !successBizIds.has(c.bizId)
    );
    const skipped: number = total - pendingCandidates.length;

    // 首次出现的业务记录先落 pending 占位行；并发冲突（唯一索引）按跳过处理
    const insertedRows: Array<{ bizId: string | null }> =
      pendingCandidates.length > 0
        ? await this.db
            .insert(compFeishuSyncRecord)
            .values(
              pendingCandidates.map((c: OutboundCandidate) => ({
                direction: 'outbound',
                bizType,
                bizId: c.bizId,
                bizCode: c.bizCode,
                status: 'pending',
              }))
            )
            .onConflictDoNothing()
            .returning({ bizId: compFeishuSyncRecord.bizId })
        : [];
    const insertedIds = new Set<string>();
    for (const row of insertedRows) {
      if (row.bizId) insertedIds.add(row.bizId);
    }
    const ready: OutboundCandidate[] = pendingCandidates.filter(
      (c: OutboundCandidate) => insertedIds.has(c.bizId) || retryable.has(c.bizId)
    );
    const conflictSkipped: number = pendingCandidates.length - ready.length;

    let synced = 0;
    let failed = 0;
    let firstError: string | null = null;
    for (let i = 0; i < ready.length; i += BATCH_SIZE) {
      const batch: OutboundCandidate[] = ready.slice(i, i + BATCH_SIZE);
      const input: ErpBitableTwoWaySyncOneInput & ContractLedgerArchivingOneInput = {
        records: batch.map((c: OutboundCandidate) => ({ record: c.fields })),
      };
      try {
        const output: unknown = await this.capabilityService
          .load(pluginInstanceId)
          .call('batchAddRecords', input);
        const baseIds: Array<string | null> = this.parseBatchAddIds(output);
        for (let j = 0; j < batch.length; j += 1) {
          const baseId: string | null = baseIds[j] ?? null;
          if (baseId === null) {
            failed += 1;
            if (firstError === null) firstError = '多维表格未返回记录ID';
            await this.markOutboundMapping(bizType, batch[j].bizId, {
              status: 'failed',
              errorMsg: '多维表格未返回记录ID',
            });
            continue;
          }
          await this.markOutboundMapping(bizType, batch[j].bizId, {
            status: 'success',
            errorMsg: null,
            baseRecordId: baseId,
          });
          synced += 1;
        }
      } catch (error: unknown) {
        const errText: string = errorText(error);
        failed += batch.length;
        if (firstError === null) firstError = errText;
        this.logger.error(
          `飞书多维表格出向批次失败 bizType=${bizType} count=${batch.length}`,
          error instanceof Error ? (error.stack ?? error.message) : String(error)
        );
        for (const c of batch) {
          await this.markOutboundMapping(bizType, c.bizId, {
            status: 'failed',
            errorMsg: errText,
          });
        }
      }
    }

    const pending: number = await this.countPending('outbound', bizType);
    const skippedTotal: number = skipped + conflictSkipped;
    const message =
      failed > 0
        ? `同步失败：成功 ${synced} 条，跳过 ${skippedTotal} 条，失败 ${failed} 条；最新错误：${firstError ?? ''}`
        : `同步完成：成功 ${synced} 条，跳过 ${skippedTotal} 条，失败 ${failed} 条`;
    return {
      direction: 'outbound',
      bizType,
      total,
      synced,
      skipped: skippedTotal,
      failed,
      message,
      pending,
    };
  }

  /** batchAddRecords 出参收窄：按序返回新增记录 ID（缺失项为 null） */
  private parseBatchAddIds(output: unknown): Array<string | null> {
    if (output === null || typeof output !== 'object') return [];
    const records = (output as { records?: unknown }).records;
    if (!Array.isArray(records)) return [];
    return records.map((r: unknown): string | null => {
      if (r !== null && typeof r === 'object') {
        const id = (r as { id?: unknown }).id;
        if (typeof id === 'string') return id;
      }
      return null;
    });
  }

  /** searchRecords 出参收窄 */
  private parseSearchOutput(output: unknown): {
    hasMore: boolean;
    pageToken?: string;
    records: Array<{ id: string; record: Record<string, unknown> }>;
  } {
    if (output === null || typeof output !== 'object') {
      throw new InternalServerErrorException('searchRecords 返回格式非法');
    }
    const o = output as { hasMore?: unknown; pageToken?: unknown; records?: unknown };
    if (typeof o.hasMore !== 'boolean' || !Array.isArray(o.records)) {
      throw new InternalServerErrorException('searchRecords 返回格式非法');
    }
    const records: Array<{ id: string; record: Record<string, unknown> }> = [];
    for (const r of o.records) {
      if (r === null || typeof r !== 'object') continue;
      const rr = r as { id?: unknown; record?: unknown };
      if (typeof rr.id !== 'string') continue;
      if (rr.record === null || typeof rr.record !== 'object') continue;
      records.push({ id: rr.id, record: rr.record as Record<string, unknown> });
    }
    const pageToken: string | undefined =
      typeof o.pageToken === 'string' ? o.pageToken : undefined;
    return { hasMore: o.hasMore, pageToken, records };
  }

  async resetFailed(bizType: 'cost' | 'contract'): Promise<{ reset: number }> {
    const rows = await this.db
      .update(compFeishuSyncRecord)
      .set({ nextRetryAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(compFeishuSyncRecord.direction, 'outbound'),
          eq(compFeishuSyncRecord.bizType, bizType),
          eq(compFeishuSyncRecord.status, 'failed')
        )
      )
      .returning({ id: compFeishuSyncRecord.id });
    return { reset: rows.length };
  }

  /** 出向映射行回写：按 (direction, bizType, bizId) 定位 */
  private async markOutboundMapping(
    bizType: string,
    bizId: string,
    patch: { status: string; errorMsg: string | null; baseRecordId?: string }
  ): Promise<void> {
    const set: Record<string, unknown> = {
      status: patch.status,
      errorMsg: patch.errorMsg,
      updatedAt: new Date(),
    };
    if (patch.baseRecordId !== undefined) set.baseRecordId = patch.baseRecordId;
    if (patch.status === 'failed') {
      const current = await this.db
        .select({ retryCount: compFeishuSyncRecord.retryCount })
        .from(compFeishuSyncRecord)
        .where(
          and(
            eq(compFeishuSyncRecord.direction, 'outbound'),
            eq(compFeishuSyncRecord.bizType, bizType),
            eq(compFeishuSyncRecord.bizId, bizId)
          )
        )
        .limit(1);
      const next = (current[0]?.retryCount ?? 0) + 1;
      const delay = nextRetryDelaySec(next - 1);
      set.retryCount = next;
      set.nextRetryAt = delay === null ? null : new Date(Date.now() + delay * 1000);
      set.lastError = patch.errorMsg;
    }
    if (patch.status === 'success') {
      set.retryCount = 0;
      set.nextRetryAt = null;
      set.lastError = null;
    }
    await this.db
      .update(compFeishuSyncRecord)
      .set(set)
      .where(
        and(
          eq(compFeishuSyncRecord.direction, 'outbound'),
          eq(compFeishuSyncRecord.bizType, bizType),
          eq(compFeishuSyncRecord.bizId, bizId)
        )
      );
  }

  /** 入向映射行回写：按 baseRecordId 定位 */
  private async markInboundMapping(
    baseRecordId: string,
    patch: { status: string; errorMsg: string | null; bizId?: string; bizCode?: string }
  ): Promise<void> {
    const set: Record<string, unknown> = {
      status: patch.status,
      errorMsg: patch.errorMsg,
      updatedAt: new Date(),
    };
    if (patch.bizId !== undefined) set.bizId = patch.bizId;
    if (patch.bizCode !== undefined) set.bizCode = patch.bizCode;
    await this.db
      .update(compFeishuSyncRecord)
      .set(set)
      .where(eq(compFeishuSyncRecord.baseRecordId, baseRecordId));
  }

  private async countPending(
    direction: FeishuSyncDirection,
    bizType: string
  ): Promise<number> {
    const rows: Array<{ total: number }> = await this.db
      .select({ total: count() })
      .from(compFeishuSyncRecord)
      .where(
        and(
          eq(compFeishuSyncRecord.direction, direction),
          eq(compFeishuSyncRecord.bizType, bizType),
          eq(compFeishuSyncRecord.status, 'pending')
        )
      );
    return Number(rows[0]?.total ?? 0);
  }
}
