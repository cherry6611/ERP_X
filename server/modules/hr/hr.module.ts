import { Module } from '@nestjs/common';
import { VoucherModule } from '@server/modules/voucher/voucher.module';
import { HrCoreController } from './hr-core.controller';
import { HrPayController } from './hr-pay.controller';
import { HrSelfServiceController } from './hr-self-service.controller';
import { HrCoreService } from './hr-core.service';
import { HrPayService } from './hr-pay.service';
import { HrSelfServiceService } from './hr-self-service.service';

@Module({
  imports: [VoucherModule],
  controllers: [HrCoreController, HrPayController, HrSelfServiceController],
  providers: [HrCoreService, HrPayService, HrSelfServiceService],
})
export class HrModule {}
