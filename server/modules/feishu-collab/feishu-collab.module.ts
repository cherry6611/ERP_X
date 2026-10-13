import { Module } from '@nestjs/common';
import { FeishuDriveModule } from '@server/modules/feishu-drive/feishu-drive.module';
import { FeishuContactAutomation } from './contact.automation';
import { FeishuContactService } from './contact.service';
import { FeishuCollabController } from './collab.controller';
import { FeishuEventController } from './event.controller';

@Module({
  imports: [FeishuDriveModule],
  controllers: [FeishuCollabController, FeishuEventController],
  providers: [FeishuContactService, FeishuContactAutomation],
})
export class FeishuCollabModule {}
