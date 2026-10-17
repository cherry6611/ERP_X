/**
 * 运行环境的**唯一**判定入口（fail-safe 语义）。
 *
 * ## 为什么必须集中一处
 *
 * 全仓原先有 6 处各自写 `process.env.NODE_ENV === 'production'`：
 * `main.ts`（密钥强度）、`auth.controller.ts`（Cookie `Secure`）、
 * `exception.filter.ts`（是否回显堆栈）、`data-scope.service.ts`（启动告警）、
 * `feishu-collab/event.controller.ts`（事件校验逃逸开关）、`auth.service.ts`（同源告警）。
 *
 * 这些判断都是**安全开关**，而 `=== 'production'` 是 **fail-open** 的：
 * 只要生产部署把 `NODE_ENV` 写成 `prod` / `Production` / 留空 / 漏配
 * （compose 漏了 `NODE_ENV`、PM2 配置丢了 env、容器 base image 覆盖了变量……），
 * 全部判断同时失效，且**没有任何报错**：
 *   · 弱 JWT 密钥被放行 → 可伪造管理员会话；
 *   · 会话 Cookie 丢掉 `Secure` → 明文网络可窃取；
 *   · 异常过滤器把堆栈/内部 SQL 报文回显给客户端 → 信息泄露；
 *   · 飞书事件校验可被 `FEISHU_ALLOW_UNVERIFIED_EVENTS=true` 绕过。
 * 四个后果叠加，等于"配错一个环境变量就整体失守"。
 *
 * ## 语义
 *
 * - `isProductionRuntime()`：**除显式 `NODE_ENV=development` 外一律按生产对待**。
 *   未设置 → 生产（fail-safe）；`prod` / `production` / 其他任何值 → 生产；
 *   仅 `development` → 开发。
 * - 需要额外提醒的是：**不要**用本函数决定"是否要跑单元测试"之类的事，
 *   它只回答"当前是否必须按生产的安全标准执行"。
 *
 * 与 `ALLOW_WEAK_SECRETS=true` 的分工：本函数管"默认从严"，
 * `ALLOW_WEAK_SECRETS` 管"本地显式降级"，两者独立，避免一个环境变量同时控制多件事。
 */

/** 显式声明为开发环境的值（大小写不敏感，去空白）。 */
const DEVELOPMENT_VALUES = new Set(['development', 'dev']);

/**
 * 是否必须按生产标准执行安全策略。
 *
 * **fail-safe**：只有显式声明为开发环境时才返回 false。
 * 未设置 `NODE_ENV`（最常见的误配）按生产处理。
 */
export function isProductionRuntime(): boolean {
  const raw = (process.env.NODE_ENV ?? '').trim().toLowerCase();
  return !DEVELOPMENT_VALUES.has(raw);
}

/** 是否显式声明为开发环境。 */
export function isDevelopmentRuntime(): boolean {
  return !isProductionRuntime();
}

/**
 * 是否允许使用弱密钥／跳过安全校验。
 *
 * 仅在**显式**开发环境且显式设置 `ALLOW_WEAK_SECRETS=true` 时为 true ——
 * 生产环境下该开关一律无效（生产救急请用正规密钥，不要用一个环境变量把门全打开）。
 * 保留"生产也可显式开启"的后门是危险的，因此这里直接封死。
 */
export function allowWeakSecrets(): boolean {
  return (
    isDevelopmentRuntime() &&
    (process.env.ALLOW_WEAK_SECRETS ?? '').trim().toLowerCase() === 'true'
  );
}
