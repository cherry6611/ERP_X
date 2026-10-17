import { Module } from '@nestjs/common';
import { VoucherModule } from '@server/modules/voucher/voucher.module';
import { ProjectsModule } from '@server/modules/projects/projects.module';
import { CostsController } from './costs.controller';
import { CostsService } from './costs.service';

@Module({
  imports: [VoucherModule, ProjectsModule],
  controllers: [CostsController],
  providers: [CostsService],
})
export class CostsModule {}
