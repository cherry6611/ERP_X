import { Module } from '@nestjs/common';
import { ProjectsModule } from '@server/modules/projects/projects.module';
import { NotificationsModule } from '@server/modules/notifications/notifications.module';
import { AutomationConfigModule } from '@server/modules/admin/automation-config.module';
import { BiController } from './bi.controller';
import { BiService } from './bi.service';
import { BiMetricsService } from './bi-metrics.service';
import { BiAlertAutomationTasksService } from './bi-alert.automation';

@Module({
  imports: [ProjectsModule, NotificationsModule, AutomationConfigModule],
  controllers: [BiController],
  providers: [BiService, BiMetricsService, BiAlertAutomationTasksService],
  exports: [BiMetricsService],
})
export class BiModule {}
