import { Module } from '@nestjs/common';
import { VoucherModule } from '@server/modules/voucher/voucher.module';
import { NotificationsModule } from '@server/modules/notifications/notifications.module';
import { SystemConfigModule } from '@server/modules/system-config/system-config.module';
import { FinanceReportsController } from './finance-reports.controller';
import { ReportsService } from './reports.service';
import { LedgersService } from './ledgers.service';
import { YearEndService } from './year-end.service';
import { VatDeclarationService } from './vat-declaration.service';
import { AuxiliaryService } from './auxiliary.service';
import { TaxRiskService } from './tax-risk.service';
import { AuxCombinationService } from './aux-combination.service';
import { YearEndReminderAutomationTasksService } from './year-end-reminder.automation';

@Module({
  imports: [VoucherModule, NotificationsModule, SystemConfigModule],
  controllers: [FinanceReportsController],
  providers: [
    ReportsService,
    LedgersService,
    YearEndService,
    VatDeclarationService,
    AuxiliaryService,
    // D-06：税务风险扫描（复用 A-06 底稿作为进销项匹配的输入，不重算）
    TaxRiskService,
    // D-03：辅助核算深化（多维度组合 / 跨维度分析 / 成本分摊）
    AuxCombinationService,
    YearEndReminderAutomationTasksService,
  ],
  exports: [
    LedgersService,
    ReportsService,
    YearEndService,
    TaxRiskService,
    AuxCombinationService,
  ],
})
export class FinanceReportsModule {}
