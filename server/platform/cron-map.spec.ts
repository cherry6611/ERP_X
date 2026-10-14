import { CRON_BY_TRIGGER } from './cron-map';

describe('cron map', () => {
  it('covers the scheduled jobs', () => {
    expect(Object.keys(CRON_BY_TRIGGER).sort()).toEqual([
      'admin_rent_expiry_remind',
      'ar_due_reminder_daily',
      'customer_credit_alert',
      'delivery_warning_weekly',
      'feishu_contact_full',
      'feishu_contact_incremental',
      'feishu_daily_sync',
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

  it('保留任务在凌晨低峰执行，提醒类任务在 09:00 执行', () => {
    expect(CRON_BY_TRIGGER.retention_daily).toBe('30 3 * * *');
    expect(CRON_BY_TRIGGER.session_cleanup_daily).toBe('15 3 * * *');
    expect(CRON_BY_TRIGGER.ar_due_reminder_daily).toBe('0 9 * * *');
    expect(CRON_BY_TRIGGER.year_end_reminder_daily).toBe('0 9 * * *');
  });
});
