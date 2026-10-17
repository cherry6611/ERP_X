import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { mdEmployee, sysFeishuSyncConflict, sysRole, sysRoleMember, sysUser } from '@server/database/schema';
import { hashPassword, verifyPassword } from '@server/platform/password';
import { readSession, signSession } from '@server/platform/jwt';
import { loadRoleCodes } from '@server/platform/session.middleware';
import { SessionStore } from '@server/platform/session-store';
import { DRIZZLE_DATABASE } from '@server/platform/tokens';
import { decryptSecret, encryptSecret, secretKeyFromEnv } from '@server/common/security/secret-box';
import { listCapabilities } from '@shared/rbac';
import { isProductionRuntime } from '@server/common/utils/runtime-env';
import { DEFAULT_LOCKOUT_POLICY, LoginSecurityService } from './login-security.service';

const ROLES: Array<{ code: string; name: string }> = [
  { code: 'admin', name: '管理员' },
  { code: 'user_admin', name: '用户管理员' },
  { code: 'finance_viewer', name: '财务查看' },
  { code: 'hr_manager', name: '人事经理' },
  { code: 'drive_editor', name: '云盘编辑' },
  { code: 'project_manager', name: '项目经理' },
];

export interface AuthUser {
  userId: string;
  userName: string;
  roles: string[];
  email?: string | null;
  capabilities?: string[];
}

/** B-04：密码登录结果——可能直接签发会话，也可能要求二次验证 */
export type PasswordLoginResult =
  | {
      mfaRequired: false;
      /** true 表示强制 MFA 但尚未绑定：会话只能调 mfa/setup|confirm|status。 */
      mfaSetupRequired?: boolean;
      token: string;
      user: AuthUser;
    }
  | { mfaRequired: true; mfaToken: string; expiresAt: string; userName: string };

export interface LoginContext {
  ip?: string | null;
  userAgent?: string | null;
}

interface FeishuUserInfo {
  open_id?: string;
  union_id?: string;
  name?: string;
  email?: string;
  mobile?: string;
}

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly sessions: SessionStore,
    private readonly security: LoginSecurityService,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const role of ROLES) {
      await this.db.insert(sysRole).values(role).onConflictDoNothing();
    }
    const existing = await this.db.select({ id: sysUser.id }).from(sysUser).limit(1);
    if (existing.length > 0) return;
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    const username = (process.env.BOOTSTRAP_ADMIN_USERNAME ?? 'admin').trim();
    if (!password || password.length < 8) {
      throw new Error('创建初始管理员需要至少 8 位的 BOOTSTRAP_ADMIN_PASSWORD');
    }
    if (!username) {
      throw new Error('BOOTSTRAP_ADMIN_USERNAME 不能为空');
    }
    // B-04：初始密码同样要过密码策略（否则上线第一个账号就是弱口令）
    const validation = this.security.validatePassword(password, undefined, { username });
    if (!validation.ok) {
      throw new Error(
        `BOOTSTRAP_ADMIN_PASSWORD 不符合密码策略：${validation.errors.join('；')}`
      );
    }
    const [admin] = await this.db
      .insert(sysUser)
      .values({
        username,
        displayName: '系统管理员',
        email: username.includes('@') ? username : null,
        passwordHash: hashPassword(password),
        status: 'active',
        passwordChangedAt: new Date(),
      })
      .returning({ id: sysUser.id });
    await this.db.insert(sysRoleMember).values({ roleCode: 'admin', userId: admin.id });
    this.logger.warn(`已创建初始账号 ${username}，请立即更换密码并清空 BOOTSTRAP_ADMIN_PASSWORD`);
  }

  /**
   * B-04：密码登录（含锁定判定、登录审计、MFA 二次验证）。
   * 返回 `mfaRequired: true` 时尚未签发正式会话，必须先调 `verifyMfaLogin`。
   */
  async login(
    username: string,
    password: string,
    context: LoginContext = {}
  ): Promise<PasswordLoginResult> {
    const normalized = (username ?? '').trim();
    const rows = await this.db
      .select()
      .from(sysUser)
      .where(eq(sysUser.username, normalized))
      .limit(1);
    const user = rows[0];
    if (!user) {
      await this.security.writeLoginAudit({
        username: normalized,
        result: 'failed',
        reason: 'bad_credentials',
        authMethod: 'password',
        ip: context.ip,
        userAgent: context.userAgent,
      });
      throw new UnauthorizedException('账号或密码错误');
    }
    if (user.status !== 'active') {
      await this.security.writeLoginAudit({
        username: normalized,
        userId: user.id,
        result: 'failed',
        reason: 'disabled',
        authMethod: 'password',
        ip: context.ip,
        userAgent: context.userAgent,
      });
      throw new UnauthorizedException('账号已停用，请联系管理员');
    }
    // 锁定判定（先于密码校验，避免对已锁定账号做昂贵的 scrypt 计算）
    try {
      await this.security.assertNotLocked(user.id, DEFAULT_LOCKOUT_POLICY);
    } catch (error) {
      await this.security.writeLoginAudit({
        username: normalized,
        userId: user.id,
        result: 'locked',
        reason: 'locked',
        authMethod: 'password',
        ip: context.ip,
        userAgent: context.userAgent,
      });
      throw error;
    }
    if (!user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      const outcome = await this.security.recordFailedLogin(
        user.id,
        DEFAULT_LOCKOUT_POLICY
      );
      await this.security.writeLoginAudit({
        username: normalized,
        userId: user.id,
        result: outcome.locked ? 'locked' : 'failed',
        reason: outcome.locked
          ? 'locked'
          : `bad_credentials(${outcome.attempts}/${DEFAULT_LOCKOUT_POLICY.maxAttempts})`,
        authMethod: 'password',
        ip: context.ip,
        userAgent: context.userAgent,
      });
      if (outcome.locked) {
        throw new UnauthorizedException(
          `密码错误次数过多，账号已锁定 ${DEFAULT_LOCKOUT_POLICY.lockMinutes} 分钟；请联系管理员解锁`
        );
      }
      throw new UnauthorizedException('账号或密码错误');
    }

    /*
     * P2-11：密码过期/管理员重置后的首改必须在登录时拦截。
     * 不能直接放行再靠前端提示——原实现 `isPasswordExpired` 从未被登录路径调用，
     * 90 天轮换与“重置后强制改密”都形同虚设。
     */
    const mustChangePassword =
      Number(user.mustChangePassword ?? 0) === 1 ||
      this.security.isPasswordExpired(user.passwordChangedAt);
    if (mustChangePassword) {
      await this.security.writeLoginAudit({
        username: normalized,
        userId: user.id,
        result: 'failed',
        reason: 'password_change_required',
        authMethod: 'password',
        ip: context.ip,
        userAgent: context.userAgent,
      });
      throw new HttpException(
        {
          code: 'PASSWORD_CHANGE_REQUIRED',
          message: '密码已过期或需首次修改，请先修改密码',
        },
        HttpStatus.FORBIDDEN,
      );
    }

    const roles = await loadRoleCodes(this.db, user.id);
    const mfaState = await this.security.mfaStatus(user.id);
    // 已启用 MFA，或角色强制 MFA 但尚未绑定 → 均不得直接签发会话
    if (mfaState.enabled) {
      const challenge = await this.security.createChallenge({
        userId: user.id,
        ip: context.ip ?? undefined,
        userAgent: context.userAgent ?? undefined,
      });
      await this.security.writeLoginAudit({
        username: normalized,
        userId: user.id,
        result: 'success',
        reason: 'mfa_challenge',
        authMethod: 'password',
        ip: context.ip,
        userAgent: context.userAgent,
      });
      return {
        mfaRequired: true,
        mfaToken: challenge.token,
        expiresAt: challenge.expiresAt.toISOString(),
        userName: user.displayName,
      };
    }
    if (mfaState.required) {
      /*
       * 强制 MFA 但尚未绑定：不能直接拒绝 —— 绑定入口本身需要登录，
       * 拒绝会让新装库/新角色的用户永远无法完成首登（实测过的死锁）。
       * 这里签发**受限会话**（mfaPending）：守卫只允许 mfa/status|setup|confirm、
       * logout、me；绑定确认后前端强制重新登录，再走正常的 TOTP 二次验证。
       */
      await this.security.writeLoginAudit({
        username: normalized,
        userId: user.id,
        result: 'success',
        reason: 'mfa_setup_required',
        authMethod: 'password',
        ip: context.ip,
        userAgent: context.userAgent,
      });
      await this.security.clearFailedLogin(user.id);
      const issued = await this.issue(
        user.id,
        user.displayName,
        user.email,
        context,
        'password',
        true,
      );
      return { mfaRequired: false, mfaSetupRequired: true, ...issued };
    }

    await this.security.clearFailedLogin(user.id);
    const issued = await this.issue(user.id, user.displayName, user.email, context, 'password');
    await this.security.writeLoginAudit({
      username: normalized,
      userId: user.id,
      result: 'success',
      authMethod: 'password',
      ip: context.ip,
      userAgent: context.userAgent,
    });
    return { mfaRequired: false, ...issued };
  }

  /** B-04：MFA 第二步校验，成功后签发正式会话 */
  async verifyMfaLogin(
    mfaToken: string,
    code: string,
    context: LoginContext = {}
  ): Promise<{ token: string; user: AuthUser }> {
    const userId = await this.security.consumeChallenge(mfaToken ?? '');
    if (!userId) {
      throw new UnauthorizedException('二次验证已超时或已使用，请重新登录');
    }
    const valid = await this.security.verifyMfa(userId, code ?? '');
    if (!valid) {
      await this.security.writeLoginAudit({
        userId,
        result: 'failed',
        reason: 'mfa_invalid',
        authMethod: 'totp',
        ip: context.ip,
        userAgent: context.userAgent,
      });
      throw new UnauthorizedException('动态验证码不正确');
    }
    const rows = await this.db
      .select({ displayName: sysUser.displayName, email: sysUser.email, username: sysUser.username })
      .from(sysUser)
      .where(eq(sysUser.id, userId))
      .limit(1);
    if (rows.length === 0) throw new UnauthorizedException('账号不存在');
    await this.security.clearFailedLogin(userId);
    const issued = await this.issue(
      userId,
      rows[0].displayName,
      rows[0].email,
      context,
      'mfa'
    );
    await this.security.writeLoginAudit({
      username: rows[0].username,
      userId,
      result: 'success',
      authMethod: 'mfa',
      ip: context.ip,
      userAgent: context.userAgent,
    });
    return issued;
  }

  async authorizeUrl(state: string): Promise<string> {
    const creds = await this.appCredentials();
    const redirect = encodeURIComponent(creds.redirect);
    return `https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=${encodeURIComponent(creds.appId)}&redirect_uri=${redirect}&response_type=code&state=${encodeURIComponent(state)}`;
  }

  async feishuLogin(code: string, bindUserId?: string): Promise<{ token: string; user: AuthUser }> {
    const creds = await this.appCredentials();
    const tokenResp = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: creds.appId,
        client_secret: creds.appSecret,
        code,
        redirect_uri: creds.redirect,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const tokenBody = (await tokenResp.json()) as {
      access_token?: string;
      refresh_token?: string;
      data?: { access_token?: string; refresh_token?: string };
    };
    const accessToken = tokenBody.access_token ?? tokenBody.data?.access_token;
    const refreshToken = tokenBody.refresh_token ?? tokenBody.data?.refresh_token;
    if (!accessToken) throw new UnauthorizedException('飞书授权失败');
    const infoResp = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    const info = (await infoResp.json()) as { data?: FeishuUserInfo };
    const openId = info.data?.open_id;
    const unionId = info.data?.union_id;
    if (!openId) throw new UnauthorizedException('飞书未返回 open_id');
    const name = info.data?.name || openId;
    let userId = bindUserId;
    if (userId) {
      const occupied = await this.db
        .select({ id: sysUser.id })
        .from(sysUser)
        .where(eq(sysUser.feishuOpenId, openId))
        .limit(1);
      if (occupied[0] && occupied[0].id !== userId) {
        throw new ConflictException('该飞书账号已绑定其他系统用户');
      }
      await this.db.update(sysUser).set({
        feishuOpenId: openId,
        feishuUnionId: unionId ?? null,
        email: info.data?.email ?? null,
        mobile: info.data?.mobile ?? null,
        authType: 'feishu',
        updatedAt: new Date(),
      }).where(eq(sysUser.id, userId));
    } else {
      const found = unionId
        ? await this.db.select().from(sysUser).where(eq(sysUser.feishuUnionId, unionId)).limit(1)
        : [];
      const byOpen = found[0]
        ? found
        : await this.db.select().from(sysUser).where(eq(sysUser.feishuOpenId, openId)).limit(1);
      userId = byOpen[0]?.id;
      if (!userId) {
        // L18：未绑定飞书账号禁止自动注册，需管理员先建账号或登录后绑定
        throw new UnauthorizedException(
          '该飞书账号尚未绑定系统用户，请联系管理员开通或使用账号密码登录后绑定飞书',
        );
      }
    }
    // B-04：飞书登录同样受"角色强制 MFA"约束，避免绕过二次验证
    const feishuMfaState = await this.security.mfaStatus(userId);
    if (feishuMfaState.enabled) {
      const challenge = await this.security.createChallenge({ userId });
      await this.security.writeLoginAudit({
        userId,
        result: 'success',
        reason: 'mfa_challenge',
        authMethod: 'feishu',
      });
      // 以异常形式携带挑战票据，控制器转换为 mfaRequired 响应
      throw new MfaRequiredException(challenge.token, challenge.expiresAt);
    }
    if (feishuMfaState.required) {
      await this.security.writeLoginAudit({
        userId,
        result: 'failed',
        reason: 'mfa_required',
        authMethod: 'feishu',
      });
      throw new UnauthorizedException(
        '该角色已强制启用双因素认证，请先使用密码登录并在设置页完成 MFA 绑定'
      );
    }
    await this.linkEmployee(userId, unionId, info.data?.email, info.data?.mobile);
    const issued = await this.issue(userId, name, info.data?.email, {}, 'feishu');
    if (refreshToken) {
      const key = secretKeyFromEnv();
      const claims = readSession(issued.token, process.env.JWT_SECRET ?? '');
      if (key && claims?.jti) {
        await this.sessions.storeRefreshToken(claims.jti, encryptSecret(refreshToken, key));
      }
    }
    await this.security.writeLoginAudit({
      userId,
      result: 'success',
      authMethod: 'feishu',
    });
    return issued;
  }

  async logout(token: string | null): Promise<void> {
    const secret = process.env.JWT_SECRET;
    if (!token || !secret) return;
    const claims = readSession(token, secret);
    if (claims?.jti) {
      await this.sessions.revoke(claims.jti);
      await this.security.writeLoginAudit({
        userId: claims.userId,
        result: 'logout',
        authMethod: 'session',
      });
    }
  }

  /**
   * P2-12：敏感操作（绑定飞书）前的再认证。
   * 仅凭一个有效会话不足以把攻击者飞书绑到账号上；必须再次证明密码，
   * 已启用 MFA 的账号还必须提供当前 TOTP/恢复码。
   */
  async verifyReauth(
    userId: string,
    password: string,
    mfaCode?: string,
  ): Promise<void> {
    const rows = await this.db
      .select()
      .from(sysUser)
      .where(eq(sysUser.id, userId))
      .limit(1);
    const user = rows[0];
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('账号不存在或已停用');
    }
    if (!user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException('当前密码不正确，无法执行该操作');
    }
    const mfa = await this.security.mfaStatus(userId);
    if (mfa.enabled) {
      if (!mfaCode || !(await this.security.verifyMfa(userId, mfaCode))) {
        throw new UnauthorizedException('MFA 验证码不正确或已过期');
      }
    }
  }

  /**
   * P2-11：登录被 `PASSWORD_CHANGE_REQUIRED` 拦截后的自助改密。
   * 需要用户名 + 当前密码重新证明身份；已启用 MFA 的账号还必须提供 TOTP，
   * 不能只凭“知道旧密码”就把账号密码换掉。
   */
  async changeExpiredPassword(input: {
    username: string;
    currentPassword: string;
    newPassword: string;
    mfaCode?: string;
  }): Promise<void> {
    const rows = await this.db
      .select()
      .from(sysUser)
      .where(eq(sysUser.username, input.username.trim()))
      .limit(1);
    const user = rows[0];
    if (!user || user.status !== 'active') {
      throw new UnauthorizedException('账号不存在或已停用');
    }
    if (!user.passwordHash || !verifyPassword(input.currentPassword, user.passwordHash)) {
      throw new UnauthorizedException('当前密码不正确');
    }
    const mfa = await this.security.mfaStatus(user.id);
    if (mfa.enabled) {
      if (!input.mfaCode || !(await this.security.verifyMfa(user.id, input.mfaCode))) {
        throw new UnauthorizedException('MFA 验证码不正确或已过期');
      }
    }
    await this.security.changePassword({
      userId: user.id,
      newPassword: input.newPassword,
      currentPassword: input.currentPassword,
    });
    await this.security.writeLoginAudit({
      username: input.username,
      userId: user.id,
      result: 'unlock',
      reason: 'password_changed_after_expiry',
      authMethod: 'password',
    });
  }

  async me(userId: string): Promise<(AuthUser & {
    mfaEnabled: boolean;
    mfaRequired: boolean;
    passwordExpired: boolean;
    mustChangePassword: boolean;
  }) | null> {
    const rows = await this.db.select().from(sysUser).where(eq(sysUser.id, userId)).limit(1);
    const user = rows[0];
    if (!user || user.status !== 'active') return null;
    const roles = await loadRoleCodes(this.db, user.id);
    const mfaState = await this.security.mfaStatus(user.id);
    return {
      userId: user.id,
      userName: user.displayName,
      roles,
      email: user.email,
      capabilities: listCapabilities(roles),
      mfaEnabled: mfaState.enabled,
      mfaRequired: mfaState.required,
      passwordExpired: this.security.isPasswordExpired(user.passwordChangedAt),
      mustChangePassword: Number(user.mustChangePassword ?? 0) === 1,
    };
  }

  private async issue(
    userId: string,
    userName: string,
    email: string | null | undefined,
    context: LoginContext,
    authMethod: 'password' | 'feishu' | 'mfa',
    mfaPending = false,
  ) {
    const account = await this.db.select({ status: sysUser.status }).from(sysUser).where(eq(sysUser.id, userId)).limit(1);
    if (account[0]?.status !== 'active') throw new UnauthorizedException('账号已停用');
    const roles = await loadRoleCodes(this.db, userId);
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new UnauthorizedException('未配置 JWT_SECRET');
    const token = signSession(
      { userId, userName, roles, ...(mfaPending ? { mfaPending: true } : {}) },
      secret,
      60 * 60 * 24 * 7,
    );
    const claims = readSession(token, secret);
    if (claims?.jti) {
      await this.sessions.record(userId, claims.jti, new Date(claims.exp * 1000));
      // B-04：会话设备信息（供"登录设备管理"展示与远程下线）
      await this.security.tagSession({
        jti: claims.jti,
        ip: context.ip,
        userAgent: context.userAgent,
        authMethod,
      });
    }
    await this.db.update(sysUser).set({ lastLoginAt: new Date() }).where(eq(sysUser.id, userId));
    return {
      token,
      user: {
        userId,
        userName,
        roles,
        email,
        capabilities: listCapabilities(roles),
      },
    };
  }

  private requireRedirectUri(): string {
    const redirect = (process.env.FEISHU_REDIRECT_URI ?? '').trim();
    if (!redirect) {
      throw new ServiceUnavailableException('飞书应用凭证未配置：缺少 FEISHU_REDIRECT_URI');
    }
    if (!isProductionRuntime()) {
      const appBase = (process.env.APP_BASE_URL ?? '').trim();
      if (appBase) {
        try {
          const redirectHost = new URL(redirect).hostname;
          const appHost = new URL(appBase).hostname;
          if (redirectHost !== appHost) {
            this.logger.warn(
              `FEISHU_REDIRECT_URI 宿主(${redirectHost}) 与 APP_BASE_URL(${appHost}) 不一致，OAuth state Cookie 可能失效`,
            );
          }
        } catch {
          /* ignore invalid URL in warn path */
        }
      }
    }
    return redirect;
  }

  private async appCredentials(): Promise<{ appId: string; appSecret: string; redirect: string }> {
    const redirect = this.requireRedirectUri();
    try {
      const rows = await this.db.execute(sql`
        select app_id, app_secret
        from comp_feishu_drive_config
        where coalesce(app_id, '') <> '' and coalesce(app_secret, '') <> ''
        limit 1
      `);
      const row = rows[0] as { app_id?: string; app_secret?: string } | undefined;
      if (row?.app_id && row.app_secret) {
        return {
          appId: row.app_id,
          appSecret: decryptSecret(row.app_secret, secretKeyFromEnv()),
          redirect,
        };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`数据库飞书凭证不可用，改读环境变量 ${message}`);
    }
    const appId = process.env.FEISHU_APP_ID ?? '';
    const appSecret = process.env.FEISHU_APP_SECRET ?? '';
    if (!appId || !appSecret) {
      throw new ServiceUnavailableException('飞书应用凭证未配置');
    }
    return { appId, appSecret, redirect };
  }

  private async linkEmployee(userId: string, unionId?: string, email?: string, mobile?: string): Promise<void> {
    if (unionId) {
      const byUnion = await this.db.select({ id: mdEmployee.id }).from(mdEmployee).where(eq(mdEmployee.feishuUnionId, unionId)).limit(2);
      if (byUnion.length === 1) {
        await this.db.update(sysUser).set({ employeeId: byUnion[0].id }).where(eq(sysUser.id, userId));
        return;
      }
    }
    const matches = email
      ? await this.db.select({ id: mdEmployee.id }).from(mdEmployee).where(eq(mdEmployee.email, email)).limit(2)
      : mobile
        ? await this.db.select({ id: mdEmployee.id }).from(mdEmployee).where(eq(mdEmployee.phone, mobile)).limit(2)
        : [];
    if (matches.length === 1) {
      await this.db.update(sysUser).set({ employeeId: matches[0].id }).where(eq(sysUser.id, userId));
      if (unionId) {
        await this.db.update(mdEmployee).set({ feishuUnionId: unionId }).where(eq(mdEmployee.id, matches[0].id));
      }
      return;
    }
    if (matches.length > 1 && unionId) {
      await this.db.insert(sysFeishuSyncConflict).values({
        unionId,
        reason: 'multi_employee',
        payload: JSON.stringify({ email: email ?? null, mobile: mobile ?? null }),
      });
    }
  }
}

/** 飞书登录命中 MFA 时抛出的内部异常，由控制器转成 mfaRequired 响应 */
export class MfaRequiredException extends UnauthorizedException {
  constructor(
    readonly mfaToken: string,
    readonly expiresAt: Date
  ) {
    super('需要二次验证');
    this.name = 'MfaRequiredException';
  }
}

/** 供控制器复用的密码策略错误提示（避免直接抛 400 时缺少上下文） */
export function assertPasswordPolicy(
  service: LoginSecurityService,
  password: string,
  username?: string
): void {
  const result = service.validatePassword(password, undefined, { username });
  if (!result.ok) {
    throw new BadRequestException(`密码不符合策略：${result.errors.join('；')}`);
  }
}
