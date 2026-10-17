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
    // B7：结项后冻结（原实现只校验了状态，未校验项目是否已结项）
    await this.assertProjectNotClosed(existing[0].projectId);
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

  /**
   * B7（§7.2）：**结项后项目冻结** —— 交付物的全部写动作共用一道闸门。
   *
   * ## 原缺陷（典型的三缺一）
   *
   * `create` 有这道校验，而 `submit` / `accept` / `returnDeliverable` /
   * `update` **都没有**。于是结项后仍能：
   *   · 把待验收的交付物提交验收；
   *   · 通过验收（触发进度重算与合同回写判定）；
   *   · 驳回已提交的交付物。
   *
   * 后果不是"数据不好看"：结项时已经出过结项报告并推送了飞书通知，
   * 之后再改交付物状态，会让 `recalcProgress` 重算项目进度、
   * 让 `maybeCompleteContract` 重新判定合同是否 completed ——
   * **已发出的报告与实际状态从此不一致**，而没有任何机制能发现。
   *
   * ## 为什么抽成共用方法
   *
   * 原先"只有 create 有"正是**逐处添加**这种做法的必然结果：
   * 加的人当时只想到了 create。抽成一处后，新增交付物写动作时
   * 只要调它就不会漏 —— 这也让"结项即冻结"成为一个可验证的不变量。
   */
  private async assertProjectNotClosed(projectId: string | null): Promise<void> {
    if (!projectId) return;
    const rows = await this.db
      .select({ status: erpProject.status })
      .from(erpProject)
      .where(eq(erpProject.id, projectId))
      .limit(1);
    if (rows.length === 0) return;
    if ((rows[0].status ?? '') === 'closed') {
      throw new BadRequestException(
        '项目已结项，交付物已冻结；如需调整请先反结项（项目结项报告已发出，改动会让报告与实际不一致）'
      );
    }
  }

  async submit(id: string): Promise<DeliverableItem> {
    const existing = await this.db
      .select({
        id: erpDeliverable.id,
        status: erpDeliverable.status,
        projectId: erpDeliverable.projectId,
      })
      .from(erpDeliverable)
      .where(eq(erpDeliverable.id, id));
    if (existing.length === 0) throw new NotFoundException('交付物不存在');
    // B7：结项后冻结（原先只有 create 校验，其余写动作都能绕过）
    await this.assertProjectNotClosed(existing[0].projectId);
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
    // B7：结项后冻结 —— 验收会触发进度重算与合同回写判定，绝不能发生在结项之后
    await this.assertProjectNotClosed(existing[0].projectId);
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
      .select({
        id: erpDeliverable.id,
        status: erpDeliverable.status,
        projectId: erpDeliverable.projectId,
      })
      .from(erpDeliverable)
      .where(eq(erpDeliverable.id, id));
    if (existing.length === 0) throw new NotFoundException('交付物不存在');
    // B7：结项后冻结
    await this.assertProjectNotClosed(existing[0].projectId);
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
