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
import { asc, eq } from 'drizzle-orm';
import { erpDeliverable, erpProject } from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { todayInShanghai } from '@server/common/utils/biz-date';
import type {
  AcceptDeliverableDto,
  CreateDeliverableDto,
  DeliverableItem,
  ReturnDeliverableDto,
  UpdateDeliverableDto,
} from '@shared/api.interface';

const DELIVERABLE_TYPES = [
  'dataset',
  'report',
  'software',
  'doc',
  'other',
] as const;

const todayStr = (): string => todayInShanghai();

@Injectable()
export class DeliverableService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  private toItem(row: typeof erpDeliverable.$inferSelect): DeliverableItem {
    return {
      id: row.id,
      code: row.code,
      projectId: row.projectId,
      name: row.name,
      deliverableType: row.deliverableType,
      acceptanceCriteria: row.acceptanceCriteria,
      dueDate: row.dueDate,
      status: (row.status ?? 'pending') as DeliverableItem['status'],
      reviewer: row.reviewer,
      submittedAt: row.submittedAt,
      acceptedAt: row.acceptedAt,
      acceptConclusion: row.acceptConclusion,
      returnedReason: row.returnedReason,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listByProject(projectId: string): Promise<DeliverableItem[]> {
    const rows = await this.db
      .select()
      .from(erpDeliverable)
      .where(eq(erpDeliverable.projectId, projectId))
      .orderBy(asc(erpDeliverable.createdAt));
    return rows.map((row) => this.toItem(row));
  }

  async create(
    projectId: string,
    dto: CreateDeliverableDto
  ): Promise<DeliverableItem> {
    const projects = await this.db
      .select({ id: erpProject.id, status: erpProject.status })
      .from(erpProject)
      .where(eq(erpProject.id, projectId));
    if (projects.length === 0) throw new NotFoundException('项目不存在');
    if ((projects[0].status ?? '') === 'closed') {
      throw new BadRequestException('项目已结项，不允许登记交付物');
    }
    if (
      dto.deliverableType !== undefined &&
      !DELIVERABLE_TYPES.includes(dto.deliverableType as (typeof DELIVERABLE_TYPES)[number])
    ) {
      throw new BadRequestException(
        `交付物类型须为 ${DELIVERABLE_TYPES.join('/')}`
      );
    }
    const code = await generateBizCode(
      this.db,
      erpDeliverable,
      erpDeliverable.code,
      'DLV'
    );
    const rows = await this.db
      .insert(erpDeliverable)
      .values({
        code,
        projectId,
        name: dto.name,
        deliverableType: dto.deliverableType ?? 'dataset',
        acceptanceCriteria: dto.acceptanceCriteria,
        dueDate: dto.dueDate,
        status: 'pending',
        reviewer: dto.reviewer,
        remark: dto.remark,
      })
      .returning();
    return this.toItem(rows[0]);
  }

  async update(id: string, dto: UpdateDeliverableDto): Promise<DeliverableItem> {
    const existing = await this.db
      .select()
      .from(erpDeliverable)
      .where(eq(erpDeliverable.id, id));
    if (existing.length === 0) throw new NotFoundException('交付物不存在');
    if ((existing[0].status ?? 'pending') !== 'pending') {
      throw new BadRequestException('仅待提交状态的交付物可编辑');
    }
    const patch: Partial<typeof erpDeliverable.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (dto.name !== undefined) patch.name = dto.name;
    if (dto.deliverableType !== undefined) patch.deliverableType = dto.deliverableType;
    if (dto.acceptanceCriteria !== undefined) {
      patch.acceptanceCriteria = dto.acceptanceCriteria;
    }
    if (dto.dueDate !== undefined) patch.dueDate = dto.dueDate;
    if (dto.reviewer !== undefined) patch.reviewer = dto.reviewer;
    if (dto.remark !== undefined) patch.remark = dto.remark;
    const rows = await this.db
      .update(erpDeliverable)
      .set(patch)
      .where(eq(erpDeliverable.id, id))
      .returning();
    return this.toItem(rows[0]);
  }

  async submit(id: string): Promise<DeliverableItem> {
    const existing = await this.db
      .select({ id: erpDeliverable.id, status: erpDeliverable.status })
      .from(erpDeliverable)
      .where(eq(erpDeliverable.id, id));
    if (existing.length === 0) throw new NotFoundException('交付物不存在');
    const status = existing[0].status ?? 'pending';
    if (status !== 'pending' && status !== 'returned') {
      throw new BadRequestException(`状态 ${status} 的交付物不允许提交验收`);
    }
    const rows = await this.db
      .update(erpDeliverable)
      .set({ status: 'submitted', submittedAt: todayStr(), updatedAt: new Date() })
      .where(eq(erpDeliverable.id, id))
      .returning();
    return this.toItem(rows[0]);
  }

  async accept(id: string, dto: AcceptDeliverableDto): Promise<DeliverableItem> {
    const existing = await this.db
      .select()
      .from(erpDeliverable)
      .where(eq(erpDeliverable.id, id));
    if (existing.length === 0) throw new NotFoundException('交付物不存在');
    if ((existing[0].status ?? 'pending') !== 'submitted') {
      throw new BadRequestException('仅已提交验收的交付物可通过验收');
    }
    const rows = await this.db
      .update(erpDeliverable)
      .set({
        status: 'accepted',
        acceptedAt: todayStr(),
        reviewer: dto.reviewer ?? existing[0].reviewer,
        acceptConclusion: dto.acceptConclusion ?? null,
        updatedAt: new Date(),
      })
      .where(eq(erpDeliverable.id, id))
      .returning();
    return this.toItem(rows[0]);
  }

  async returnDeliverable(
    id: string,
    dto: ReturnDeliverableDto
  ): Promise<DeliverableItem> {
    const existing = await this.db
      .select({ id: erpDeliverable.id, status: erpDeliverable.status })
      .from(erpDeliverable)
      .where(eq(erpDeliverable.id, id));
    if (existing.length === 0) throw new NotFoundException('交付物不存在');
    if ((existing[0].status ?? 'pending') !== 'submitted') {
      throw new BadRequestException('仅已提交验收的交付物可退回');
    }
    const rows = await this.db
      .update(erpDeliverable)
      .set({
        status: 'returned',
        returnedReason: dto.reason,
        updatedAt: new Date(),
      })
      .where(eq(erpDeliverable.id, id))
      .returning();
    return this.toItem(rows[0]);
  }
}
