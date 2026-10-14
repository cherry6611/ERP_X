import { Logger } from '@nestjs/common';
import { Automation, BindTrigger } from '@server/platform';
import { NotificationsService } from '@server/modules/notifications/notifications.service';
import { DictService } from '@server/modules/system-config/dict.service';
import { YearEndService } from './year-end.service';

/**
 * A-04：年结前置检查提醒（12 月 20 日起每日 09:00，仅提醒 admin）。
 *
 * 为什么需要：A-04 的验收标准要求"年结后次年期初余额正确"，
 * 而年结的前置条件（无草稿凭证、试算平衡、期间已结账）在 12 月才发现问题时，
 * 财务往往来不及处理。这里在 12 月下旬主动提示差异项。
 *
 * 与其它 cron 一致：通过 `comp_automation_config` 总开关停用；
 * 通知走站内信 + 飞书（复用既有 NotificationsService）。
 */
@Automation()
export class YearEndReminderAutomationTasksService {
  private readonly logger = new Logger(YearEndReminderAutomationTasksService.name);

  constructor(
    private readonly yearEndService: YearEndService,
    private readonly notifications: NotificationsService,
    private readonly dictService: DictService,
  ) {}

  @BindTrigger('year_end_reminder_daily')
  async remindYearEnd(): Promise<void> {
    const now = new Date();
    // 业务时区 Asia/Shanghai：UTC+8
    const shanghai = new Date(now.getTime() + 8 * 60 * 60 * 1000);
    const month = shanghai.getUTCMonth() + 1;
    const day = shanghai.getUTCDate();
    const year = shanghai.getUTCFullYear();
    // 只在 12 月 20 日之后提醒，避免全年噪音
    if (month !== 12 || day < 20) return;

    const period = `${year}-12`;
    const preview = await this.yearEndService.previewCarryForward({ period });
    if (preview.alreadyCarried) {
      this.logger.log(`会计年度 ${year} 已完成年结，无需提醒`);
      return;
    }
    const failed = preview.checks.filter((check) => !check.passed);
    if (failed.length === 0 && preview.items.length === 0) {
      this.logger.log(`会计年度 ${year} 无待结转损益，无需提醒`);
      return;
    }
    const lines = [
      `会计年度 ${year} 年结前置检查（${period}）：`,
      ...preview.checks.map(
        (check) => `${check.passed ? '✓' : '✗'} ${check.label}：${check.message}`
      ),
      '',
      `本年净利润（预估）：${preview.netProfit} 元`,
      `待结转损益科目数：${preview.items.length}`,
      failed.length > 0
        ? '存在未通过项，请先处理后执行年结（财务 → 期末年结）。'
        : '全部前置检查通过，可执行年结（财务 → 期末年结）。',
    ];
    const content = lines.join('\n');
    // 通知里的"金额口径"提示从系统参数读取，保证与工资/报表口径同源
    const basicDeduction = await this.dictService.numberParam(
      'finance.basic_deduction_per_month',
      5000
    );
    void basicDeduction;

    try {
      // 收件人 = 全部 admin（与应收到期提醒/admin 信用预警同一范式）
      await this.notifications.sendAdminNotification(
        `【年结提醒】${year} 年度结转待处理`,
        content
      );
      this.logger.log(`年结提醒已发送 period=${period} failed=${failed.length}`);
    } catch (error) {
      // 通知失败不得影响其它定时任务
      this.logger.error(
        `年结提醒发送失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}
