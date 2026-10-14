import { Module } from '@nestjs/common';
import { VoucherModule } from '@server/modules/voucher/voucher.module';
import { NotificationsModule } from '@server/modules/notifications/notifications.module';
import { AutomationConfigModule } from '@server/modules/admin/automation-config.module';
import { NoteController } from './note.controller';
import { NoteService } from './note.service';
import { NoteReminderAutomationTasksService } from './note-reminder.automation';

/**
 * C-04 / D-02：应收应付票据。
 *
 * 独立成模块（而不是塞进 `finance`）的原因：
 * 票据有自己的状态机、备查簿与到期预警，且 `finance.controller.ts` 已经很大；
 * 挂在 `api/notes` 下也让 C-04（票据）与 D-02（备查簿深化）的边界更清晰。
 */
@Module({
  imports: [VoucherModule, NotificationsModule, AutomationConfigModule],
  controllers: [NoteController],
  providers: [NoteService, NoteReminderAutomationTasksService],
  exports: [NoteService],
})
export class NoteModule {}
