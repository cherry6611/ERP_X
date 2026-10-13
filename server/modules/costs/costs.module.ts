import { Module } from '@nestjs/common';
import { VoucherModule } from '@server/modules/voucher/voucher.module';
import { CostsController } from './costs.controller';
import { CostsService } from './costs.service';

@Module({
  imports: [VoucherModule],
  controllers: [CostsController],
  providers: [CostsService],
})
export class CostsModule {}
