/** 平台控制台未导出时，采用需求书记载的周期。时区 Asia/Shanghai。 */
export const CRON_BY_TRIGGER: Record<string, string> = {
  ar_due_reminder_daily: '0 9 * * *',
  delivery_warning_weekly: '0 9 * * 1',
  project_drive_sync_daily: '0 2 * * *',
  feishu_daily_sync: '0 2 * * *',
  feishu_contact_full: '0 2 * * *',
  feishu_contact_incremental: '*/15 * * * *',
  customer_credit_alert: '0 9 * * *',
  admin_rent_expiry_remind: '0 9 * * *',
  /** B1：凭证失败队列重试 */
  voucher_job_retry: '*/10 * * * *',
  /** U-06：会话表每日清理（30 天前） */
  session_cleanup_daily: '15 3 * * *',
};
