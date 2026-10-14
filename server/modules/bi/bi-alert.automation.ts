import { Logger } from '@nestjs/common';
import { Automation, BindTrigger } from '@server/platform';
import { AutomationConfigService } from '@server/modules/admin/automation-config.service';
import { BiMetricsService } from './bi-metrics.service';

/**
 * D-12：BI 指标预警扫描（毎日 08:30，业务时区 Asia/Shanghai）。
 *
 * 为什么需要：指标中心只提供"查看"，业务方仍要每天主动打开页面才能发现
 * 毛利率跌破警戒线、应收周转天数超标、项目超预算等问题。本任务把这些
 * 判断固化为**用户自订阅的阈值规则**，命中即推送。
 *
 * 设计约束（与全仓 cron 范式一致）：
 * - 通过 `comp_automation_config` 总开关（taskKey = `bi_alert_daily`）可停用，
 *   与 ar_due_reminder_daily / delivery_warning_weekly 等同一范式；
 * - 逐条订阅独立 try/catch，一条坏订阅不能让全部预警停摆；
 * - 通知在事务外发送（外部 IO 禁止在事务内）；
 * - 通知失败只记 error 日志，不抛出（避免调度器把整个任务标失败）。
 */
@Automation()
export class BiAlertAutomationTasksService {
  private readonly logger = new Logger(BiAlertAutomationTasksService.name);

  constructor(
    private readonly biMetrics: BiMetricsService,
    private readonly automationConfigService: AutomationConfigService
  ) {}

  @BindTrigger('bi_alert_daily')
  async scanAlerts(): Promise<void> {
    if (!(await this.automationConfigService.isEnabled('bi_alert_daily'))) {
      // 总开关关闭时直接跳过，与其它定时任务一致（避免刷日志）
      return;
    }
    const period = this.currentPeriod();
    try {
      const result = await this.biMetrics.runAlertScan(period);
      this.logger.log(
        `BI 指标预警扫描完成 period=${period} evaluated=${result.evaluated} triggered=${result.triggered} failures=${result.failures}`
      );
    } catch (error) {
      this.logger.error(
        `BI 指标预警扫描失败 period=${period}：${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  /** 业务时区（Asia/Shanghai）当前月份，避免用 UTC 月份跨月误判 */
  private currentPeriod(): string {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
    })
      .format(new Date())
      .slice(0, 7);
  }
}
