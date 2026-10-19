import { Module } from '@nestjs/common';
import { ProjectsModule } from '@server/modules/projects/projects.module';
import { DataAssetController } from './data-asset.controller';
import { DataAssetService } from './data-asset.service';

@Module({
  imports: [ProjectsModule],
  controllers: [DataAssetController],
  providers: [DataAssetService],
})
export class DataAssetModule {}
