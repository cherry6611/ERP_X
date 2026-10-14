# 身份与组织模块（`server/modules/identity/`）

负责**用户账号**（`sys_user`）与**飞书身份绑定**，与 `master-data`（客户/供应商）、
`hr`（员工档案）的区别是：本模块管的是"能登录系统的人"，不是业务实体。

## 职责

| 文件 | 职责 |
|---|---|
| `identity.service.ts` | 用户 CRUD、状态启停、角色分配、密码重置、飞书邀请/解绑/联系人绑定、会话撤销 |
| `identity.controller.ts` | 路由与能力校验（`identity` 能力，仅 admin） |

## 涉及表

- `sys_user`：账号（`username` / `display_name` / `password_hash` / `status` / `roles` /
  `platform_user_id` / `feishu_open_id` + B-04 新增的 MFA 与密码策略列）
- `sys_session`：登录会话（`jti` / `expires_at` / `user_agent` / `ip`）
- `sys_login_audit`：登录审计（成功/失败/锁定/MFA 校验）

## 对外接口

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/identity/users` | `identity`（仅 admin） |
| POST | `/api/identity/users` | `identity` |
| PATCH | `/api/identity/users/:id`、`/:id/status` | `identity` |
| PUT | `/api/identity/users/:id/roles` | `identity` |
| POST | `/api/identity/users/:id/reset-password` | `identity` |
| GET | `/api/identity/users/:id/sessions` | `identity` |
| POST | `/api/identity/users/:id/sessions/:jti/revoke`、`/sessions/revoke-all` | `identity` |
| POST | `/api/identity/users/:id/feishu/invite`、`/invite/revoke` | `identity` |
| POST | `/api/identity/users/:id/feishu/bind-contact` | `identity` |
| DELETE | `/api/identity/users/:id/feishu` | `identity` |

`GET /api/auth/*`（登录、MFA、改密、会话）在 `auth` 模块，不在本模块。

## 关键约束与易踩的坑

1. **未绑定飞书禁止自动注册**：密码登录 → 设置页「绑定飞书」→ 之后才可用飞书登录。
   飞书回调遇到未绑定用户时返回明确错误，而不是静默建号。
2. **不能删除自己 / 不能取消自己最后一个 admin 角色**：会造成系统无管理员。
3. **重置密码后必须撤销该用户全部会话**，否则旧 token 仍可访问（JWT 无状态）。
4. **`platform_user_id` 唯一**（表达式索引）：一个飞书身份只能绑一个账号，
   否则审批/通知会发给错误的人。
5. **角色枚举的权威在 `shared/rbac.ts`**：`roles` 只能写矩阵中存在的角色名，
   写入未知角色会被 `RolesGuard` 视为无任何权限（静默失效，很难排查）。

## 测试入口

```bash
npx jest --config jest.config.cjs server/modules/identity server/modules/auth
```

MFA/TOTP 的 RFC 向量测试在 `server/common/security/totp.spec.ts`；
密码策略与锁定在 `server/platform/password.spec.ts`。
