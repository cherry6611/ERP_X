import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  Automation,
  BindTrigger,
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';
import { erpContract, mdCustomer } from '@server/database/schema';
import { todayInShanghai } from '@server/common/utils/biz-date';
import { DictService } from '@server/modules/system-config/dict.service';
import { NotificationsService } from '@server/modules/notifications/notifications.service';
import { AutomationConfigService } from '@server/modules/admin/automation-config.service';

/**
 * C-10：合同到期提醒（独立 cron handler）。
 *
 * ## 为什么需要独立 handler
 *
 * 此前「合同到期」没有任何主动提醒 —— 只有房租合同（`admin_rent_expiry_remind`）
 * 有。数据服务合同到期意味着：续约窗口错过、服务默认延续但未签补充协议
 * （收入确认与开票失去依据）、或客户已被竞对签走。这类漏点靠人工台账无法兜住。
 *
 * ## 判定口径（**需业务确认**）
 *
 * | 项 | 默认 | 理由 |
 * |---|---|---|
 * | 提前提醒天数 | 30 / 15 / 3 天三档 | 30 天是续约谈判的合理起点；3 天是最后补救窗口 |
 * | 纳入状态 | `active` / `performing` | 草稿、审批中、已完成、已终止不需要提醒 |
 * | 客户维度 | 同客户同到期日合并为一封 | 一个客户往往同时有几个合同到期，分开发会被当噪音忽略 |
 * | 收件人 | 合同 `owner`（妙搭 userId 纯文本）+ admin 兜底 | 与应收提醒口径一致 |
 *
 * ## 幂等
 *
 * 靠"提醒档位 + 到期日"决定是否发送，而不是靠"今天发过没有"。
 * 因此 cron 一天跑多次也不会重复打扰（同一档位只在进入该窗口的第一天匹配）。
 * 若需要更强的幂等，应落一张 `comp_reminder_log` 表 —— 当前实现**没有**，
 * 这是已知限制：cron 重跑（例如手动触发）会重复发送。已在 RUNBOOK 登记。
 */
@Injectable()
export class ContractExpiryReminderService {
  private readonly logger = new Logger(ContractExpiryReminderService.name);

  /** 提醒档位（天）。进入窗口的那一天提醒一次 */
  private static readonly REMINDER_TIERS = [30, 15, 3] as const;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly notifications: NotificationsService,
    private readonly dictService: DictService,
    private readonly automationConfig: AutomationConfigService
  ) {}

  /**
   * 扫描并发送合同到期提醒。
   *
   * @param options.dryRun 只返回待提醒清单，不发送（供手工核对与测试）
   * @param options.asOf   指定"今天"（YYYY-MM-DD），便于补跑与测试
   */
  async run(options?: { dryRun?: boolean; asOf?: string }): Promise<{
    asOf: string;
    tiers: Array<{ daysLeft: number; count: number; skipped?: string }>;
    candidates: Array<{
      contractId: string;
      code: string;
      name: string;
      customerName: string | null;
      owner: string | null;
      endDate: string;
      daysLeft: number;
      amount: number;
      recipients: string[];
    }>;
    sent: number;
    skipped: string | null;
  }> {
    const asOf = options?.asOf ?? todayInShanghai();
    const dryRun = options?.dryRun ?? false;
    const tiers: Array<{ daysLeft: number; count: number; skipped?: string }> =
      [];
    const candidates: Array<{
      contractId: string;
      code: string;
      name: string;
      customerName: string | null;
      owner: string | null;
      endDate: string;
      daysLeft: number;
      amount: number;
      recipients: string[];
    }> = [];
    let sent = 0;
    let skipped: string | null = null;

    if (!dryRun && !(await this.automationConfig.isEnabled('contract_expiry_remind'))) {
      this.logger.log('contract_expiry_remind 已停用，跳过');
      return { asOf, tiers, candidates, sent, skipped: '自动化任务已停用' };
    }

    for (const daysLeft of ContractExpiryReminderService.REMINDER_TIERS) {
      const target = addDays(asOf, daysLeft);
      const rows = await this.db
        .select({
          id: erpContract.id,
          code: erpContract.code,
          name: erpContract.name,
          owner: erpContract.owner,
          endDate: erpContract.endDate,
          amount: erpContract.amount,
          customerName: mdCustomer.name,
        })
        .from(erpContract)
        .leftJoin(mdCustomer, eq(mdCustomer.id, erpContract.customerId))
        .where(
          and(
            inArray(erpContract.status, ['active', 'performing']),
            isNotNull(erpContract.endDate),
            // 精确等于目标日期：这样同一档位只在进入窗口当天匹配一次
            eq(erpContract.endDate, target)
          )
        );

      tiers.push({ daysLeft, count: rows.length });
      for (const row of rows) {
        candidates.push({
          contractId: row.id,
          code: row.code,
          name: row.name,
          customerName: row.customerName,
          owner: row.owner,
          endDate: row.endDate ?? target,
          daysLeft,
          amount: Number(row.amount ?? 0),
          recipients: await this.resolveRecipients(row.owner),
        });
      }
    }

    if (dryRun || candidates.length === 0) {
      return { asOf, tiers, candidates, sent, skipped };
    }

    // 同一收件人合并为一封：按收件人分组，而不是按合同逐条发。
    // 一个客户同时到期几个合同时，逐条发会被当噪音忽略。
    const byRecipient = new Map<string, typeof candidates>();    for (const candidate of candidates) {
      for (const recipient of candidate.recipients) {
        const list = byRecipient.get(recipient) ?? [];
        list.push(candidate);
        byRecipient.set(recipient, list);
      }
    }

    for (const [recipient, items] of byRecipient) {
      try {
        // 同一收件人合并为一封（按收件人分组，而非逐合同发）：
        // 一个客户同时到期几个合同时，逐条发会被当噪音忽略。
        const result = await this.notifications.sendUserNotification(
          [recipient],
          `合同到期提醒（${items.length} 份）`,
          this.renderContent(items)
        );
        if (result.sent) {
          sent += 1;
        } else {
          this.logger.warn(
            `合同到期提醒未发送 recipient=${recipient} reason=${result.reason ?? '-'}`
          );
        }
      } catch (error) {
        // 单个收件人失败不阻断其余：提醒的价值在于"尽可能都发出去"，
        // 一个坏 userId 不该让其他人收不到。
        this.logger.error(
          `合同到期提醒发送失败 recipient=${recipient}：${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    this.logger.log(
      `合同到期提醒 asOf=${asOf} 候选=${candidates.length} 已发=${sent}`
    );
    return { asOf, tiers, candidates, sent, skipped };
  }

  /** 收件人：合同负责人 + admin 兜底（与应收提醒口径一致） */
  private async resolveRecipients(owner: string | null): Promise<string[]> {
    const trimmed = (owner ?? '').trim();
    if (trimmed) return [trimmed];
    const fallback = await this.dictService.stringParam(
      'notification.adminUserId',
      'admin'
    );
    return [fallback];
  }

  /** 渲染通知正文（含具体金额与到期日，便于直接决策） */
  private renderContent(
    items: Array<{
      code: string;
      name: string;
      customerName: string | null;
      endDate: string;
      daysLeft: number;
      amount: number;
    }>
  ): string {
    const lines = items
      .sort((a, b) => a.daysLeft - b.daysLeft)
      .map(
        (item) =>
          `· ${item.customerName ?? '（未知客户）'} ${item.name}（${item.code}）` +
          ` 到期日 ${item.endDate}，剩余 ${item.daysLeft} 天，合同额 ${item.amount.toFixed(2)}`
      );
    const urgent = items.filter((item) => item.daysLeft <= 3).length;
    return [
      `以下合同即将到期${urgent > 0 ? `（其中 ${urgent} 份 3 天内到期，需立即处理）` : ''}：`,
      ...lines,
      '',
      '处理建议：① 确认是否续约，续约请在到期前完成审批；',
      '② 不续约的请及时在系统内终止合同并停止服务，避免收入确认失去依据；',
      '③ 服务实际延续但未签补充协议的，属于无合同收入，需立即补签。',
    ].join('\n');
  }

  /**
   * 某期间内到期的合同清单（供页面上"合同到期日历"使用）。
   *
   * 与提醒的**区别**：提醒只看三个精确档位日，这里返回完整区间 ——
   * 页面需要看到全貌（包括已过期的），而不是只有被提醒的那几天。
   */
  async listExpiring(params: {
    from: string;
    to: string;
    includeExpired?: boolean;
  }): Promise<
    Array<{
      contractId: string;
      code: string;
      name: string;
      customerName: string | null;
      owner: string | null;
      endDate: string;
      daysLeft: number;
      amount: number;
      status: string;
    }>
  > {
    const conditions = [
      inArray(erpContract.status, ['active', 'performing']),
      isNotNull(erpContract.endDate),
      lte(erpContract.endDate, params.to),
      sql`${erpContract.endDate} >= ${params.from}`,
    ];
    const rows = await this.db
      .select({
        id: erpContract.id,
        code: erpContract.code,
        name: erpContract.name,
        owner: erpContract.owner,
        endDate: erpContract.endDate,
        amount: erpContract.amount,
        status: erpContract.status,
        customerName: mdCustomer.name,
      })
      .from(erpContract)
      .leftJoin(mdCustomer, eq(mdCustomer.id, erpContract.customerId))
      .where(and(...conditions))
      .orderBy(erpContract.endDate);

    const today = todayInShanghai();
    const all = rows.map((row) => ({
      contractId: row.id,
      code: row.code,
      name: row.name,
      customerName: row.customerName,
      owner: row.owner,
      endDate: row.endDate ?? '',
      daysLeft: daysBetween(today, row.endDate ?? today),
      amount: Number(row.amount ?? 0),
      status: row.status ?? 'active',
    }));
    return params.includeExpired === false
      ? all.filter((item) => item.daysLeft >= 0)
      : all;
  }
}

/**
 * C-10：合同到期提醒的 cron 触发器。
 *
 * 单独一个类承载 `@BindTrigger`，业务逻辑留在 `ContractExpiryReminderService` ——
 * 这样逻辑可以被测试与手工调用（`dryRun`/`asOf`），触发器只负责"按点跑一次"。
 * 两者放同一个文件是因为它们是一体的：触发器只有一个，拆文件只会增加跳转成本。
 */
@Automation()
export class ContractExpiryAutomationTasksService {
  private readonly logger = new Logger(ContractExpiryAutomationTasksService.name);

  constructor(
    private readonly reminder: ContractExpiryReminderService
  ) {}

  @BindTrigger('contract_expiry_remind')
  async remindContractExpiry(): Promise<void> {
    const result = await this.reminder.run();
    if (result.skipped) {
      this.logger.log(`合同到期提醒跳过：${result.skipped}`);
      return;
    }
    this.logger.log(
      `合同到期提醒完成 asOf=${result.asOf} 候选=${result.candidates.length} 已发=${result.sent}`
    );
  }
}

/** YYYY-MM-DD 加天数（纯日期运算，不引入时区） */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const base = Date.UTC(y, m - 1, d);
  const next = new Date(base + days * 86_400_000);
  return next.toISOString().slice(0, 10);
}

/** 两个 YYYY-MM-DD 之间的天数差（to − from） */
export function daysBetween(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000
  );
}
