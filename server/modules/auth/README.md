# 认证与安全模块（`server/modules/auth/`）

覆盖需求书 **B-04（MFA / 密码策略 / 登录锁定 / 会话设备管理）** 与飞书 OAuth 登录。

## 职责与文件

| 文件 | 职责 |
|---|---|
| `auth.service.ts` | 密码登录、飞书 OAuth 回调、`login()` 返回 `PasswordLoginResult`（含 `mfaRequired` 判别联合）、`verifyMfaLogin()`、密码策略断言 |
| `login-security.service.ts` | MFA 生命周期（setup/confirm/disable/verify）、恢复码、挑战票据、密码策略与历史、锁定、登录审计、会话标记与撤销 |
| `auth.controller.ts` | 路由；所有 DTO class **必须定义在 controller 之前**（TDZ） |
| `auth-security.automation.ts` | `retention_daily` 中清理过期的 MFA 挑战票据 |

## 涉及表

`sys_user`（MFA 与密码列）、`sys_mfa_challenge`（登录挑战，短期有效）、
`sys_mfa_recovery_code`、`sys_login_audit`、`sys_session`。

MFA 的 TOTP 实现是**手写 RFC 6238/4648**（`server/common/security/totp.ts`，无外部依赖），
已用 RFC 6238 Appendix B 官方向量验证。

## 默认安全策略（可通过 `sys_param` 覆盖）

| 项 | 默认 | 参数键 |
|---|---|---|
| 密码最小长度 | 12 | `security.password_min_length` |
| 复杂度 | 大写 + 小写 + 数字 + 符号 | — |
| 轮换周期 | 90 天 | `security.password_expire_days` |
| 禁止重用 | 最近 5 次 | `security.password_history_count` |
| 登录锁定 | 连续 5 次失败锁 15 分钟 | `security.login_max_attempts` / `_lock_minutes` |
| MFA | 按角色要求（admin 强制） | `security.mfa_required_roles` |

## 对外接口

| 方法 | 路径 |
|---|---|
| POST | `/api/auth/login`（返回 `mfaRequired` 时需继续验证） |
| POST | `/api/auth/mfa/verify` |
| GET | `/api/auth/mfa/status` |
| POST | `/api/auth/mfa/setup`、`/mfa/confirm`、`/mfa/disable` |
| POST | `/api/auth/password/change` |
| GET | `/api/auth/sessions` |
| POST | `/api/auth/sessions/:jti/revoke` |
| POST | `/api/auth/users/:userId/unlock` |
| GET | `/api/auth/login-audit` |
| GET | `/api/auth/feishu/start`、`/bind`、`/invite-start`、`/callback` |
| POST | `/api/auth/logout` |
| GET | `/api/auth/me` |

## 关键约束与易踩的坑

1. **登录失败必须写审计**（`sys_login_audit`），且**不能泄露账号是否存在**：
   账号不存在与密码错误返回同一提示。
2. **MFA 挑战票据一次性消费**：`consumeChallenge` 校验后即失效，
   否则同一 OTP 可被重放（TOTP 窗口内本身允许重复，因此票据层必须兜住）。
3. **重置密码 / 改密后必须撤销全部会话**：JWT 无状态，不撤销则旧 token 仍有效。
4. **锁定计数按账号而非 IP**（避免 NAT 环境下整个公司被锁），
   但 `sys_login_audit` 记录 IP 供排查。
5. **飞书 OAuth 的 `FEISHU_REDIRECT_URI` 宿主必须与 `APP_BASE_URL` 逐字符一致**
   （本地统一用 `127.0.0.1`，不要混用 `localhost`，否则 state Cookie 失效）。
6. **未绑定飞书禁止自动注册**：回调遇到未绑定用户时返回明确错误，不静默建号。
7. **恢复码只在生成时返回一次**（明文不落库，库中存哈希）；提示用户妥善保存。

## 测试入口

```bash
npx jest --config jest.config.cjs server/modules/auth server/common/security server/platform
```

- `server/common/security/totp.spec.ts`（8 例，含 RFC 官方向量）
- `server/common/security/oauth-state.spec.ts`、`rate-limit.spec.ts`、`secret-box.spec.ts`
- `server/platform/password.spec.ts`、`jwt.spec.ts`

## 需安全确认

1. 是否要求 admin 强制 MFA（当前是），以及普通用户的 MFA 是否可选。
2. 恢复码数量（8）与长度（9 位，格式 `XXXX-XXXXX`）是否满足等保要求。
3. 登录审计的保留年限（当前由 `retention_daily` 的 `login_audit` 策略控制）。
