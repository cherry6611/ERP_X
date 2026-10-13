import { Logger } from '@nestjs/common';
import { Automation, BindTrigger, SessionStore } from '@server/platform';

/** U-06：每日清理 30 天前过期/吊销会话 */
@Automation()
export class SessionCleanupAutomationTasksService {
  private readonly logger = new Logger(SessionCleanupAutomationTasksService.name);

  constructor(private readonly sessions: SessionStore) {}

  @BindTrigger('session_cleanup_daily')
  async purge(): Promise<void> {
    const n = await this.sessions.purgeExpired(30);
    this.logger.log(`session_cleanup_daily done purged≈${n}`);
  }
}
