import { Module } from '@nestjs/common';
import { NotificationsModule } from '@server/modules/notifications/notifications.module';
import { AdminAutomationTasksService } from './admin.automation';
import { AutomationConfigModule } from './automation-config.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [NotificationsModule, AutomationConfigModule],
  controllers: [AdminController],
  providers: [AdminService, AdminAutomationTasksService],
})
export class AdminModule {}
