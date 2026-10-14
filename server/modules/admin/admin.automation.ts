import { Logger } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { and, eq, gte, lte, ne, sql } from 'drizzle-orm';
import {
  Automation,
  BindTrigger,
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { erpAdminRentContract, erpAr, mdCustomer } from '@server/database/schema';
import { NotificationsService } from '@server/modules/notifications/notifications.service';
import { AutomationConfigService } from './automation-config.service';
import { todayInShanghai } from '@server/common/utils/biz-date';
import dayjs from 'dayjs';

const REMIND_AHEAD_DAYS = 30;
const CREDIT_ALERT_RATIO = 0.8;

interface CreditAlertRow {
  code: string;
  name: string;
  creditLimit: string | null;
  openAr: string;
}

interface ExpiringRow {
  id: string;
  code: string;
  name: string;
  endDate: string;
}

@Automation()
export class AdminAutomationTasksService {
  private readonly logger = new Logger(AdminAutomationTasksService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly notificationsService: NotificationsService,
    private readonly automationConfigService: AutomationConfigService
  ) {}

  @BindTrigger('customer_credit_alert')
  async alertCustomerCredit(): Promise<void> {
    if (!(await this.automationConfigService.isEnabled('customer_credit_alert'))) {
      this.logger.log('任务已停用，跳过：customer_credit_alert');
      return;
    }
    this.logger.log('客户信用额度扫描开始');

    const rows: CreditAlertRow[] = await this.db
      .select({
        code: mdCustomer.code,
        name: mdCustomer.name,
        creditLimit: mdCustomer.creditLimit,
        openAr: sql<string>`coalesce(sum(${erpAr.amount} - ${erpAr.settledAmount}), 0)`,
      })
      .from(erpAr)
      .innerJoin(mdCustomer, eq(mdCustomer.id, erpAr.customerId))
      .where(ne(erpAr.status, 'settled'))
      .groupBy(mdCustomer.code, mdCustomer.name, mdCustomer.creditLimit)
      .having(
        sql`coalesce(sum(${erpAr.amount} - ${erpAr.settledAmount}), 0) >= ${mdCustomer.creditLimit} * ${CREDIT_ALERT_RATIO} and ${mdCustomer.creditLimit} > 0`
      );

    if (rows.length === 0) {
      this.logger.log('客户信用额度扫描结束：无超限客户');
      return;
    }

    const lines: string[] = rows.map(
      (row: CreditAlertRow): string => {
        const limit: number = Number(row.creditLimit);
        const openAr: number = Number(row.openAr);
        const pct: number = Math.round((openAr / limit) * 100);
        return `${row.code} ${row.name}：额度 ¥${limit.toLocaleString('zh-CN')}，未结应收 ¥${openAr.toLocaleString('zh-CN')}（额度占用 ${pct}%）`;
      }
    );
    const content: string = `以下客户未结应收已达到信用额度的 ${CREDIT_ALERT_RATIO * 100}%，请关注回款风险：\n${lines.join('\n')}`;

    try {
      const result = await this.notificationsService.sendAdminNotification(
        '客户信用额度预警',
        content
      );
      this.logger.log(
        `客户信用额度扫描结束：命中=${rows.length} sent=${result.sent} reason=${result.reason ?? '-'} `
      );
    } catch (error: unknown) {
      const stack: string =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.logger.error(
        `客户信用额度预警发送失败 命中=${rows.length}`,
        stack
      );
    }
  }

  @BindTrigger('admin_rent_expiry_remind')
  async remindRentExpiry(): Promise<void> {
    if (
      !(await this.automationConfigService.isEnabled('admin_rent_expiry_remind'))
    ) {
      this.logger.log('任务已停用，跳过：admin_rent_expiry_remind');
      return;
    }
    const today: string = todayInShanghai();
    const horizon: string = dayjs(today).add(REMIND_AHEAD_DAYS, 'day').format('YYYY-MM-DD');
    this.logger.log(`租房合同到期扫描开始 today=${today} horizon=${horizon}`);

    const expiredRows: Array<{ id: string }> = await this.db
      .update(erpAdminRentContract)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(
        and(
          eq(erpAdminRentContract.status, 'active'),
          lte(erpAdminRentContract.endDate, today)
        )
      )
      .returning({ id: erpAdminRentContract.id });
    if (expiredRows.length > 0) {
      this.logger.log(`已自动置为过期合同数=${expiredRows.length}`);
    }

    const expiringRows: ExpiringRow[] = await this.db
      .select({
        id: erpAdminRentContract.id,
        code: erpAdminRentContract.code,
        name: erpAdminRentContract.name,
        endDate: erpAdminRentContract.endDate,
      })
      .from(erpAdminRentContract)
      .where(
        and(
          eq(erpAdminRentContract.status, 'active'),
          gte(erpAdminRentContract.endDate, today),
          lte(erpAdminRentContract.endDate, horizon)
        )
      );

    for (const row of expiringRows) {
      const daysLeft: number = dayjs(row.endDate).diff(dayjs(today), 'day');
      try {
        const result = await this.notificationsService.sendApprovalNotification({
          bizType: 'admin_rent_contract',
          bizCode: row.code,
          title: '租房合同到期提醒',
          content: `租房合同 ${row.code}（${row.name}）将于 ${row.endDate} 到期，剩余 ${daysLeft} 天，请及时处理续租或退租。`,
        }, { kind: 'system' });
        this.logger.log(
          `到期提醒合同=${row.code} daysLeft=${daysLeft} sent=${result.sent}`
        );
      } catch (error: unknown) {
        const stack: string =
          error instanceof Error ? (error.stack ?? error.message) : String(error);
        this.logger.error(`到期提醒发送失败 合同=${row.code}`, stack);
      }
    }
    this.logger.log(
      `租房合同到期扫描结束 expiring=${expiringRows.length} expired=${expiredRows.length}`
    );
  }
}
