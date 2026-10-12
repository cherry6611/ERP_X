import { Module } from '@nestjs/common';
import { VoucherModule } from '@server/modules/voucher/voucher.module';
import { FinExpenseController } from './fin-expense.controller';
import { FinExpenseService } from './fin-expense.service';

@Module({
  imports: [VoucherModule],
  controllers: [FinExpenseController],
  providers: [FinExpenseService],
})
export class FinExpenseModule {}
