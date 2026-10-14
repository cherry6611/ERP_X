import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, count, desc, eq, sql } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  RAW_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { exportTasks } from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { todayInShanghai } from '@server/common/utils/biz-date';
import { BankAccountService } from '../bank/bank-account.service';
import { BankStatementService } from '../bank/bank-statement.service';
import { BankReconciliationService } from '../bank/bank-reconciliation.service';
import {
  describeFilters,
  getExportResource,
  validateFilters,
} from './export-resources';
import { buildExportFile, type ExportFileMeta } from './export-file';import type {
  CreateExportTaskDto,
  ExportFileFormat,
  ExportTaskItem,
  ExportTaskListParams,
  ExportTaskStatus,
  PagedResult,
} from '@shared/api.interface';

const MAX_ROWS_HARD_LIMIT = 200_000;

interface ExportTaskRow {
  id: string;
  code: string;
  resourceType: string;
  format: string;
  filterParams: unknown;
  filterSummary: string;
  status: string;
  fileName: string | null;
  fileSize: number | null;
  rowCount: number | null;
  errorMessage: string | null;
  requestedBy: string | null;
  requestedByName: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
}

export interface ExportDownload {
  stream: NodeJS.ReadableStream;
  fileName: string;
  contentType: string;
  size: number;
}

/**
 * C-07 异步导出。
 *
 * 关键约束（B-22）：**外部 IO（写文件）必须在请求事务之外执行**。
 * 因此 POST /api/exports 只落一行任务（事务内），真正的取数 + 写文件通过
 * `setImmediate` 延时到响应周期之后执行（此时请求事务已提交/回滚），
 * 且写文件与后台取数一律使用 RAW_DATABASE（不参与请求事务）。
 */
@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    @Inject(RAW_DATABASE) private readonly raw: PostgresJsDatabase,
    private readonly bankAccounts: BankAccountService,
    private readonly statements: BankStatementService,
    private readonly reconciliation: BankReconciliationService
  ) {}

  /* ==================== 路径与序列化 ==================== */

  private static exportDir(): string {
    return process.env.EXPORT_DIR
      ? resolve(process.env.EXPORT_DIR)
      : resolve(process.env.UPLOAD_DIR || join(process.cwd(), 'data', 'uploads'), 'exports');
  }

  private static contentType(format: string): string {
    return format === 'csv'
      ? 'text/csv; charset=utf-8'
      : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }

  private toItem(row: ExportTaskRow): ExportTaskItem {
    const descriptor = getExportResource(row.resourceType);
    return {
      id: row.id,
      code: row.code,
      resourceType: row.resourceType as ExportTaskItem['resourceType'],
      resourceLabel: descriptor?.label ?? row.resourceType,
      format: (row.format ?? 'xlsx') as ExportFileFormat,
      filterParams: (row.filterParams ?? {}) as ExportTaskItem['filterParams'],
      filterSummary: row.filterSummary ?? '',
      status: row.status as ExportTaskStatus,
      fileName: row.fileName,
      fileSize: row.fileSize,
      rowCount: row.rowCount,
      errorMessage: row.errorMessage,
      requestedBy: row.requestedBy,
      requestedByName: row.requestedByName,
      startedAt: row.startedAt?.toISOString() ?? null,
      finishedAt: row.finishedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      downloadUrl:
        row.status === 'succeeded' && row.fileName ? `/api/exports/${row.id}/download` : null,
    };
  }

  /* ==================== 创建与查询 ==================== */

  /**
   * 创建导出任务。同一用户 + 同资源 + 同筛选 + 同格式在 60 秒内重复提交视为
   * 幂等重复（返回已有任务，不重复建任务），避免前端连点产生大量重复文件。
   */
  async createTask(
    dto: CreateExportTaskDto,
    actor: { userId: string; userName: string }
  ): Promise<ExportTaskItem> {
    const descriptor = getExportResource(dto.resourceType);
    const filters = validateFilters(
      descriptor,
      (dto.filterParams ?? {}) as Record<string, unknown>
    );
    const format: ExportFileFormat = dto.format ?? 'xlsx';
    const filterSummary = describeFilters(descriptor, filters);

    const recent = await this.db
      .select()
      .from(exportTasks)
      .where(
        and(
          eq(exportTasks.resourceType, descriptor.type),
          eq(exportTasks.requestedBy, actor.userId),
          eq(exportTasks.format, format),
          eq(exportTasks.status, 'pending'),
          sql`${exportTasks.filterParams} = ${JSON.stringify(filters)}::jsonb`,
          sql`${exportTasks.createdAt} > now() - interval '60 seconds'`
        )
      )
      .orderBy(desc(exportTasks.createdAt))
      .limit(1);
    if (recent.length > 0) return this.toItem(recent[0] as ExportTaskRow);

    const code = await generateBizCode(
      this.db,
      exportTasks,
      exportTasks.code,
      'EXP'
    );
    const inserted = await this.db
      .insert(exportTasks)
      .values({
        code,
        resourceType: descriptor.type,
        format,
        filterParams: filters,
        filterSummary,
        status: 'pending',
        requestedBy: actor.userId,
        requestedByName: actor.userName,
      })
      .returning();
    const task = inserted[0] as ExportTaskRow;
    // 延时到响应之后：确保文件写入发生在请求事务之外
    setImmediate(() => {
      void this.runTask(task.id, actor);
    });
    return this.toItem(task);
  }

  async listTasks(
    params: ExportTaskListParams,
    actor: { userId: string; roles: string[] }
  ): Promise<PagedResult<ExportTaskItem>> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize ?? 20));
    const conditions = [];
    // “我的导出列表”：非 admin 只看到自己发起的任务
    if (!actor.roles.includes('admin')) {
      conditions.push(eq(exportTasks.requestedBy, actor.userId));
    }
    if (params.status) conditions.push(eq(exportTasks.status, params.status));
    if (params.resourceType) {
      conditions.push(eq(exportTasks.resourceType, params.resourceType));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const totalRows: Array<{ total: number }> = await this.db
      .select({ total: count() })
      .from(exportTasks)
      .where(where);
    const rows = await this.db
      .select()
      .from(exportTasks)
      .where(where)
      .orderBy(desc(exportTasks.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      items: rows.map((row) => this.toItem(row as ExportTaskRow)),
      total: Number(totalRows[0]?.total ?? 0),
      page,
      pageSize,
    };
  }

  async getTask(
    id: string,
    actor: { userId: string; roles: string[] }
  ): Promise<ExportTaskItem> {
    const rows = await this.db
      .select()
      .from(exportTasks)
      .where(eq(exportTasks.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('导出任务不存在');
    const row = rows[0] as ExportTaskRow;
    if (!actor.roles.includes('admin') && row.requestedBy !== actor.userId) {
      throw new ForbiddenException('无权查看他人的导出任务');
    }
    return this.toItem(row);
  }

  async openDownload(
    id: string,
    actor: { userId: string; roles: string[] }
  ): Promise<ExportDownload> {
    const rows = await this.db
      .select()
      .from(exportTasks)
      .where(eq(exportTasks.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('导出任务不存在');
    const row = rows[0] as ExportTaskRow;
    if (!actor.roles.includes('admin') && row.requestedBy !== actor.userId) {
      throw new ForbiddenException('无权下载他人的导出文件');
    }
    if (row.status !== 'succeeded' || !row.fileName) {
      throw new BadRequestException(
        row.status === 'failed'
          ? `导出失败：${row.errorMessage ?? '未知原因'}`
          : '导出尚未完成，请稍后刷新任务状态'
      );
    }
    const filePath = join(ExportsService.exportDir(), row.fileName);
    const info = await stat(filePath).catch(() => null);
    if (!info) {
      throw new NotFoundException('导出文件已不存在（可能已被清理），请重新发起导出');
    }
    return {
      stream: createReadStream(filePath),
      fileName: row.fileName,
      contentType: ExportsService.contentType(row.format),
      size: info.size,
    };
  }

  /* ==================== 后台执行 ==================== */

  private async markStatus(
    id: string,
    patch: Partial<typeof exportTasks.$inferInsert>
  ): Promise<void> {
    // 后台上下文没有请求事务，这里显式包一层事务（写任务状态属数据库写入）
    await this.raw
      .update(exportTasks)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(exportTasks.id, id));
  }

  private async runTask(
    id: string,
    actor: { userId: string; userName: string }
  ): Promise<void> {
    try {
      await this.markStatus(id, { status: 'running', startedAt: new Date() });
      const rows = await this.raw
        .select()
        .from(exportTasks)
        .where(eq(exportTasks.id, id))
        .limit(1);
      if (rows.length === 0) return;
      const task = rows[0] as ExportTaskRow;
      const descriptor = getExportResource(task.resourceType);
      const filters = (task.filterParams ?? {}) as Record<string, string>;

      const records = await descriptor.load(
        {
          bankAccounts: this.bankAccounts,
          statements: this.statements,
          reconciliation: this.reconciliation,
        },
        filters
      );
      const limited = records.slice(0, MAX_ROWS_HARD_LIMIT);

      const dir = ExportsService.exportDir();
      await mkdir(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = `${descriptor.filePrefix}-${stamp}.${task.format}`;
      const filePath = join(dir, fileName);
      const meta: ExportFileMeta = {
        resourceLabel: descriptor.label,
        filterSummary: task.filterSummary,
        requestedByName: task.requestedByName ?? actor.userName,
        generatedAt: new Date().toISOString(),
        truncated: records.length > limited.length,
        dateInShanghai: todayInShanghai(),
      };
      const buffer = await buildExportFile(
        task.format === 'csv' ? 'csv' : 'xlsx',
        descriptor.columns,
        limited,
        meta
      );
      // 外部 IO：写文件（在请求事务之外）
      await writeFile(filePath, buffer);
      await this.markStatus(id, {
        status: 'succeeded',
        fileName,
        fileSize: buffer.length,
        rowCount: limited.length,
        errorMessage: null,
        finishedAt: new Date(),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`导出任务 ${id} 失败：${message}`);
      await this.markStatus(id, {
        status: 'failed',
        errorMessage: message.slice(0, 1000),
        finishedAt: new Date(),
      }).catch(() => undefined);
    }
  }

  /** 供测试/运维读取文件内容（不经过 HTTP） */
  async readFileForTest(id: string): Promise<Buffer> {
    const rows = await this.raw
      .select()
      .from(exportTasks)
      .where(eq(exportTasks.id, id))
      .limit(1);
    if (rows.length === 0 || !rows[0].fileName) {
      throw new NotFoundException('导出文件不存在');
    }
    return readFile(join(ExportsService.exportDir(), rows[0].fileName));
  }
}
