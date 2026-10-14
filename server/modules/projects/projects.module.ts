import { Module } from '@nestjs/common';
import { NotificationsModule } from '@server/modules/notifications/notifications.module';
import { FeishuDriveModule } from '@server/modules/feishu-drive/feishu-drive.module';
import { AutomationConfigModule } from '@server/modules/admin/automation-config.module';
import { TaxModule } from '@server/modules/tax/tax.module';
import { VoucherModule } from '@server/modules/voucher/voucher.module';
import { FinanceModule } from '@server/modules/finance/finance.module';
import { DeliveryWarningAutomationTasksService } from './delivery-warning.automation';
import { ProjectArchiveService } from './project-archive.service';
import { ProjectDriveSyncAutomationTasksService } from './project-archive.automation';
import { DeliverableService } from './deliverable.service';
import { MinutesService } from './minutes.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ProjectsStatusService } from './projects-status.service';
import { ProjectAclService } from './project-acl.service';
// B-02：数据级权限（行级可见范围）。DataScopeModule 是 @Global 的，
// 这里显式声明 provider 只是为了让本模块在"未注册全局模块"时也能启动（防御性）。
import { DataScopeService } from '@server/common/auth/data-scope.service';

@Module({
  imports: [
    NotificationsModule,
    FeishuDriveModule,
    AutomationConfigModule,
    TaxModule,
    VoucherModule,
    FinanceModule,
  ],
  controllers: [ProjectsController],
  providers: [
    ProjectsService,
    ProjectsStatusService,
    DeliverableService,
    MinutesService,
    DeliveryWarningAutomationTasksService,
    ProjectArchiveService,
    ProjectDriveSyncAutomationTasksService,
    ProjectAclService,
    DataScopeService,
  ],
  exports: [ProjectAclService],
})
export class ProjectsModule {}
