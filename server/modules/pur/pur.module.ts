import { Module } from '@nestjs/common';
import { TaxModule } from '@server/modules/tax/tax.module';
import { VoucherModule } from '@server/modules/voucher/voucher.module';
import { PurController } from './pur.controller';
import { PurService } from './pur.service';

@Module({
  imports: [VoucherModule, TaxModule],
  controllers: [PurController],
  providers: [PurService],
})
export class PurModule {}
