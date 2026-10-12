import { Inject, Logger } from '@nestjs/common';
import { ne } from 'drizzle-orm';
import {
  Automation,
  BindTrigger,
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { erpProject } from '@server/database/schema';
import { ProjectArchiveService } from './project-archive.service';
import { AutomationConfigService } from '@server/modules/admin/automation-config.service';

interface OpenProjectRow {
  id: string;
  name: string;
}

@Automation()
export class ProjectDriveSyncAutomationTasksService {
  private readonly logger = new Logger(ProjectDriveSyncAutomationTasksService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly projectArchiveService: ProjectArchiveService,
    private readonly automationConfigService: AutomationConfigService
  ) {}

  @BindTrigger('project_drive_sync_daily')
  async syncProjectDriveDaily(): Promise<void> {
    if (
      !(await this.automationConfigService.isEnabled('project_drive_sync_daily'))
    ) {
      this.logger.log('任务已停用，跳过：project_drive_sync_daily');
      return;
    }
    const projects: OpenProjectRow[] = await this.db
      .select({ id: erpProject.id, name: erpProject.name })
      .from(erpProject)
      .where(ne(erpProject.status, 'closed'));

    let successCount = 0;
    let failedCount = 0;
    const CONCURRENCY = 3;
    for (let i = 0; i < projects.length; i += CONCURRENCY) {
      const batch: OpenProjectRow[] = projects.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (project: OpenProjectRow) => {
          try {
            const result = await this.projectArchiveService.syncProjectFiles(
              project.id
            );
            successCount += 1;
            this.logger.log(
              `项目文件云归档同步完成 project=${project.name} synced=${String(result.syncedFiles)} skipped=${String(result.skippedFiles)} failed=${String(result.failedFiles)}`,
            );
          } catch (error: unknown) {
            failedCount += 1;
            const stack: string =
              error instanceof Error ? (error.stack ?? error.message) : String(error);
            this.logger.error(`项目文件云归档同步失败 project=${project.name}`, stack);
          }
        })
      );
    }
    this.logger.log(
      `项目文件云归档同步全部完成 total=${String(projects.length)} success=${String(successCount)} failed=${String(failedCount)}`,
    );
  }
}
