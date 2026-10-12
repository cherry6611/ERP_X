import { Inject, Logger } from '@nestjs/common';
import { and, eq, isNotNull, lte } from 'drizzle-orm';
import {
  Automation,
  BindTrigger,
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { erpAr, mdCustomer } from '@server/database/schema';
import { todayInShanghai } from '@server/common/utils/biz-date';
import { NotificationsService } from '@server/modules/notifications/notifications.service';
import { AutomationConfigService } from '@server/modules/admin/automation-config.service';
import dayjs from 'dayjs';

const REMINDER_AHEAD_DAYS = 7;
const MAX_LISTED_ITEMS = 10;

interface ArReminderRow {
  code: string;
  customerName: string | null;
  amount: string | null;
  settledAmount: string | null;
  dueDate: string | null;
  ownerUserId: string | null;
}

@Automation()
export class ArReminderAutomationTasksService {
  private readonly logger = new Logger(ArReminderAutomationTasksService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly notificationsService: NotificationsService,
    private readonly automationConfigService: AutomationConfigService
  ) {}

  @BindTrigger('ar_due_reminder_daily')
  async remindArDue(): Promise<void> {
    if (!(await this.automationConfigService.isEnabled('ar_due_reminder_daily'))) {
      this.logger.log('任务已停用，跳过：ar_due_reminder_daily');
      return;
    }
    const today: string = todayInShanghai();
    const horizon: string = dayjs(today)
      .add(REMINDER_AHEAD_DAYS, 'day')
      .format('YYYY-MM-DD');
    this.logger.log(`应收到期回款提醒扫描开始 today=${today} horizon=${horizon}`);

    const rows: ArReminderRow[] = await this.db
      .select({
        code: erpAr.code,
        customerName: mdCustomer.name,
        amount: erpAr.amount,
        settledAmount: erpAr.settledAmount,
        dueDate: erpAr.dueDate,
        ownerUserId: erpAr.ownerUserId,
      })
      .from(erpAr)
      .leftJoin(mdCustomer, eq(erpAr.customerId, mdCustomer.id))
      .where(
        and(
          eq(erpAr.status, 'open'),
          isNotNull(erpAr.dueDate),
          lte(erpAr.dueDate, horizon)
        )
      );
    if (rows.length === 0) {
      this.logger.log('应收到期回款提醒扫描结束：无命中单据');
      return;
    }

    const groups = new Map<string, ArReminderRow[]>();
    for (const row of rows) {
      const key: string = row.ownerUserId ?? '';
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }

    const adminIds: string[] = await this.notificationsService.getAdminUserIds();
    for (const [ownerId, items] of groups) {
      const receivers: string[] = ownerId !== '' ? [ownerId] : adminIds;
      if (receivers.length === 0) {
        this.logger.warn(
          `应收到期提醒未发送（no_recipients）owner=${ownerId || 'admin'} count=${items.length}`
        );
        continue;
      }
      const lines: string[] = items.map((item: ArReminderRow) => {
        const openAmount: number =
          Number(item.amount ?? 0) - Number(item.settledAmount ?? 0);
        const days: number = dayjs(today).diff(
          dayjs(item.dueDate ?? today),
          'day'
        );
        const daysLabel: string =
          days > 0 ? `已逾期 ${days} 天` : `剩余 ${-days} 天`;
        return `- ${item.code} ${item.customerName ?? '未知客户'} 未结 ${openAmount} 到期 ${item.dueDate ?? '-'} ${daysLabel}`;
      });
      const header: string =
        ownerId !== ''
          ? `您名下有 ${items.length} 笔应收到期需跟进回款：`
          : `有 ${items.length} 笔应收负责人未分配、已到期或临期，请跟进回款：`;
      const listed: string = lines.slice(0, MAX_LISTED_ITEMS).join('\n');
      const moreCount: number = lines.length - MAX_LISTED_ITEMS;
      const content: string =
        `${header}\n${listed}` +
        (moreCount > 0 ? `\n等 ${lines.length} 条` : '');
      try {
        const result = await this.notificationsService.sendUserNotification(
          receivers,
          '应收到期回款提醒',
          content
        );
        this.logger.log(
          `应收到期提醒发送结束 owner=${ownerId || 'admin'} count=${items.length} sent=${result.sent} reason=${result.reason ?? '-'}`
        );
      } catch (error: unknown) {
        const stack: string =
          error instanceof Error ? (error.stack ?? error.message) : String(error);
        this.logger.error(
          `应收到期提醒发送失败 owner=${ownerId || 'admin'} count=${items.length}`,
          stack
        );
      }
    }
  }
}
