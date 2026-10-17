import { Module } from '@nestjs/common';
import { VoucherModule } from '@server/modules/voucher/voucher.module';
import { TaxModule } from '@server/modules/tax/tax.module';
import { NotificationsModule } from '@server/modules/notifications/notifications.module';
import { AutomationConfigModule } from '@server/modules/admin/automation-config.module';
import { AuditModule } from '@server/modules/audit/audit.module';
// B-02：数据级权限（应收/应付/发票按纳税主体与部门行级隔离）
import { DataScopeService } from '@server/common/auth/data-scope.service';
import { FinanceController } from './finance.controller';
import { ArService } from './ar.service';
import { ApService } from './ap.service';
import { CashFlowService } from './cash-flow.service';
import { InvoiceService } from './invoice.service';
import { FinanceService } from './finance.service';
import { VendorSettlementService } from './vendor-settlement.service';
import { ArReminderAutomationTasksService } from './ar-reminder.automation';
import { ReconciliationService } from './reconciliation.service';
import { StatementService } from './statement.service';
import { InvoiceVerifyService } from './invoice-verify.service';
import {
  INVOICE_VERIFY_PROVIDER,
  createInvoiceVerifyProvider,
} from './invoice-verify.providers';

@Module({
  imports: [
    VoucherModule,
    NotificationsModule,
    AutomationConfigModule,
    TaxModule,
    // C-01：审计留痕依赖 AuditService
    AuditModule,
  ],
  controllers: [FinanceController],
  providers: [
    ArService,
    ApService,
    CashFlowService,
    InvoiceService,
    FinanceService,
    VendorSettlementService,
    ArReminderAutomationTasksService,
    ReconciliationService,
    // C-11：客户/供应商对账单（读既有 AR/AP/回款/付款/发票表，无新增迁移）
    StatementService,
    DataScopeService,
    // C-01：发票查验与勾选认证
    InvoiceVerifyService,
    {
      provide: INVOICE_VERIFY_PROVIDER,
      useFactory: () => createInvoiceVerifyProvider(),
    },
  ],
  // P0-C/P0-D：退货、收入冲回等模块需要复用它登记红字发票（负数发票）。
  // 导出而不是让各模块各写一份 INSERT：红字发票的幂等键、负数落账口径、
  // 认证状态联动都必须在**一处**，否则"账表对齐"又会分叉成多份实现。
  exports: [ArService, InvoiceService],
})
export class FinanceModule {}
