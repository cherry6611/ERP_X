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
  /** B-07：数据保留与归档（每日 03:30，审计日志超期归档） */
  retention_daily: '30 3 * * *',
  /** A-04：年结提醒（12 月 20 日起每日提醒 admin 做年结前置检查） */
  year_end_reminder_daily: '0 9 * * *',
  /** D-12：BI 指标预警扫描（每日 08:30，按用户订阅的阈值判定并推送） */
  bi_alert_daily: '30 8 * * *',
  /** C-04 / D-02：票据到期提醒（每日 09:00，逾期与 15 天内到期） */
  note_due_reminder_daily: '0 9 * * *',
  /** C-10：合同到期提醒（每日 09:15，30/15/3 天三档；与应收提醒错开 15 分钟避免同时推送） */
  contract_expiry_remind: '15 9 * * *',
};
