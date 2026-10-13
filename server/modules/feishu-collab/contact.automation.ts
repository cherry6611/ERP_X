import { Logger } from '@nestjs/common';
import { Automation, BindTrigger } from '@server/platform';
import { FeishuContactService } from './contact.service';

@Automation()
export class FeishuContactAutomation {
  private readonly logger = new Logger(FeishuContactAutomation.name);

  constructor(private readonly contact: FeishuContactService) {}

  @BindTrigger('feishu_contact_full')
  async full(): Promise<void> {
    const result = await this.contact.fullSync();
    this.logger.log(`通讯录全量同步 departments=${result.departments} users=${result.users} conflicts=${result.conflicts}`);
  }

  @BindTrigger('feishu_contact_incremental')
  async incremental(): Promise<void> {
    const result = await this.contact.incrementalSync();
    this.logger.log(`通讯录增量同步 users=${result.users} conflicts=${result.conflicts}`);
  }
}
