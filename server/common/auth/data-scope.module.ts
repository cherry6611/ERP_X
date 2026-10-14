import { Global, Module } from '@nestjs/common';
import { DataScopeService } from './data-scope.service';

/**
 * B-02：数据级权限（行级可见范围）。
 *
 * 之所以做成 `@Global()`：`projects` / `finance` / `hr` / `voucher` 等多个业务模块
 * 都要在 service 层注入过滤条件，逐模块 import 会形成无意义的横向依赖；
 * 而 `DataScopeService` 只依赖全局 `DRIZZLE_DATABASE`，没有模块级副作用。
 *
 * 需要在 `server/app.module.ts` 的 `ActorAccessModule,` 之后加两行：
 *   import { DataScopeModule } from './common/auth/data-scope.module';
 *   ...
 *   DataScopeModule,
 */
@Global()
@Module({
  providers: [DataScopeService],
  exports: [DataScopeService],
})
export class DataScopeModule {}
