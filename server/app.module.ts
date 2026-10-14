import { APP_FILTER } from '@nestjs/core';
import { Module } from '@nestjs/common';
import { PlatformModule } from './platform';
import { ActorAccessModule } from './common/auth/actor-access.module';

import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { FilesModule } from './modules/files/files.module';
import { DirectoryModule } from './modules/directory/directory.module';
import { GlobalExceptionFilter } from './common/filters/exception.filter';
import { ViewModule } from './modules/view/view.module';
import { MasterDataModule } from './modules/master-data/master-data.module';
import { TaxModule } from './modules/tax/tax.module';
import { CrmModule } from './modules/crm/crm.module';
import { ContractsModule } from './modules/contracts/contracts.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { CostsModule } from './modules/costs/costs.module';
import { RevenuesModule } from './modules/revenues/revenues.module';
import { FinanceModule } from './modules/finance/finance.module';
import { FinanceReportsModule } from './modules/finance-reports/finance-reports.module';
import { BiModule } from './modules/bi/bi.module';
import { AuditModule } from './modules/audit/audit.module';
import { HrModule } from './modules/hr/hr.module';
import { IdentityModule } from './modules/identity/identity.module';
import { SettingsModule } from './modules/settings/settings.module';
import { FinBudgetModule } from './modules/fin-budget/fin-budget.module';
import { FinExpenseModule } from './modules/fin-expense/fin-expense.module';
import { PurModule } from './modules/pur/pur.module';
import { AssetModule } from './modules/asset/asset.module';
import { VoucherModule } from './modules/voucher/voucher.module';
import { DataAssetModule } from './modules/data-asset/data-asset.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AttachmentModule } from './modules/attachment/attachment.module';
import { FeishuSyncModule } from './modules/feishu-sync/feishu-sync.module';
import { FeishuDriveModule } from './modules/feishu-drive/feishu-drive.module';
import { FeishuCollabModule } from './modules/feishu-collab/feishu-collab.module';
import { AdminModule } from './modules/admin/admin.module';
import { AutomationConfigModule } from './modules/admin/automation-config.module';
import { SemanticModule } from './modules/semantic/semantic.module';
import { SystemConfigModule } from './modules/system-config/system-config.module';
import { IntegrationsModule } from './modules/integrations/integrations.module';
// C-04 / D-02：应收应付票据（独立模块：自带状态机、备查簿与到期预警）
import { NoteModule } from './modules/notes/note.module';

@Module({
  imports: [
    // 平台 Module，提供平台能力
    PlatformModule.forRoot(),
    ActorAccessModule,
    AuthModule,
    HealthModule,
    FilesModule,
    DirectoryModule,
    // ====== @route-section: business-modules START ======
    MasterDataModule,
    TaxModule,
    CrmModule,
    ContractsModule,
    ProjectsModule,
    CostsModule,
    RevenuesModule,
    FinanceModule,
    FinanceReportsModule,
    BiModule,
    AuditModule,
    HrModule,
    IdentityModule,
    SettingsModule,
    FinBudgetModule,
    FinExpenseModule,
    PurModule,
    AssetModule,
    VoucherModule,
    DataAssetModule,
    NotificationsModule,
    AttachmentModule,
    FeishuSyncModule,
    FeishuDriveModule,
    FeishuCollabModule,
    AdminModule,
    AutomationConfigModule,
    SemanticModule,
    SystemConfigModule,
    IntegrationsModule,
    NoteModule,
    // ====== @route-section: business-modules END ======

    // ⚠️ @route-order: last
    // ViewModule is the fallback route module, must be registered last.
    ViewModule,
  ],
  providers: [
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
  ],
})
export class AppModule {}
