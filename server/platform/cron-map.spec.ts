import { CRON_BY_TRIGGER } from './cron-map';

describe('cron map', () => {
  it('covers the scheduled jobs', () => {
    expect(Object.keys(CRON_BY_TRIGGER).sort()).toEqual([
      'admin_rent_expiry_remind',
      'ar_due_reminder_daily',
      // D-12：BI 指标预警扫描（每日 08:30）
      'bi_alert_daily',
      // C-10：合同到期提醒（每日 09:15）
      'contract_expiry_remind',
      'customer_credit_alert',
      'delivery_warning_weekly',
      'feishu_contact_full',
      'feishu_contact_incremental',
      'feishu_daily_sync',
      // C-04 / D-02：票据到期提醒（每日 09:00）
      'note_due_reminder_daily',
      'project_drive_sync_daily',
      // B-07：数据保留与归档（每日 03:30）
      'retention_daily',
      'session_cleanup_daily',
      'voucher_job_retry',
      // A-04：年结提醒（12 月前置检查）
      'year_end_reminder_daily',
    ]);
  });

  it('runs the weekly warning on Monday morning', () => {
    expect(CRON_BY_TRIGGER.delivery_warning_weekly).toBe('0 9 * * 1');
  });

  it('每个 trigger 的 cron 表达式都是 5 段式（时区由调度器统一为 Asia/Shanghai）', () => {
    for (const [trigger, cron] of Object.entries(CRON_BY_TRIGGER)) {
      expect(`${trigger}=${cron}`).toMatch(/^[\w_]+=(.+ ){4}.+$/);
    }
  });

  it('保留任务在凌晨低峰执行，提醒类任务在 09:00 前执行', () => {
    expect(CRON_BY_TRIGGER.retention_daily).toBe('30 3 * * *');
    expect(CRON_BY_TRIGGER.session_cleanup_daily).toBe('15 3 * * *');
    expect(CRON_BY_TRIGGER.ar_due_reminder_daily).toBe('0 9 * * *');
    expect(CRON_BY_TRIGGER.year_end_reminder_daily).toBe('0 9 * * *');
    // D-12 预警必须在工作时间开始前跑完，否则业务方上午看不到提醒
    expect(CRON_BY_TRIGGER.bi_alert_daily).toBe('30 8 * * *');
    expect(CRON_BY_TRIGGER.note_due_reminder_daily).toBe('0 9 * * *');
    // C-10 与应收提醒错开 15 分钟：同点推送会让业务方一次收到多条，
    // 反而容易漏看（与票据提醒同属 09:00 时段，故排在 09:15）
    expect(CRON_BY_TRIGGER.contract_expiry_remind).toBe('15 9 * * *');
    expect(CRON_BY_TRIGGER.contract_expiry_remind).not.toBe(
      CRON_BY_TRIGGER.ar_due_reminder_daily
    );
  });
});
