import { Logger } from '@nestjs/common';
import { Automation, BindTrigger } from '@server/platform';
import { VoucherHookService } from './voucher-hook.service';

@Automation()
export class VoucherRetryAutomationTasksService {
  private readonly logger = new Logger(VoucherRetryAutomationTasksService.name);

  constructor(private readonly voucherHook: VoucherHookService) {}

  @BindTrigger('voucher_job_retry')
  async retryFailedVouchers(): Promise<void> {
    const result = await this.voucherHook.retryPendingJobs(30);
    this.logger.log(
      `凭证失败队列重试完成 retried=${result.retried} dead=${result.dead} deadSourceRefs=${result.deadSourceRefs.join(',')}`
    );
  }
}
