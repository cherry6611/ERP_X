import { Module } from '@nestjs/common';
import { TaxModule } from '@server/modules/tax/tax.module';
import { ContractsController } from './contracts.controller';
import { ContractsService } from './contracts.service';
import { ContractItemsService } from './contract-items.service';

@Module({
  imports: [TaxModule],
  controllers: [ContractsController],
  providers: [ContractsService, ContractItemsService],
})
export class ContractsModule {}
