import { Module } from '@nestjs/common';
import { FinanceModule } from '@server/modules/finance/finance.module';
import { TaxModule } from '@server/modules/tax/tax.module';
import { VoucherModule } from '@server/modules/voucher/voucher.module';
import { RevenuesController } from './revenues.controller';
import { RevenuesService } from './revenues.service';

@Module({
  imports: [FinanceModule, TaxModule, VoucherModule],
  controllers: [RevenuesController],
  providers: [RevenuesService],
})
export class RevenuesModule {}
