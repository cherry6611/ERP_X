import { Injectable, Logger, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { sysRole, sysRoleMember, sysUser } from '@server/database/schema';
import { hashPassword, verifyPassword } from '@server/platform/password';
import { signSession } from '@server/platform/jwt';
import { loadRoleCodes } from '@server/platform/session.middleware';
import { DRIZZLE_DATABASE } from '@server/platform/tokens';

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

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(@Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase) {}

  async onModuleInit(): Promise<void> {
    for (const role of ROLES) {
      await this.db.insert(sysRole).values(role).onConflictDoNothing();
    }
    const existing = await this.db.select({ id: sysUser.id }).from(sysUser).limit(1);
    if (existing.length > 0) return;
    const password = process.env.BOOTSTRAP_ADMIN_PASSWORD || 'ChangeMe!2026';
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
    this.logger.warn('已创建初始账号 admin，请立即修改 BOOTSTRAP_ADMIN_PASSWORD');
  }

  async login(username: string, password: string): Promise<{ token: string; user: AuthUser }> {
    const rows = await this.db.select().from(sysUser).where(eq(sysUser.username, username)).limit(1);
    const user = rows[0];
    if (!user?.passwordHash || user.status !== 'active' || !verifyPassword(password, user.passwordHash)) {
      throw new UnauthorizedException('账号或密码错误');
    }
    return this.issue(user.id, user.displayName, user.email);
  }

  async feishuLogin(code: string): Promise<{ token: string; user: AuthUser }> {
    const appId = process.env.FEISHU_APP_ID;
    const appSecret = process.env.FEISHU_APP_SECRET;
    const redirect = process.env.FEISHU_REDIRECT_URI;
    if (!appId || !appSecret || !redirect) {
      throw new UnauthorizedException('未配置飞书登录');
    }
    const tokenResp = await fetch('https://open.feishu.cn/open-apis/authen/v2/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: appId,
        client_secret: appSecret,
        code,
        redirect_uri: redirect,
      }),
    });
    const tokenBody = (await tokenResp.json()) as { access_token?: string; data?: { access_token?: string } };
    const accessToken = tokenBody.access_token ?? tokenBody.data?.access_token;
    if (!accessToken) throw new UnauthorizedException('飞书授权失败');
    const infoResp = await fetch('https://open.feishu.cn/open-apis/authen/v1/user_info', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const info = (await infoResp.json()) as {
      data?: { open_id?: string; name?: string; email?: string };
    };
    const openId = info.data?.open_id;
    if (!openId) throw new UnauthorizedException('飞书未返回 open_id');
    const name = info.data?.name || openId;
    const found = await this.db.select().from(sysUser).where(eq(sysUser.feishuOpenId, openId)).limit(1);
    let userId = found[0]?.id;
    if (!userId) {
      const [created] = await this.db
        .insert(sysUser)
        .values({
          username: openId,
          displayName: name,
          feishuOpenId: openId,
          email: info.data?.email,
          status: 'active',
        })
        .returning({ id: sysUser.id });
      userId = created.id;
    }
    await this.db.execute(sql`
      update md_employee
      set platform_user_id = ROW(${openId}, ${name})::user_profile
      where name = ${name} and platform_user_id is null
    `);
    return this.issue(userId, name, info.data?.email);
  }

  async me(userId: string): Promise<AuthUser | null> {
    const rows = await this.db.select().from(sysUser).where(eq(sysUser.id, userId)).limit(1);
    const user = rows[0];
    if (!user) return null;
    const roles = await loadRoleCodes(this.db, user.id);
    return { userId: user.id, userName: user.displayName, roles, email: user.email };
  }

  private async issue(userId: string, userName: string, email?: string | null) {
    const roles = await loadRoleCodes(this.db, userId);
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new UnauthorizedException('未配置 JWT_SECRET');
    const token = signSession({ userId, userName, roles }, secret, 60 * 60 * 24 * 7);
    return { token, user: { userId, userName, roles, email } };
  }
}
