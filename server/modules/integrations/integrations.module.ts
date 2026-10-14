import { Module } from '@nestjs/common';
import { FinanceReportsModule } from '@server/modules/finance-reports/finance-reports.module';
import { BankAccountService } from './bank/bank-account.service';
import { BankImportMappingService } from './bank/bank-import-mapping.service';
import { BankStatementService } from './bank/bank-statement.service';
import { BankReconciliationService } from './bank/bank-reconciliation.service';
import { BankController } from './bank/bank.controller';
import { ExportsController } from './exports/exports.controller';
import { ExportsService } from './exports/exports.service';
import { TasksController } from './tasks/tasks.controller';
import { TasksService } from './tasks/tasks.service';
import { OpenApiController } from './openapi/openapi.controller';

/**
 * 批次二集成模块（C-02 银行账户与流水 / C-03 银企对账 / C-07 异步导出 / C-08 待办中心 / C-12 OpenAPI）。
 *
 * 自包含：数据库连接由全局 PlatformModule 提供；账套取数复用 FinanceReportsModule 导出的
 * LedgersService（因此这里 import FinanceReportsModule）。
 *
 * 挂在 server/app.module.ts 需两行（由主 agent 维护聚合文件，此处不修改）：
 *   import { IntegrationsModule } from './modules/integrations/integrations.module';
 *   IntegrationsModule,   // 加进 imports 数组
 */
@Module({
  imports: [FinanceReportsModule],
  controllers: [
    BankController,
    ExportsController,
    TasksController,
    OpenApiController,
  ],
  providers: [
    BankAccountService,
    BankImportMappingService,
    BankStatementService,
    BankReconciliationService,
    ExportsService,
    TasksService,
  ],
  exports: [BankAccountService, BankStatementService, BankReconciliationService, ExportsService],
})
export class IntegrationsModule {}
