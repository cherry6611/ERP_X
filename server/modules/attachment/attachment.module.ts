import { Module } from '@nestjs/common';
import { ProjectsModule } from '@server/modules/projects/projects.module';
import { AttachmentController } from './attachment.controller';
import { AttachmentService } from './attachment.service';
import { ResourceAclService } from './resource-acl.service';

@Module({
  imports: [ProjectsModule],
  controllers: [AttachmentController],
  providers: [AttachmentService, ResourceAclService],
})
export class AttachmentModule {}
