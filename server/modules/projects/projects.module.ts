import { Module } from '@nestjs/common';
import { NotificationsModule } from '@server/modules/notifications/notifications.module';
import { FeishuDriveModule } from '@server/modules/feishu-drive/feishu-drive.module';
import { AutomationConfigModule } from '@server/modules/admin/automation-config.module';
import { TaxModule } from '@server/modules/tax/tax.module';
import { VoucherModule } from '@server/modules/voucher/voucher.module';
import { DeliveryWarningAutomationTasksService } from './delivery-warning.automation';
import { ProjectArchiveService } from './project-archive.service';
import { ProjectDriveSyncAutomationTasksService } from './project-archive.automation';
import { DeliverableService } from './deliverable.service';
import { MinutesService } from './minutes.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { ProjectsStatusService } from './projects-status.service';
import { ProjectAclService } from './project-acl.service';

@Module({
  imports: [
    NotificationsModule,
    FeishuDriveModule,
    AutomationConfigModule,
    TaxModule,
    VoucherModule,
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
  ],
  exports: [ProjectAclService],
})
export class ProjectsModule {}
