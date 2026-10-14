import { Module } from '@nestjs/common';
import { TaxModule } from '@server/modules/tax/tax.module';
import { NotificationsModule } from '@server/modules/notifications/notifications.module';
import { SystemConfigModule } from '@server/modules/system-config/system-config.module';
import { AutomationConfigModule } from '@server/modules/admin/automation-config.module';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { ContractItemsService } from './contract-items.service';
import {
  ContractExpiryAutomationTasksService,
  ContractExpiryReminderService,
} from './contract-expiry-reminder.service';

@Module({
  imports: [TaxModule, NotificationsModule, SystemConfigModule, AutomationConfigModule],
  controllers: [ContractsController],
  providers: [
    ContractsService,
    ContractItemsService,
    // C-10：合同到期提醒（业务逻辑 + cron 触发器）
    ContractExpiryReminderService,
    ContractExpiryAutomationTasksService,
  ],
  exports: [ContractExpiryReminderService],
})
export class ContractsModule {}