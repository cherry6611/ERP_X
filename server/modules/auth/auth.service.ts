import { Injectable, Logger, OnModuleInit, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
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

const ROLES: Array<{ code: string; name: string }> = [
  { code: 'admin', name: '管理员' },
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
  ) {}

  async onModuleInit(): Promise<void> {
    for (const role of ROLES) {
      await this.db.insert(sysRole).values(role).onConflictDoNothing();
    }
    const existing = await this.db.select({ id: sysUser.id }).from(sysUser).limit(1);
    if (existing.length > 0) return;
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
    if (!password || password.length < 12) {
      throw new Error('创建初始管理员需要至少 12 位的 BOOTSTRAP_ADMIN_PASSWORD');
    }
    const [admin] = await this.db
      .insert(sysUser)
      .values({
        username: 'admin',
        displayName: '系统管理员',
        passwordHash: hashPassword(password),
        status: 'active',
      })
      .returning({ id: sysUser.id });
    await this.db.insert(sysRoleMember).values({ roleCode: 'admin', userId: admin.id });
    this.logger.warn('已创建初始账号 admin，请立即更换密码并清空 BOOTSTRAP_ADMIN_PASSWORD');
  }

  async login(username: string, password: string): Promise<{ token: string; user: AuthUser }> {
    const rows = await this.db.select().from(sysUser).where(eq(sysUser.username, username)).limit(1);
    const user = rows[0];
    if (!user?.passwordHash || user.status !== 'active' || !verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException('账号或密码错误');
    }
    return this.issue(user.id, user.displayName, user.email);
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
    });
    const info = (await infoResp.json()) as { data?: FeishuUserInfo };
    const openId = info.data?.open_id;
    const unionId = info.data?.union_id;
    if (!openId) throw new UnauthorizedException('飞书未返回 open_id');
    const name = info.data?.name || openId;
    let userId = bindUserId;
    if (userId) {
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
        const [created] = await this.db.insert(sysUser).values({
          username: unionId || openId,
          displayName: name,
          feishuOpenId: openId,
          feishuUnionId: unionId ?? null,
          email: info.data?.email,
          mobile: info.data?.mobile,
          authType: 'feishu',
          status: 'active',
        }).returning({ id: sysUser.id });
        userId = created.id;
      }
    }
    await this.linkEmployee(userId, unionId, info.data?.email, info.data?.mobile);
    const issued = await this.issue(userId, name, info.data?.email);
    if (refreshToken) {
      const key = secretKeyFromEnv();
      const claims = readSession(issued.token, process.env.JWT_SECRET ?? '');
      if (key && claims?.jti) {
        await this.sessions.storeRefreshToken(claims.jti, encryptSecret(refreshToken, key));
      }
    }
    return issued;
  }

  async logout(token: string | null): Promise<void> {
    const secret = process.env.JWT_SECRET;
    if (!token || !secret) return;
    const claims = readSession(token, secret);
    if (claims?.jti) await this.sessions.revoke(claims.jti);
  }

  async me(userId: string): Promise<AuthUser | null> {
    const rows = await this.db.select().from(sysUser).where(eq(sysUser.id, userId)).limit(1);
    const user = rows[0];
    if (!user || user.status !== 'active') return null;
    const roles = await loadRoleCodes(this.db, user.id);
    return { userId: user.id, userName: user.displayName, roles, email: user.email };
  }

  private async issue(userId: string, userName: string, email?: string | null) {
    const account = await this.db.select({ status: sysUser.status }).from(sysUser).where(eq(sysUser.id, userId)).limit(1);
    if (account[0]?.status !== 'active') throw new UnauthorizedException('账号已停用');
    const roles = await loadRoleCodes(this.db, userId);
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new UnauthorizedException('未配置 JWT_SECRET');
    const token = signSession({ userId, userName, roles }, secret, 60 * 60 * 24 * 7);
    const claims = readSession(token, secret);
    if (claims?.jti) {
      await this.sessions.record(userId, claims.jti, new Date(claims.exp * 1000));
    }
    await this.db.update(sysUser).set({ lastLoginAt: new Date() }).where(eq(sysUser.id, userId));
    return { token, user: { userId, userName, roles, email } };
  }

  private async appCredentials(): Promise<{ appId: string; appSecret: string; redirect: string }> {
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
          redirect: process.env.FEISHU_REDIRECT_URI ?? '',
        };
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`数据库飞书凭证不可用，改读环境变量 ${message}`);
    }
    const appId = process.env.FEISHU_APP_ID ?? '';
    const appSecret = process.env.FEISHU_APP_SECRET ?? '';
    const redirect = process.env.FEISHU_REDIRECT_URI ?? '';
    if (!appId || !appSecret || !redirect) {
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
