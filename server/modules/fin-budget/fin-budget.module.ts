import { Module } from '@nestjs/common';
import { FinBudgetController } from './fin-budget.controller';
import { FinBudgetService } from './fin-budget.service';
import { BudgetCommitmentService } from './budget-commitment.service';

@Module({
  controllers: [FinBudgetController],
  providers: [FinBudgetService, BudgetCommitmentService],
  exports: [BudgetCommitmentService],
})
export class FinBudgetModule {}
