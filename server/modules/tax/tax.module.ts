import { Module } from '@nestjs/common';
import { TaxEntityController } from './tax-entity.controller';
import { TaxEntityService } from './tax-entity.service';
import { TaxResolverService } from './tax-resolver.service';

@Module({
  controllers: [TaxEntityController],
  providers: [TaxEntityService, TaxResolverService],
  exports: [TaxEntityService, TaxResolverService],
})
export class TaxModule {}
