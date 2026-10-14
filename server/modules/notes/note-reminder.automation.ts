import { Logger } from '@nestjs/common';
import { Automation, BindTrigger } from '@server/platform';
import { AutomationConfigService } from '@server/modules/admin/automation-config.service';
import { NotificationsService } from '@server/modules/notifications/notifications.service';
import { NoteService } from './note.service';

/**
 * C-04 / D-02：票据到期提醒（每日 09:00，业务时区 Asia/Shanghai）。
 *
 * 为什么需要：银行承兑汇票贴现需要 2–3 个工作日审批，加上内部用印与走款，
 * 15 天是可操作的最短窗口。逾期未处理的票据会进入拒付/追索流程，
 * 直接影响现金流与信用记录，因此必须主动提醒而不是等财务自己看备查簿。
 *
 * 与全仓 cron 范式一致：
 * - 通过 `comp_automation_config` 的 `note_due_reminder_daily` 总开关可停用；
 * - 通知在事务外发送（外部 IO 禁止在事务内）；
 * - 通知失败只记 error，不抛出（避免调度器把整个任务标失败）。
 */
@Automation()
export class NoteReminderAutomationTasksService {
  private readonly logger = new Logger(NoteReminderAutomationTasksService.name);

  constructor(
    private readonly noteService: NoteService,
    private readonly notifications: NotificationsService,
    private readonly automationConfigService: AutomationConfigService
  ) {}

  @BindTrigger('note_due_reminder_daily')
  async remindDueNotes(): Promise<void> {
    if (
      !(await this.automationConfigService.isEnabled('note_due_reminder_daily'))
    ) {
      return;
    }
    try {
      const alerts = await this.noteService.dueAlerts();
      if (alerts.length === 0) {
        this.logger.log('票据到期提醒：无临期或逾期票据');
        return;
      }
      const overdue = alerts.filter((alert) => alert.level === 'overdue');
      const title =
        overdue.length > 0
          ? `【票据预警】${overdue.length} 张逾期、${alerts.length - overdue.length} 张临期`
          : `【票据提醒】${alerts.length} 张票据临近到期`;
      await this.notifications.sendAdminNotification(
        title,
        this.noteService.buildAlertText(alerts)
      );
      this.logger.log(
        `票据到期提醒已发送 共=${alerts.length} 逾期=${overdue.length}`
      );
    } catch (error) {
      this.logger.error(
        `票据到期提醒失败：${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
}
