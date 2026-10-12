import { Module } from '@nestjs/common';
import { DataAssetController } from './data-asset.controller';
import { DataAssetService } from './data-asset.service';

@Module({
  controllers: [DataAssetController],
  providers: [DataAssetService],
})
export class DataAssetModule {}
