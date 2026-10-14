import { Logger } from '@nestjs/common';
import { Automation, BindTrigger } from '@server/platform';
import { RetentionService } from './retention.service';

/**
 * B-07：数据保留与归档定时任务（每日 03:30）。
 *
 * 执行内容：审计日志/登录审计/站内信超期归档、登录会话清理。
 * 单条策略失败由 RetentionService 内部隔离，不会打断其它策略。
 * （MFA 挑战票据清理在 AuthModule，避免循环依赖。）
 */
@Automation()
export class RetentionAutomationTasksService {
  private readonly logger = new Logger(RetentionAutomationTasksService.name);

  constructor(private readonly retention: RetentionService) {}

  @BindTrigger('retention_daily')
  async runRetention(): Promise<void> {
    const results = await this.retention.runAll();
    if (results.length === 0) {
      this.logger.log('数据保留策略执行完成（无可执行策略）');
      return;
    }
    const summary = results
      .map((item) => `${item.dataType}:${item.affected}`)
      .join(' ');
    this.logger.log(`数据保留策略执行完成 ${summary}`);
  }
}
