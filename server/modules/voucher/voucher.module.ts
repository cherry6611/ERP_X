import { Module } from '@nestjs/common';
import { VoucherController } from './voucher.controller';
import { VoucherService } from './voucher.service';
import { VoucherHookService } from './voucher-hook.service';

@Module({
  controllers: [VoucherController],
  providers: [VoucherService, VoucherHookService],
  exports: [VoucherHookService],
})
export class VoucherModule {}
