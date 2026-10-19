import { Module } from '@nestjs/common';
import { NotificationsModule } from '@server/modules/notifications/notifications.module';
import { VoucherModule } from '@server/modules/voucher/voucher.module';
import { AdminAutomationTasksService } from './admin.automation';
import { AutomationConfigModule } from './automation-config.module';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';

@Module({
  imports: [NotificationsModule, AutomationConfigModule, VoucherModule],
  controllers: [AdminController],
  providers: [AdminService, AdminAutomationTasksService],
})
export class AdminModule {}
