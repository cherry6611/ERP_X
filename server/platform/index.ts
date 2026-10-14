// ---------------------------------------------------------------------------
// 循环依赖防护（CommonJS 下的 TDZ 问题）
//
// TypeScript 把 `export { X } from './x'` 编译成「惰性 getter」：
//   Object.defineProperty(exports, "X", { get: () => _x.X })
// 而 `var _x = require("./x")` 按源码顺序执行。
// 由于 83 个业务文件通过本桶文件(@server/platform)反向导入，一旦
// platform.module 的加载过程回调本桶，尚未 require 的子模块就会触发
//   ReferenceError: Cannot access '_tokens' before initialization
//
// 解决办法：在任何 re-export 之前，先用「副作用导入」把所有子模块按
// 依赖顺序全部 require 进来，保证 getter 闭包里的 _xxx 一定已初始化。
// 注意：顺序很重要 —— 无依赖的放前面，platform.module 必须放最后。
// ---------------------------------------------------------------------------
import './tokens';
import './guards';
import './authorization-sdk';
import './capability.service';
import './scheduler';
import './session-store';
import './account-lifecycle';
import './platform.module';

export { PlatformModule, configureApp } from './platform.module';
export {
  DRIZZLE_DATABASE,
  PG_CLIENT,
  RAW_DATABASE,
  type PostgresJsDatabase,
} from './tokens';
export { NeedLogin, CanRole, CanCapability, CanCapabilityRead, Public } from './guards';
export { AuthorizationSDK, type ListMembersParams, type ListMembersResponse } from './authorization-sdk';
export { CapabilityService } from './capability.service';
export { Automation, BindTrigger } from './scheduler';
export { SessionStore } from './session-store';
export { AccountLifecycleService } from './account-lifecycle';
