import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import {
  compAttachment,
  compProjectDriveSync,
  erpProject,
} from '@server/database/schema';
import { FEISHU_TENANT_DOMAIN } from '@server/modules/feishu-drive/feishu-client.service';
import { DriveService } from '@server/modules/feishu-drive/drive.service';
import { WikiService } from '@server/modules/feishu-drive/wiki.service';
import type {
  DriveCreatedItem,
  DriveFolderChildrenResponse,
  DriveItem,
  DriveSyncDetail,
  DriveSyncStatusItem,
  ProjectDriveSyncResult,
  ProjectDriveSyncStatus,
} from '@shared/api.interface';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const REMARK_MAX_LENGTH = 480;
const ARCHIVE_TITLE_SUFFIX = ' 项目归档';
const WIKI_DENIED_REMARK = '知识库未授权';
const ARCHIVE_KIND = 'archive';
const FILE_KIND = 'file';

type AttachmentRow = typeof compAttachment.$inferSelect;
type SyncRecordRow = typeof compProjectDriveSync.$inferSelect;

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function truncateRemark(text: string): string {
  return text.length > REMARK_MAX_LENGTH ? text.slice(0, REMARK_MAX_LENGTH) : text;
}

function toStatusItemStatus(raw: string): DriveSyncStatusItem['syncStatus'] {
  if (raw === 'synced' || raw === 'skipped' || raw === 'failed') return raw;
  return 'pending';
}

@Injectable()
export class ProjectArchiveService {
  private readonly logger = new Logger(ProjectArchiveService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly driveService: DriveService,
    private readonly wikiService: WikiService,
  ) {}

  async syncProjectFiles(projectId: string): Promise<ProjectDriveSyncResult> {
    const projects: { id: string; name: string }[] = await this.db
      .select({ id: erpProject.id, name: erpProject.name })
      .from(erpProject)
      .where(eq(erpProject.id, projectId));
    if (projects.length === 0) {
      throw new NotFoundException('项目不存在');
    }
    const projectName: string = projects[0].name;

    const attachments: AttachmentRow[] = await this.db
      .select()
      .from(compAttachment)
      .where(
        and(
          eq(compAttachment.resourceType, 'erp_project'),
          eq(compAttachment.resourceId, projectId),
        ),
      );

    const syncRecords: SyncRecordRow[] = await this.db
      .select()
      .from(compProjectDriveSync)
      .where(eq(compProjectDriveSync.projectId, projectId));

    const folderRecord: SyncRecordRow | undefined = syncRecords.find(
      (row: SyncRecordRow) => row.folderToken !== null,
    );
    let folderToken: string | null = folderRecord?.folderToken ?? null;
    if (folderToken === null) {
      folderToken = await this.ensureProjectFolder(projectName);
    }

    const syncedAttachmentIds: Set<string> = new Set();
    for (const row of syncRecords) {
      if (row.kind === FILE_KIND && row.attachmentId !== null) {
        syncedAttachmentIds.add(row.attachmentId);
      }
    }

    const details: DriveSyncDetail[] = [];
    for (const attachment of attachments) {
      if (attachment.sourceType !== 'upload') continue;
      if (syncedAttachmentIds.has(attachment.id)) continue;
      try {
        const detail: DriveSyncDetail = await this.syncOneAttachment(
          attachment,
          projectId,
          folderToken,
        );
        details.push(detail);
      } catch (error: unknown) {
        details.push({
          fileName: attachment.fileName,
          status: 'failed',
          remark: truncateRemark(errorText(error)),
        });
      }
    }

    const archiveRecord: SyncRecordRow | undefined = syncRecords.find(
      (row: SyncRecordRow) => row.kind === ARCHIVE_KIND,
    );
    let archiveDocUrl: string | null = null;
    let wikiPermissionDenied = false;

    if (archiveRecord) {
      const docToken: string | null = archiveRecord.driveFileToken;
      if (docToken) {
        archiveDocUrl = `${FEISHU_TENANT_DOMAIN}/docx/${docToken}`;
      }
      const deniedBefore: boolean =
        archiveRecord.syncStatus === 'failed' &&
        (archiveRecord.remark ?? '').includes(WIKI_DENIED_REMARK);
      if (deniedBefore && docToken) {
        try {
          const wikiResult = await this.wikiService.syncToWiki(docToken, 'docx');
          const updated = await this.db
            .update(compProjectDriveSync)
            .set({ syncStatus: 'synced', remark: null, updatedAt: new Date() })
            .where(eq(compProjectDriveSync.id, archiveRecord.id))
            .returning({ id: compProjectDriveSync.id });
          if (updated.length === 0) {
            throw new NotFoundException('归档同步记录不存在');
          }
          archiveDocUrl = wikiResult.wikiUrl ?? archiveDocUrl;
        } catch (error: unknown) {
          if (error instanceof BadRequestException) {
            wikiPermissionDenied = true;
          } else {
            this.logger.error(
              `项目归档文档知识库同步重试失败 project=${projectId}`,
              error instanceof Error ? (error.stack ?? error.message) : String(error),
            );
          }
        }
      }
    } else {
      const archiveTitle: string = `${projectName}${ARCHIVE_TITLE_SUFFIX}`;
      const created: DriveCreatedItem = await this.driveService.createDocument(
        folderToken,
        archiveTitle,
      );
      try {
        const wikiResult = await this.wikiService.syncToWiki(created.token, 'docx');
        await this.db.insert(compProjectDriveSync).values({
          projectId,
          kind: ARCHIVE_KIND,
          folderToken,
          driveFileToken: created.token,
          fileName: archiveTitle,
          syncStatus: 'synced',
          remark: null,
        });
        archiveDocUrl = wikiResult.wikiUrl ?? `${FEISHU_TENANT_DOMAIN}/docx/${created.token}`;
      } catch (error: unknown) {
        const remark: string =
          error instanceof BadRequestException
            ? WIKI_DENIED_REMARK
            : truncateRemark(errorText(error));
        if (error instanceof BadRequestException) {
          wikiPermissionDenied = true;
        } else {
          this.logger.error(
            `项目归档文档知识库同步失败 project=${projectId}`,
            error instanceof Error ? (error.stack ?? error.message) : String(error),
          );
        }
        await this.db.insert(compProjectDriveSync).values({
          projectId,
          kind: ARCHIVE_KIND,
          folderToken,
          driveFileToken: created.token,
          fileName: archiveTitle,
          syncStatus: 'failed',
          remark,
        });
        archiveDocUrl = `${FEISHU_TENANT_DOMAIN}/docx/${created.token}`;
      }
    }

    const syncedFiles: number = details.filter(
      (detail: DriveSyncDetail) => detail.status === 'synced',
    ).length;
    const skippedFiles: number = details.filter(
      (detail: DriveSyncDetail) => detail.status === 'skipped',
    ).length;
    const failedFiles: number = details.filter(
      (detail: DriveSyncDetail) => detail.status === 'failed',
    ).length;

    return {
      projectId,
      folderToken,
      folderUrl: `${FEISHU_TENANT_DOMAIN}/drive/folder/${folderToken}`,
      syncedFiles,
      skippedFiles,
      failedFiles,
      archiveDocUrl,
      wikiPermissionDenied,
      details,
    };
  }

  async getSyncStatus(projectId: string): Promise<ProjectDriveSyncStatus> {
    const projects: { id: string }[] = await this.db
      .select({ id: erpProject.id })
      .from(erpProject)
      .where(eq(erpProject.id, projectId));
    if (projects.length === 0) {
      throw new NotFoundException('项目不存在');
    }

    const attachments: AttachmentRow[] = await this.db
      .select()
      .from(compAttachment)
      .where(
        and(
          eq(compAttachment.resourceType, 'erp_project'),
          eq(compAttachment.resourceId, projectId),
        ),
      );

    const syncRecords: SyncRecordRow[] = await this.db
      .select()
      .from(compProjectDriveSync)
      .where(eq(compProjectDriveSync.projectId, projectId));

    const folderToken: string | null =
      syncRecords.find((row: SyncRecordRow) => row.folderToken !== null)
        ?.folderToken ?? null;

    const archiveRecord: SyncRecordRow | undefined = syncRecords.find(
      (row: SyncRecordRow) => row.kind === ARCHIVE_KIND,
    );
    const archiveDocUrl: string | null = archiveRecord?.driveFileToken
      ? `${FEISHU_TENANT_DOMAIN}/docx/${archiveRecord.driveFileToken}`
      : null;

    let lastSyncedAt: string | null = null;
    if (syncRecords.length > 0) {
      const latest: Date = syncRecords.reduce(
        (max: Date, row: SyncRecordRow) => (row.createdAt > max ? row.createdAt : max),
        syncRecords[0].createdAt,
      );
      lastSyncedAt = latest.toISOString();
    }

    const recordByAttachment: Map<string, SyncRecordRow> = new Map();
    for (const row of syncRecords) {
      if (row.kind === FILE_KIND && row.attachmentId !== null) {
        recordByAttachment.set(row.attachmentId, row);
      }
    }

    const items: DriveSyncStatusItem[] = attachments
      .filter((attachment: AttachmentRow) => attachment.sourceType === 'upload')
      .map((attachment: AttachmentRow) => {
        const record: SyncRecordRow | undefined = recordByAttachment.get(attachment.id);
        return {
          attachmentId: attachment.id,
          fileName: attachment.fileName,
          syncStatus: record ? toStatusItemStatus(record.syncStatus) : 'pending',
          remark: record?.remark ?? null,
        };
      });

    return {
      folderUrl:
        folderToken !== null
          ? `${FEISHU_TENANT_DOMAIN}/drive/folder/${folderToken}`
          : null,
      archiveDocUrl,
      lastSyncedAt,
      items,
    };
  }

  private async ensureProjectFolder(projectName: string): Promise<string> {
    const rootToken: string = await this.driveService.getRootFolderToken();
    let folderToken: string | null = null;
    let pageToken: string | undefined;
    while (folderToken === null) {
      const page: DriveFolderChildrenResponse =
        await this.driveService.listChildren(rootToken, pageToken);
      const hit: DriveItem | undefined = page.items.find(
        (item: DriveItem) => item.type === 'folder' && item.name === projectName,
      );
      if (hit) {
        folderToken = hit.token;
        break;
      }
      if (!page.hasMore || !page.pageToken) break;
      pageToken = page.pageToken;
    }
    if (folderToken === null) {
      const created: DriveCreatedItem = await this.driveService.createFolder(
        rootToken,
        projectName,
      );
      folderToken = created.token;
    }
    return folderToken;
  }

  private async syncOneAttachment(
    attachment: AttachmentRow,
    projectId: string,
    folderToken: string,
  ): Promise<DriveSyncDetail> {
    let buffer: Buffer;
    try {
      const resp = await fetch(attachment.fileUrl);
      if (!resp.ok) {
        throw new Error(`HTTP ${String(resp.status)}`);
      }
      buffer = Buffer.from(await resp.arrayBuffer());
    } catch (error: unknown) {
      const remark: string = truncateRemark(`下载失败：${errorText(error)}`);
      await this.insertFileRecord(
        projectId,
        attachment.id,
        folderToken,
        null,
        attachment.fileName,
        'failed',
        remark,
      );
      return { fileName: attachment.fileName, status: 'failed', remark };
    }

    if (buffer.length > MAX_UPLOAD_BYTES) {
      const remark: string = '超过 10MB 限制';
      await this.insertFileRecord(
        projectId,
        attachment.id,
        folderToken,
        null,
        attachment.fileName,
        'skipped',
        remark,
      );
      return { fileName: attachment.fileName, status: 'skipped', remark };
    }

    try {
      const created: DriveCreatedItem = await this.driveService.uploadFile(
        folderToken,
        attachment.fileName,
        buffer.toString('base64'),
        buffer.length,
      );
      await this.insertFileRecord(
        projectId,
        attachment.id,
        folderToken,
        created.token,
        attachment.fileName,
        'synced',
        null,
      );
      return { fileName: attachment.fileName, status: 'synced', remark: null };
    } catch (error: unknown) {
      const remark: string = truncateRemark(`上传失败：${errorText(error)}`);
      await this.insertFileRecord(
        projectId,
        attachment.id,
        folderToken,
        null,
        attachment.fileName,
        'failed',
        remark,
      );
      return { fileName: attachment.fileName, status: 'failed', remark };
    }
  }

  private async insertFileRecord(
    projectId: string,
    attachmentId: string,
    folderToken: string,
    driveFileToken: string | null,
    fileName: string,
    syncStatus: string,
    remark: string | null,
  ): Promise<void> {
    await this.db.insert(compProjectDriveSync).values({
      projectId,
      kind: FILE_KIND,
      attachmentId,
      folderToken,
      driveFileToken,
      fileName,
      syncStatus,
      remark,
    });
  }
}
