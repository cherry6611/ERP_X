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
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { isAllowedFeishuUrl } from '@server/common/security/feishu-url';
import { compAttachment } from '@server/database/schema';
import { ResourceAclService } from './resource-acl.service';
import { FeishuDocParseService } from './feishu-doc-parse.service';
import type {
  Attachment,
  CreateAttachmentDto,
  ParsedFeishuDocLink,
} from '@shared/api.interface';

const MAX_ATTACHMENTS_PER_RESOURCE = 10;

interface AttachmentRow {
  id: string;
  resourceType: string;
  resourceId: string;
  fileName: string;
  fileUrl: string;
  fileSize: number;
  sourceType: string;
  feishuToken: string | null;
  feishuDocType: string | null;
  feishuUrl: string | null;
  uploadedBy: string | null;
  createdAt: Date;
}

function mapRow(row: AttachmentRow, canDelete: boolean): Attachment {
  return {
    id: row.id,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    fileName: row.fileName,
    fileUrl: row.fileUrl,
    fileSize: row.fileSize,
    sourceType: row.sourceType === 'feishu_doc' ? 'feishu_doc' : 'upload',
    feishuToken: row.feishuToken,
    feishuDocType: row.feishuDocType,
    feishuUrl: row.feishuUrl,
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt.toISOString(),
    canDelete,
  };
}

function isLocalFileUrl(fileUrl: string): boolean {
  return (
    fileUrl.startsWith('/api/files/') ||
    /^https?:\/\/[^/]+\/api\/files\//i.test(fileUrl)
  );
}

@Injectable()
export class AttachmentService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly resourceAcl: ResourceAclService,
    private readonly feishuDocParse: FeishuDocParseService,
  ) {}

  parseFeishuUrl(url: string): Promise<ParsedFeishuDocLink> {
    return this.feishuDocParse.parseUrl(url);
  }

  async list(resourceType: string, resourceId: string): Promise<Attachment[]> {
    const rows: AttachmentRow[] = await this.db
      .select({
        id: compAttachment.id,
        resourceType: compAttachment.resourceType,
        resourceId: compAttachment.resourceId,
        fileName: compAttachment.fileName,
        fileUrl: compAttachment.fileUrl,
        fileSize: compAttachment.fileSize,
        sourceType: compAttachment.sourceType,
        feishuToken: compAttachment.feishuToken,
        feishuDocType: compAttachment.feishuDocType,
        feishuUrl: compAttachment.feishuUrl,
        uploadedBy: sql<string | null>`(${compAttachment.createdBy}).user_id`,
        createdAt: compAttachment.createdAt,
      })
      .from(compAttachment)
      .where(
        and(
          eq(compAttachment.resourceType, resourceType),
          eq(compAttachment.resourceId, resourceId),
        ),
      )
      .orderBy(asc(compAttachment.createdAt));
    return rows.map((row) => mapRow(row, false));
  }

  async listWithAclCheck(
    userId: string,
    userName: string,
    resourceType: string,
    resourceId: string,
  ): Promise<Attachment[]> {
    await this.resourceAcl.assertCanAccess(
      { userId, userName },
      resourceType,
      resourceId,
    );
    const items = await this.list(resourceType, resourceId);
    return items.map((item) => ({
      ...item,
      canDelete: item.uploadedBy === userId,
    }));
  }

  async create(
    userId: string,
    userName: string,
    dto: CreateAttachmentDto,
  ): Promise<Attachment> {
    await this.resourceAcl.assertCanAccess(
      { userId, userName },
      dto.resourceType,
      dto.resourceId,
    );

    const sourceType =
      dto.sourceType === 'feishu_doc' ? 'feishu_doc' : 'upload';

    if (sourceType === 'feishu_doc') {
      if (!isAllowedFeishuUrl(dto.fileUrl)) {
        throw new BadRequestException('飞书云文档链接仅允许飞书域名（https）');
      }
    } else if (!isLocalFileUrl(dto.fileUrl) && !isAllowedFeishuUrl(dto.fileUrl)) {
      throw new BadRequestException('本地附件地址无效');
    }

    let feishuToken = dto.feishuToken?.trim() || null;
    let feishuDocType = dto.feishuDocType?.trim() || null;
    let feishuUrl = dto.feishuUrl?.trim() || null;
    let fileName = dto.fileName.trim();
    let fileUrl = dto.fileUrl.trim();

    if (sourceType === 'feishu_doc' && (!feishuToken || !feishuDocType)) {
      const parsed = await this.feishuDocParse.parseUrl(fileUrl);
      feishuToken = parsed.token;
      feishuDocType = parsed.docType;
      feishuUrl = parsed.url;
      if (!fileName) fileName = parsed.title;
      fileUrl = parsed.url;
    }
    if (sourceType === 'feishu_doc' && !feishuUrl) {
      feishuUrl = fileUrl;
    }

    const [{ total }] = await this.db
      .select({ total: count() })
      .from(compAttachment)
      .where(
        and(
          eq(compAttachment.resourceType, dto.resourceType),
          eq(compAttachment.resourceId, dto.resourceId),
        ),
      );
    if (total >= MAX_ATTACHMENTS_PER_RESOURCE) {
      throw new BadRequestException(
        `每个单据最多 ${MAX_ATTACHMENTS_PER_RESOURCE} 个附件`,
      );
    }

    const [row] = await this.db
      .insert(compAttachment)
      .values({
        resourceType: dto.resourceType,
        resourceId: dto.resourceId,
        fileName,
        fileUrl,
        fileSize: dto.fileSize ?? 0,
        sourceType,
        feishuToken,
        feishuDocType,
        feishuUrl,
      })
      .returning({
        id: compAttachment.id,
        createdAt: compAttachment.createdAt,
      });

    return {
      id: row.id,
      resourceType: dto.resourceType,
      resourceId: dto.resourceId,
      fileName,
      fileUrl,
      fileSize: dto.fileSize ?? 0,
      sourceType,
      feishuToken,
      feishuDocType,
      feishuUrl,
      uploadedBy: userId,
      createdAt: row.createdAt.toISOString(),
      canDelete: true,
    };
  }

  async remove(
    userId: string,
    id: string,
    roles: string[] = [],
  ): Promise<void> {
    const found = await this.db
      .select({ id: compAttachment.id })
      .from(compAttachment)
      .where(eq(compAttachment.id, id));
    if (found.length === 0) {
      throw new NotFoundException('附件不存在');
    }
    const isAdmin = roles.includes('admin');
    const deleted = await this.db
      .delete(compAttachment)
      .where(
        isAdmin
          ? eq(compAttachment.id, id)
          : and(
              eq(compAttachment.id, id),
              sql`(${compAttachment.createdBy}).user_id = ${userId}`,
            ),
      )
      .returning({ id: compAttachment.id });
    if (deleted.length === 0) {
      throw new ForbiddenException('仅上传人或管理员可删除附件');
    }
  }
}
