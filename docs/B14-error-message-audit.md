# B-14 后端错误文案审计结论

> 对应需求书 **B-14（前端错误处理与文案统一）** 与 **§7.1 API-5**：
> "业务校验失败返回 4xx + **可读中文原因**，不得返回 500"。
>
> 审计工具：`scripts/audit-error-messages.mjs`（已纳入 CI，见 `.github/workflows/ci.yml`
> 的 `audit error messages` 步骤）。

## 审计方式

扫描 `server/**/*.ts`（排除 `*.spec.ts`），对每一处
`throw new BadRequestException(...)` / `ConflictException` / `NotFoundException` /
`UnauthorizedException` / `ForbiddenException` / `ServiceUnavailableException` /
`UnprocessableEntityException` / `InternalServerErrorException` / `HttpException`：

1. 从 `throw new Xxx(` 起做括号配对截取（跳过注释与转义），取出其中的**字符串字面量**
   （含模板字符串）；
2. 只要任一字面量含中日韩字符即判定通过；
3. 全部为纯英文 → 记为待修并让 CI 失败。

## 实测结论

```
$ node ./scripts/audit-error-messages.mjs
后端错误文案审计通过（扫描 240 个文件；白名单 1 条，均已登记理由）
退出码 0
```

**240 个服务端源码文件全部通过**，即所有面向用户的异常消息均可读中文。

## 白名单（1 条，已登记理由）

| 文件 | 理由 |
|---|---|
| `server/modules/feishu-collab/event.controller.ts` | 飞书事件回调（webhook）的入参校验消息会**回传给飞书开放平台**而非终端用户，且飞书侧按固定格式判定；改为中文会让平台侧无法归类。该接口不渲染任何 ERP 页面。 |

白名单写在脚本内的 `ALLOWED` 常量中，**必须同时写 `reason`**，评审时可一眼看到
"为什么允许英文"，避免用白名单掩盖问题。

## 与前端的关系

前端 B-14 的另一半（把 72 处 `err.message` 与 1 处 `String(error)` 统一到
`getApiErrorMessage`）由 `client/src/utils/api-error-message.ts` 承担：
它优先读取后端 `{ error: { message } }`，因此**后端只要返回中文，用户就能看到中文业务原因**
（例如"仅草稿或已驳回状态可提交"），而不是 axios 的 `Request failed with status code 400`。

## 维护约定

- 新增异常时**必须**写中文消息；
- 确需英文（回传第三方、内部断言）时，在 `scripts/audit-error-messages.mjs`
  的 `ALLOWED` 中登记 `{ file, reason }`，并在 PR 描述里说明；
- 不要把"参数名/字段名"当消息（如 `throw new BadRequestException('employeeId')`），
  应写成 `员工 ID 无效`。
