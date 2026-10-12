import { Inject, Logger } from '@nestjs/common';
import { and, inArray, lt, ne, sql } from 'drizzle-orm';
import {
  Automation,
  BindTrigger,
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { erpProject, erpProjectCost, erpProjectMilestone } from '@server/database/schema';
import { computeEvm } from '@server/common/utils/evm';
import { todayInShanghai } from '@server/common/utils/biz-date';
import { NotificationsService } from '@server/modules/notifications/notifications.service';
import { AutomationConfigService } from '@server/modules/admin/automation-config.service';
import dayjs from 'dayjs';

const WARNING_AHEAD_DAYS = 7;
const EVM_WARN_THRESHOLD = 0.9;

interface ProjectRow {
  id: string;
  code: string;
  name: string;
  pm: string | null;
  budget: string | null;
}

interface MilestoneRow {
  projectId: string | null;
  name: string;
  status: string | null;
  weightPct: string | null;
  baselineDate: string | null;
  forecastDate: string | null;
}

@Automation()
export class DeliveryWarningAutomationTasksService {
  private readonly logger = new Logger(DeliveryWarningAutomationTasksService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly notificationsService: NotificationsService,
    private readonly automationConfigService: AutomationConfigService
  ) {}

  @BindTrigger('delivery_warning_weekly')
  async warnDelivery(): Promise<void> {
    if (!(await this.automationConfigService.isEnabled('delivery_warning_weekly'))) {
      this.logger.log('任务已停用，跳过：delivery_warning_weekly');
      return;
    }
    const today: string = todayInShanghai();
    const horizon: string = dayjs(today)
      .add(WARNING_AHEAD_DAYS, 'day')
      .format('YYYY-MM-DD');
    this.logger.log(`项目交付周预警扫描开始 today=${today} horizon=${horizon}`);

    const projects: ProjectRow[] = await this.db
      .select({
        id: erpProject.id,
        code: erpProject.code,
        name: erpProject.name,
        pm: erpProject.pm,
        budget: erpProject.budget,
      })
      .from(erpProject)
      .where(ne(erpProject.status, 'closed'));
    if (projects.length === 0) {
      this.logger.log('项目交付周预警扫描结束：无未结项项目');
      return;
    }
    const projectIds: string[] = projects.map((p: ProjectRow) => p.id);

    const milestones: MilestoneRow[] = await this.db
      .select({
        projectId: erpProjectMilestone.projectId,
        name: erpProjectMilestone.name,
        status: erpProjectMilestone.status,
        weightPct: erpProjectMilestone.weightPct,
        baselineDate: erpProjectMilestone.baselineDate,
        forecastDate: erpProjectMilestone.forecastDate,
      })
      .from(erpProjectMilestone)
      .where(inArray(erpProjectMilestone.projectId, projectIds));

    const costRows: Array<{ projectId: string | null; total: string | null }> =
      await this.db
        .select({
          projectId: erpProjectCost.projectId,
          total: sql<string>`coalesce(sum(${erpProjectCost.amount}), 0)`,
        })
        .from(erpProjectCost)
        .where(inArray(erpProjectCost.projectId, projectIds))
        .groupBy(erpProjectCost.projectId);
    const costMap = new Map<string, number>();
    for (const row of costRows) {
      costMap.set(row.projectId ?? '', Number(row.total ?? 0));
    }

    const overdueLines: string[] = [];
    const dueSoonLines: string[] = [];
    const evmWarnLines: string[] = [];

    for (const project of projects) {
      const pmLabel: string = project.pm ? `（PM：${project.pm}）` : '';
      const projectMilestones = milestones.filter(
        (m: MilestoneRow) => m.projectId === project.id
      );
      for (const m of projectMilestones) {
        if ((m.status ?? 'pending') === 'reached' || m.forecastDate === null) {
          continue;
        }
        if (m.forecastDate < today) {
          const daysOver: number = dayjs(today).diff(dayjs(m.forecastDate), 'day');
          overdueLines.push(
            `- ${project.code} ${project.name}${pmLabel}：里程碑「${m.name}」已逾期 ${daysOver} 天（预测 ${m.forecastDate}）`
          );
        } else if (m.forecastDate <= horizon) {
          dueSoonLines.push(
            `- ${project.code} ${project.name}${pmLabel}：里程碑「${m.name}」将于 ${m.forecastDate} 到期`
          );
        }
      }
      const budget: number = Number(project.budget ?? 0);
      const actualCost: number = costMap.get(project.id) ?? 0;
      const evm = computeEvm(budget, actualCost, projectMilestones, today);
      const warnParts: string[] = [];
      if (evm.spi !== null && evm.spi < EVM_WARN_THRESHOLD) {
        warnParts.push(`SPI=${evm.spi}`);
      }
      if (evm.cpi !== null && evm.cpi < EVM_WARN_THRESHOLD) {
        warnParts.push(`CPI=${evm.cpi}`);
      }
      if (warnParts.length > 0) {
        evmWarnLines.push(
          `- ${project.code} ${project.name}${pmLabel}：${warnParts.join('、')}，进度/成本绩效低于 0.9，请评估交付风险`
        );
      }
    }

    const sections: string[] = [];
    if (overdueLines.length > 0) {
      sections.push(`**逾期里程碑（${overdueLines.length}）**\n${overdueLines.join('\n')}`);
    }
    if (dueSoonLines.length > 0) {
      sections.push(
        `**未来 ${WARNING_AHEAD_DAYS} 天内到期里程碑（${dueSoonLines.length}）**\n${dueSoonLines.join('\n')}`
      );
    }
    if (evmWarnLines.length > 0) {
      sections.push(
        `**进度/成本绩效预警（${evmWarnLines.length}）**\n${evmWarnLines.join('\n')}`
      );
    }
    const hitCount: number =
      overdueLines.length + dueSoonLines.length + evmWarnLines.length;
    if (hitCount === 0) {
      this.logger.log('项目交付周预警扫描结束：无命中预警');
      return;
    }
    const content: string = `本周项目交付预警（命中 ${hitCount} 项）：\n${sections.join('\n\n')}`;
    try {
      const result = await this.notificationsService.sendAdminNotification(
        '项目交付周预警',
        content
      );
      this.logger.log(
        `项目交付周预警发送结束：命中=${hitCount} sent=${result.sent} reason=${result.reason ?? '-'}`
      );
    } catch (error: unknown) {
      const stack: string =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.logger.error(`项目交付周预警发送失败 命中=${hitCount}`, stack);
    }
  }
}
