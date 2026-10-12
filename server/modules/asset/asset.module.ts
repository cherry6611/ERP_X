import { Module } from '@nestjs/common';
import { VoucherModule } from '@server/modules/voucher/voucher.module';
import { AssetController } from './asset.controller';
import { AssetService } from './asset.service';
import { AssetDepreciationService } from './asset-depreciation.service';

@Module({
  imports: [VoucherModule],
  controllers: [AssetController],
  providers: [AssetService, AssetDepreciationService],
})
export class AssetModule {}
