import { Module } from '@nestjs/common';
import { AutomationConfigModule } from '@server/modules/admin/automation-config.module';
import { FeishuSyncController } from './feishu-sync.controller';
import { FeishuSyncService } from './feishu-sync.service';
import { FeishuSyncAutomationTasksService } from './feishu-sync.automation';

@Module({
  imports: [AutomationConfigModule],
  controllers: [FeishuSyncController],
  providers: [FeishuSyncService, FeishuSyncAutomationTasksService],
})
export class FeishuSyncModule {}
