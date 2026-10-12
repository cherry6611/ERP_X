import { CRON_BY_TRIGGER } from './cron-map';

describe('cron map', () => {
  it('covers the six platform jobs', () => {
    expect(Object.keys(CRON_BY_TRIGGER).sort()).toEqual([
      'admin_rent_expiry_remind',
      'ar_due_reminder_daily',
      'customer_credit_alert',
      'delivery_warning_weekly',
      'feishu_daily_sync',
      'project_drive_sync_daily',
    ]);
  });

  it('runs the weekly warning on Monday morning', () => {
    expect(CRON_BY_TRIGGER.delivery_warning_weekly).toBe('0 9 * * 1');
  });
});
