import { Module } from '@nestjs/common';
import { VoucherController } from './voucher.controller';
import { VoucherService } from './voucher.service';
import { VoucherHookService } from './voucher-hook.service';
import { VoucherRetryAutomationTasksService } from './voucher-retry.automation';

@Module({
  controllers: [VoucherController],
  providers: [
    VoucherService,
    VoucherHookService,
    VoucherRetryAutomationTasksService,
  ],
  exports: [VoucherHookService],
})
export class VoucherModule {}
