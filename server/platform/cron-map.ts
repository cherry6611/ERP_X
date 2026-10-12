/** 平台控制台未导出时，采用需求书记载的周期。时区 Asia/Shanghai。 */
export const CRON_BY_TRIGGER: Record<string, string> = {
  ar_due_reminder_daily: '0 9 * * *',
  delivery_warning_weekly: '0 9 * * 1',
  project_drive_sync_daily: '0 2 * * *',
  feishu_daily_sync: '0 2 * * *',
  customer_credit_alert: '0 9 * * *',
  admin_rent_expiry_remind: '0 9 * * *',
};
