import { Module } from '@nestjs/common';
import { FinanceModule } from '@server/modules/finance/finance.module';
import { RevenuesController } from './revenues.controller';
import { RevenuesService } from './revenues.service';

@Module({
  imports: [FinanceModule],
  controllers: [RevenuesController],
  providers: [RevenuesService],
})
export class RevenuesModule {}
