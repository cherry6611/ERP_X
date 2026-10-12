import { Logger } from '@nestjs/common';
import { Automation, BindTrigger } from '@server/platform';
import { AutomationConfigService } from '@server/modules/admin/automation-config.service';
import { FeishuSyncService } from './feishu-sync.service';

@Automation()
export class FeishuSyncAutomationTasksService {
  private readonly logger = new Logger(FeishuSyncAutomationTasksService.name);

  constructor(
    private readonly feishuSyncService: FeishuSyncService,
    private readonly automationConfigService: AutomationConfigService
  ) {}

  @BindTrigger('feishu_daily_sync')
  async runDailySync(): Promise<void> {
    if (!(await this.automationConfigService.isEnabled('feishu_daily_sync'))) {
      this.logger.log('任务已停用，跳过：feishu_daily_sync');
      return;
    }
    this.logger.log('飞书多维表格每日同步开始');
    try {
      const costResult = await this.feishuSyncService.syncCostsToBase();
      this.logger.log(`成本出向：${costResult.message}`);
    } catch (error: unknown) {
      const stack: string =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.logger.error(`成本出向同步失败：${stack}`);
    }
    try {
      const contractResult = await this.feishuSyncService.syncContractsToBase();
      this.logger.log(`合同出向：${contractResult.message}`);
    } catch (error: unknown) {
      const stack: string =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.logger.error(`合同出向同步失败：${stack}`);
    }
    try {
      const timesheetResult =
        await this.feishuSyncService.syncTimesheetsFromBase();
      this.logger.log(`工时入向：${timesheetResult.message}`);
    } catch (error: unknown) {
      const stack: string =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.logger.error(`工时入向同步失败：${stack}`);
    }
    this.logger.log('飞书多维表格每日同步结束');
  }
}
