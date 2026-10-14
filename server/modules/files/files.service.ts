import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { compStoredFile } from '@server/database/schema';
import {
  assertLocalUploadFile,
  scanUploadedFile,
} from '@server/common/security/upload-policy';
import { DRIZZLE_DATABASE } from '@server/platform/tokens';

export interface StoredFileRow {
  id: string;
  fileName: string;
  mime: string | null;
  size: number;
  storagePath: string;
  ownerUserId: string | null;
  version: number;
  parentFileId: string | null;
  isLatest: number;
  rootFileId: string | null;
  magicHex: string | null;
  scanStatus: string;
  scanDetail: string | null;
}

/**
 * B-06：本地文件存储（含版本链与扫描结论）。
 *
 * 版本语义：
 *   - 首次上传的 `root_file_id` = 自身 id、`version` = 1、`isLatest` = 1；
 *   - 再次上传同一资源时，传入 `parentFileId`（上一版本 id），
 *     新行 `root_file_id` 继承链根、`version` = 上一版本 + 1，
 *     并把同链其它行的 `is_latest` 置 0（唯一最新）。
 *
 * 扫描语义：
 *   - `FILE_SCAN_PROVIDER=none` 时结论为 `skipped`，
 *     **不允许把 skipped 当作 clean**（前端需展示"未扫描"提示）；
 *   - 判定为 `infected` 的文件直接拒绝入库并删除已落盘的临时文件。
 */
@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async save(
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
    ownerUserId: string,
    options: { parentFileId?: string } = {}
  ) {
    // B-06 ①：扩展名 + 大小 + 魔数（改名伪装在这里被拦下）
    const magic = assertLocalUploadFile(file);
    // B-06 ②：可插拔扫描（none → skipped，不假装已扫描）
    const verdict = await scanUploadedFile(file.buffer, file.originalname);
    if (verdict.status === 'infected') {
      this.logger.error(
        `上传被扫描器判定为恶意文件 name=${file.originalname} owner=${ownerUserId} detail=${verdict.detail}`
      );
      throw new BadRequestException(`文件未通过安全扫描：${verdict.detail}`);
    }

    let version = 1;
    let rootFileId: string | null = null;
    if (options.parentFileId) {
      const parents = await this.db
        .select({
          id: compStoredFile.id,
          rootFileId: compStoredFile.rootFileId,
          version: compStoredFile.version,
        })
        .from(compStoredFile)
        .where(eq(compStoredFile.id, options.parentFileId))
        .limit(1);
      if (parents.length === 0) {
        throw new BadRequestException('父版本文件不存在，无法创建新版本');
      }
      version = Number(parents[0].version ?? 1) + 1;
      rootFileId = parents[0].rootFileId ?? parents[0].id;
    }

    const dir = process.env.UPLOAD_DIR || join(process.cwd(), 'data', 'uploads');
    await mkdir(dir, { recursive: true });
    const [row] = await this.db
      .insert(compStoredFile)
      .values({
        fileName: file.originalname,
        mime: file.mimetype,
        size: file.size,
        storagePath: 'pending',
        ownerUserId,
        version,
        parentFileId: options.parentFileId ?? null,
        isLatest: 1,
        magicHex: magic.magicHex,
        scanStatus: verdict.status,
        scanDetail: verdict.detail.slice(0, 300),
      })
      .returning();
    const storagePath = join(dir, row.id);
    await writeFile(storagePath, file.buffer);
    await this.db
      .update(compStoredFile)
      .set({ storagePath })
      .where(eq(compStoredFile.id, row.id));
    // 同版本链只保留一个 is_latest
    if (options.parentFileId) {
      await this.db.execute(sql`
        UPDATE comp_stored_file
        SET is_latest = 0
        WHERE root_file_id = ${row.rootFileId ?? row.id}::uuid
          AND id <> ${row.id}::uuid
      `);
    }
    return {
      id: row.id,
      file_path: row.id,
      bucket_id: 'local',
      download_url: `/api/files/${row.id}`,
      version: row.version,
      isLatest: true,
      scanStatus: row.scanStatus,
      scanDetail: row.scanDetail,
    };
  }

  async open(id: string, userId: string, roles: string[] = []) {
    const rows = await this.db
      .select()
      .from(compStoredFile)
      .where(eq(compStoredFile.id, id))
      .limit(1);
    const row = rows[0];
    if (!row) throw new NotFoundException('文件不存在');
    const isAdmin = roles.includes('admin');
    const isOwner = row.ownerUserId != null && row.ownerUserId === userId;
    // 历史无归属文件仅 admin 可下；新文件需本人或 admin
    if (!isAdmin && !isOwner) {
      throw new ForbiddenException('无权下载该文件');
    }
    return row;
  }

  /** B-06 ②：版本链查询（默认展示最新版本，但可查看/下载历史版本） */
  async listVersions(id: string, userId: string, roles: string[] = []) {
    const current = await this.open(id, userId, roles);
    const rootId = current.rootFileId ?? current.id;
    const rows = await this.db
      .select({
        id: compStoredFile.id,
        fileName: compStoredFile.fileName,
        size: compStoredFile.size,
        version: compStoredFile.version,
        isLatest: compStoredFile.isLatest,
        scanStatus: compStoredFile.scanStatus,
        scanDetail: compStoredFile.scanDetail,
        createdAt: compStoredFile.createdAt,
      })
      .from(compStoredFile)
      .where(eq(compStoredFile.rootFileId, rootId))
      .orderBy(desc(compStoredFile.version));
    return rows.map((row) => ({
      id: row.id,
      fileName: row.fileName,
      size: Number(row.size ?? 0),
      version: Number(row.version ?? 1),
      isLatest: Number(row.isLatest ?? 0) === 1,
      scanStatus: row.scanStatus,
      scanDetail: row.scanDetail ?? null,
      createdAt: row.createdAt.toISOString(),
      downloadUrl: `/api/files/${row.id}`,
    }));
  }

  /** 取某资源当前的"最新版本"文件 id（供 attachment 层做默认展示） */
  async latestOf(rootFileId: string): Promise<string | null> {
    const rows = await this.db
      .select({ id: compStoredFile.id })
      .from(compStoredFile)
      .where(
        and(eq(compStoredFile.rootFileId, rootFileId), eq(compStoredFile.isLatest, 1))
      )
      .limit(1);
    return rows[0]?.id ?? null;
  }

  /**
   * B-06 ③：清理无引用且超过 N 天的临时文件。
   * 只处理没有 attachment 引用的行，避免误删业务附件。
   */
  async purgeOrphans(olderThanDays = 7): Promise<number> {
    const result = await this.db.execute(sql`
      DELETE FROM comp_stored_file f
      WHERE f._created_at < CURRENT_TIMESTAMP - (${olderThanDays} * interval '1 day')
        AND NOT EXISTS (
          SELECT 1 FROM comp_attachment a
          WHERE a.file_url LIKE '%' || f.id::text || '%'
        )
      RETURNING f.id
    `);
    const list = Array.isArray(result)
      ? (result as unknown[])
      : ((result as { rows?: unknown[] }).rows ?? []);
    if (list.length > 0) {
      this.logger.log(`清理无引用文件 ${list.length} 个（超过 ${olderThanDays} 天）`);
    }
    return list.length;
  }
}
