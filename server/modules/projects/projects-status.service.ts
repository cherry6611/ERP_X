import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { and, eq, inArray, ne } from 'drizzle-orm';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { todayInShanghai } from '@server/common/utils/biz-date';
import {
  daDataset,
  daGrant,
  erpContract,
  erpDeliverable,
  erpProject,
  erpProjectMilestone,
} from '@server/database/schema';
import { NotificationsService } from '@server/modules/notifications/notifications.service';
import type {
  CloseProjectDto,
  Project,
  ProjectStatus,
  ProjectStatusAction,
} from '@shared/api.interface';
import { PROJECT_STATUS_FLOW, toProject } from './projects.transform';

@Injectable()
export class ProjectsStatusService {
  private readonly logger = new Logger(ProjectsStatusService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly notificationsService: NotificationsService
  ) {}

  async changeStatus(
    id: string,
    action: ProjectStatusAction,
    closeDto?: Partial<CloseProjectDto>
  ): Promise<Project> {
    const flow = PROJECT_STATUS_FLOW[action];
    if (!flow) throw new BadRequestException('非法的状态操作');
    const existing = await this.db
      .select()
      .from(erpProject)
      .where(eq(erpProject.id, id));
    if (existing.length === 0) throw new NotFoundException('项目不存在');
    const current = (existing[0].status ?? 'initiating') as ProjectStatus;
    if (!flow.from.includes(current)) {
      throw new BadRequestException(`项目状态 ${current} 不允许执行 ${action}`);
    }
    if (action === 'approve') {
      await this.validateDatasetGrants(id, existing[0].contractId);
    }
    if (action === 'deliver') {
      const deliverables = await this.db
        .select({ id: erpDeliverable.id })
        .from(erpDeliverable)
        .where(eq(erpDeliverable.projectId, id));
      if (deliverables.length === 0) {
        throw new BadRequestException('请先登记交付物清单，再发起交付');
      }
    }
    if (action === 'accept') {
      const notAccepted = await this.db
        .select({ id: erpDeliverable.id })
        .from(erpDeliverable)
        .where(
          and(
            eq(erpDeliverable.projectId, id),
            ne(erpDeliverable.status, 'accepted')
          )
        );
      if (notAccepted.length > 0) {
        throw new BadRequestException(
          `尚有 ${notAccepted.length} 项交付物未通过验收，不允许验收通过`
        );
      }
    }
    if (action === 'close') {
      const pending = await this.db
        .select({ id: erpProjectMilestone.id })
        .from(erpProjectMilestone)
        .where(
          and(
            eq(erpProjectMilestone.projectId, id),
            eq(erpProjectMilestone.status, 'pending')
          )
        );
      if (pending.length > 0) {
        throw new BadRequestException(
          `尚有 ${pending.length} 个里程碑未达成，不允许结项`
        );
      }
      const notAccepted = await this.db
        .select({ id: erpDeliverable.id })
        .from(erpDeliverable)
        .where(
          and(
            eq(erpDeliverable.projectId, id),
            ne(erpDeliverable.status, 'accepted')
          )
        );
      if (notAccepted.length > 0) {
        throw new BadRequestException(
          `尚有 ${notAccepted.length} 项交付物未通过验收，不允许结项`
        );
      }
      if (!closeDto?.closeSummary) {
        throw new BadRequestException('结项须填写结项摘要');
      }
    }
    const patch: Partial<typeof erpProject.$inferInsert> = {
      status: flow.to,
      updatedAt: new Date(),
    };
    if (action === 'close') {
      patch.closeSummary = closeDto?.closeSummary ?? null;
      patch.satisfaction = closeDto?.satisfaction ?? null;
      patch.retrospective = closeDto?.retrospective ?? null;
      patch.closedAt = new Date().toISOString().slice(0, 10);
    }
    const rows = await this.db
      .update(erpProject)
      .set(patch)
      .where(eq(erpProject.id, id))
      .returning();
    const row = rows[0];
    if (action === 'close' && row.contractId) {
      await this.tryCompleteContract(row.contractId);
    }
    if (action === 'close') {
      await this.sendCloseReportNotification(row, closeDto);
    }
    const contract = await this.db
      .select({ name: erpContract.name })
      .from(erpContract)
      .where(eq(erpContract.id, row.contractId ?? ''));
    return toProject(row, contract[0]?.name ?? '');
  }

  /** 结项后：向 admin 推送结项报告飞书通知（失败不阻塞结项，由通知服务内部容错） */
  private async sendCloseReportNotification(
    row: typeof erpProject.$inferSelect,
    closeDto: Partial<CloseProjectDto> | undefined
  ): Promise<void> {
    const lines: string[] = [
      `项目「${row.name}」（${row.code}）已结项。`,
      `满意度：${closeDto?.satisfaction ?? '未评分'}`,
      `结项摘要：${closeDto?.closeSummary ?? ''}`,
    ];
    if (closeDto?.retrospective) {
      lines.push(`复盘要点：${closeDto.retrospective}`);
    }
    lines.push('结项报告详情可在项目详情页查看，相关文档可登记云文档链接作为附件。');
    const result = await this.notificationsService.sendAdminNotification(
      `项目结项报告：${row.name}`,
      lines.join('\n')
    );
    if (result.sent) {
      this.logger.log(`结项报告飞书通知已发送 project=${row.code}`);
    }
  }

  /** 结项后：同合同下全部项目已结项时，合同回写为 completed */
  private async tryCompleteContract(contractId: string): Promise<void> {
    const siblings = await this.db
      .select({ status: erpProject.status })
      .from(erpProject)
      .where(eq(erpProject.contractId, contractId));
    const allClosed = siblings.every(
      (s: { status: string | null }) => (s.status ?? '') === 'closed'
    );
    if (!allClosed || siblings.length === 0) return;
    const updated = await this.db
      .update(erpContract)
      .set({ status: 'completed', updatedAt: new Date() })
      .where(
        and(
          eq(erpContract.id, contractId),
          inArray(erpContract.status, ['active', 'performing'])
        )
      )
      .returning({ id: erpContract.id });
    if (updated.length > 0) {
      this.logger.log(`合同 ${contractId} 下项目全部结项，已回写为 completed`);
    }
  }

  /**
   * 项目立项前置校验（数据资产授权，三期）：
   * 项目合同下存在数据集时，每个数据集都必须存在有效授权
   * （status=active 且 end_date >= 今天，且授权未绑定其他项目）；
   * 合同下无数据集则跳过校验。
   */
  private async validateDatasetGrants(
    projectId: string,
    contractId: string | null
  ): Promise<void> {
    if (!contractId) return;
    const datasets = await this.db
      .select({ id: daDataset.id, name: daDataset.name })
      .from(daDataset)
      .where(eq(daDataset.contractId, contractId));
    if (datasets.length === 0) return;
    const grants = await this.db
      .select({
        datasetId: daGrant.datasetId,
        projectId: daGrant.projectId,
        endDate: daGrant.endDate,
        status: daGrant.status,
      })
      .from(daGrant)
      .where(
        inArray(
          daGrant.datasetId,
          datasets.map((d: { id: string; name: string }) => d.id)
        )
      );
    const today = todayInShanghai();
    const missing: string[] = [];
    for (const dataset of datasets) {
      const hasValidGrant = grants.some(
        (g: {
          datasetId: string | null;
          projectId: string | null;
          endDate: string | null;
          status: string | null;
        }) =>
          g.datasetId === dataset.id &&
          (g.status ?? '') === 'active' &&
          g.endDate !== null &&
          g.endDate >= today &&
          (!g.projectId || g.projectId === projectId)
      );
      if (!hasValidGrant) missing.push(dataset.name);
    }
    if (missing.length > 0) {
      throw new BadRequestException(
        `以下数据集缺少有效授权，不允许立项：${missing.join('、')}`
      );
    }
  }
}
