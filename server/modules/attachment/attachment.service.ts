import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { compAttachment } from '@server/database/schema';
import { ResourceAclService } from './resource-acl.service';
import type { Attachment, CreateAttachmentDto } from '@shared/api.interface';

const MAX_ATTACHMENTS_PER_RESOURCE = 10;

interface AttachmentRow {
  id: string;
  resourceType: string;
  resourceId: string;
  fileName: string;
  fileUrl: string;
  fileSize: number;
  sourceType: string;
  uploadedBy: string | null;
  createdAt: Date;
}

@Injectable()
export class AttachmentService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly resourceAcl: ResourceAclService,
  ) {}

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
    return rows.map((row: AttachmentRow) => ({
      ...row,
      sourceType: row.sourceType === 'feishu_doc' ? 'feishu_doc' : 'upload',
      createdAt: row.createdAt.toISOString(),
      canDelete: false,
    }));
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
    return items.map((item: Attachment) => ({
      ...item,
      canDelete: item.uploadedBy === userId,
    }));
  }

  async create(userId: string, userName: string, dto: CreateAttachmentDto): Promise<Attachment> {
    await this.resourceAcl.assertCanAccess(
      { userId, userName },
      dto.resourceType,
      dto.resourceId,
    );
    this.resourceAcl.assertFileUrl(dto.fileUrl);
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
        fileName: dto.fileName,
        fileUrl: dto.fileUrl,
        fileSize: dto.fileSize ?? 0,
        sourceType: dto.sourceType === 'feishu_doc' ? 'feishu_doc' : 'upload',
      })
      .returning({
        id: compAttachment.id,
        createdAt: compAttachment.createdAt,
      });

    return {
      id: row.id,
      resourceType: dto.resourceType,
      resourceId: dto.resourceId,
      fileName: dto.fileName,
      fileUrl: dto.fileUrl,
      fileSize: dto.fileSize ?? 0,
      sourceType: dto.sourceType === 'feishu_doc' ? 'feishu_doc' : 'upload',
      uploadedBy: userId,
      createdAt: row.createdAt.toISOString(),
      canDelete: true,
    };
  }

  async remove(
    userId: string,
    id: string,
    roles: string[] = []
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
              sql`(${compAttachment.createdBy}).user_id = ${userId}`
            )
      )
      .returning({ id: compAttachment.id });
    if (deleted.length === 0) {
      throw new ForbiddenException('仅上传人或管理员可删除附件');
    }
  }
}
