import { Module } from '@nestjs/common';
import { VoucherController } from './voucher.controller';
import { VoucherService } from './voucher.service';
import { VoucherHookService } from './voucher-hook.service';
import { VoucherRetryAutomationTasksService } from './voucher-retry.automation';
import { AccountResolverService } from './account-resolver.service';

@Module({
  controllers: [VoucherController],
  providers: [
    VoucherService,
    VoucherHookService,
    AccountResolverService,
    VoucherRetryAutomationTasksService,
  ],
  exports: [VoucherHookService, AccountResolverService],
})
export class VoucherModule {}
