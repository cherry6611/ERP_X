import { Logger } from '@nestjs/common';
import { Automation, BindTrigger } from '@server/platform';
import { LoginSecurityService } from './login-security.service';

/**
 * B-04 + B-07：登录安全与数据保留定时任务（每日 03:30）。
 *
 * - 清理过期 MFA 挑战票据（B-04）；
 * - 登录审计保留由 `SystemConfigModule` 的 RetentionService 处理
 *   （避免 AuthModule 反向依赖 SystemConfigModule 造成循环）。
 */
@Automation()
export class AuthSecurityAutomationTasksService {
  private readonly logger = new Logger(AuthSecurityAutomationTasksService.name);

  constructor(private readonly security: LoginSecurityService) {}

  @BindTrigger('retention_daily')
  async purgeExpiredChallenges(): Promise<void> {
    await this.security.purgeChallenges();
    this.logger.log('MFA 挑战票据清理完成');
  }
}
