import { Module } from '@nestjs/common';
import { FeishuClientService } from './feishu-client.service';
import { DriveConfigService } from './drive-config.service';
import { DriveController } from './drive.controller';
import { DriveService } from './drive.service';
import { WikiController } from './wiki.controller';
import { WikiService } from './wiki.service';

@Module({
  controllers: [DriveController, WikiController],
  providers: [FeishuClientService, DriveConfigService, DriveService, WikiService],
  exports: [FeishuClientService, DriveConfigService, DriveService, WikiService],
})
export class FeishuDriveModule {}
