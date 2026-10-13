import { Module } from '@nestjs/common';
import { VoucherModule } from '@server/modules/voucher/voucher.module';
import { TaxModule } from '@server/modules/tax/tax.module';
import { NotificationsModule } from '@server/modules/notifications/notifications.module';
import { AutomationConfigModule } from '@server/modules/admin/automation-config.module';
import { FinanceController } from './finance.controller';
import { ArService } from './ar.service';
import { ApService } from './ap.service';
import { CashFlowService } from './cash-flow.service';
import { InvoiceService } from './invoice.service';
import { FinanceService } from './finance.service';
import { VendorSettlementService } from './vendor-settlement.service';
import { ArReminderAutomationTasksService } from './ar-reminder.automation';

@Module({
  imports: [VoucherModule, NotificationsModule, AutomationConfigModule, TaxModule],
  controllers: [FinanceController],
  providers: [
    ArService,
    ApService,
    CashFlowService,
    InvoiceService,
    FinanceService,
    VendorSettlementService,
    ArReminderAutomationTasksService,
  ],
  exports: [ArService],
})
export class FinanceModule {}
