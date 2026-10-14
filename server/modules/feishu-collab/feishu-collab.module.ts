import { Module } from '@nestjs/common';
import { FeishuDriveModule } from '@server/modules/feishu-drive/feishu-drive.module';
import { HrModule } from '@server/modules/hr/hr.module';
import { FeishuContactAutomation } from './contact.automation';
import { FeishuContactService } from './contact.service';
import { FeishuCollabController } from './collab.controller';
import { FeishuEventController } from './event.controller';
import { ApprovalCallbackService } from './approval-callback.service';

@Module({
  imports: [FeishuDriveModule, HrModule],
  controllers: [FeishuCollabController, FeishuEventController],
  providers: [
    FeishuContactService,
    FeishuContactAutomation,
    ApprovalCallbackService,
  ],
})
export class FeishuCollabModule {}
