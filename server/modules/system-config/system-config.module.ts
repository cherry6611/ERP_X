import { Module } from '@nestjs/common';
// B-02：数据级权限（行级可见范围）配置读写
import { DataScopeService } from '@server/common/auth/data-scope.service';
import { SystemConfigController } from './system-config.controller';
import { SystemConfigService } from './system-config.service';
import { DictService } from './dict.service';
import { RetentionService } from './retention.service';
import { RetentionAutomationTasksService } from './retention-tasks.automation';

/**
 * B-03 字典与参数 / B-07 数据保留 / B-08 编号规则。
 *
 * `DictService` 需要被其他模块（报价审批阈值、UI 文案、税率档位等）复用，故在此导出。
 * 注意：本模块**不依赖 AuthModule**（登录安全相关的 cron 在 AuthModule 内），
 * 避免 AuthModule ←→ SystemConfigModule 的循环依赖。
 */
@Module({
  controllers: [SystemConfigController],
  providers: [
    SystemConfigService,
    DictService,
    RetentionService,
    RetentionAutomationTasksService,
    DataScopeService,
  ],
  exports: [DictService, SystemConfigService, RetentionService],
})
export class SystemConfigModule {}
