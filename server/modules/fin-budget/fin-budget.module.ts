import { Module } from '@nestjs/common';
import { FinBudgetController } from './fin-budget.controller';
import { FinBudgetService } from './fin-budget.service';
import { BudgetCommitmentService } from './budget-commitment.service';
import { BudgetForecastService } from './budget-forecast.service';
import { SystemConfigModule } from '@server/modules/system-config/system-config.module';

@Module({
  imports: [SystemConfigModule],
  controllers: [FinBudgetController],
  providers: [FinBudgetService, BudgetCommitmentService, BudgetForecastService],
  exports: [BudgetCommitmentService, BudgetForecastService],
})
export class FinBudgetModule {}
