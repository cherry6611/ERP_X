import { Module } from '@nestjs/common';
import { AttachmentModule } from '@server/modules/attachment/attachment.module';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';

@Module({
  imports: [AttachmentModule],
  controllers: [FilesController],
  providers: [FilesService],
  exports: [FilesService],
})
export class FilesModule {}
