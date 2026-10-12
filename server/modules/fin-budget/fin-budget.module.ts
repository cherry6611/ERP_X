import { Module } from '@nestjs/common';
import { FinBudgetController } from './fin-budget.controller';
import { FinBudgetService } from './fin-budget.service';

@Module({
  controllers: [FinBudgetController],
  providers: [FinBudgetService],
})
export class FinBudgetModule {}
