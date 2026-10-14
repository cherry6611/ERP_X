import { Module } from '@nestjs/common';
import { ProjectsModule } from '@server/modules/projects/projects.module';
import { FeishuDriveModule } from '@server/modules/feishu-drive/feishu-drive.module';
import { AttachmentController } from './attachment.controller';
import { AttachmentService } from './attachment.service';
import { FeishuDocParseService } from './feishu-doc-parse.service';
import { ResourceAclService } from './resource-acl.service';

@Module({
  imports: [ProjectsModule, FeishuDriveModule],
  controllers: [AttachmentController],
  providers: [AttachmentService, FeishuDocParseService, ResourceAclService],
})
export class AttachmentModule {}
