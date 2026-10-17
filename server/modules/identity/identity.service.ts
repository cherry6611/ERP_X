import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import {
  mdEmployee,
  sysFeishuBindInvite,
  sysLoginSession,
  sysRoleMember,
  sysUser,
} from '@server/database/schema';
import { DRIZZLE_DATABASE } from '@server/platform/tokens';
import { hashPassword } from '@server/platform/password';
import { SessionStore } from '@server/platform/session-store';
import { AuditService } from '@server/modules/audit/audit.service';
import {
  DEFAULT_PASSWORD_POLICY,
  LoginSecurityService,
} from '@server/modules/auth/login-security.service';
import { ROLE_CODES } from '@shared/rbac';

export interface IdentityUserItem {
  id: string;
  username: string;
  displayName: string;
  status: string;
  email: string | null;
  mobile: string | null;
  roles: string[];
  employeeId: string | null;
  employeeName: string | null;
  feishuBound: boolean;
  feishuOpenId: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

@Injectable()
export class IdentityService {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly sessions: SessionStore,
    private readonly audit: AuditService,
  ) {}

  async listUsers(params: {
    q?: string;
    status?: string;
    role?: string;
  }): Promise<IdentityUserItem[]> {
    const rows = await this.db.select().from(sysUser).orderBy(desc(sysUser.createdAt)).limit(500);
    const userIds = rows.map((r) => r.id);
    const roleRows =
      userIds.length === 0
        ? []
        : await this.db
            .select()
            .from(sysRoleMember)
            .where(inArray(sysRoleMember.userId, userIds));
    const rolesByUser = new Map<string, string[]>();
    for (const row of roleRows) {
      const list = rolesByUser.get(row.userId) ?? [];
      list.push(row.roleCode);
      rolesByUser.set(row.userId, list);
    }
    const empIds = rows.map((r) => r.employeeId).filter((id): id is string => Boolean(id));
    const emps =
      empIds.length === 0
        ? []
        : await this.db.select({ id: mdEmployee.id, name: mdEmployee.name }).from(mdEmployee).where(inArray(mdEmployee.id, empIds));
    const empName = new Map(emps.map((e) => [e.id, e.name]));

    let items = rows.map((row) => ({
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      status: row.status,
      email: row.email,
      mobile: row.mobile,
      roles: rolesByUser.get(row.id) ?? [],
      employeeId: row.employeeId,
      employeeName: row.employeeId ? empName.get(row.employeeId) ?? null : null,
      feishuBound: Boolean(row.feishuOpenId || row.feishuUnionId),
      feishuOpenId: row.feishuOpenId,
      lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));

    if (params.status) {
      items = items.filter((u) => u.status === params.status);
    }
    if (params.role) {
      items = items.filter((u) => u.roles.includes(params.role!));
    }
    if (params.q?.trim()) {
      const q = params.q.trim().toLowerCase();
      items = items.filter(
        (u) =>
          u.username.toLowerCase().includes(q) ||
          u.displayName.toLowerCase().includes(q) ||
          (u.employeeName ?? '').toLowerCase().includes(q),
      );
    }
    return items;
  }

  async createUser(
    actor: { userId: string; roles: string[] },
    dto: {
      username: string;
      displayName: string;
      password?: string;
      employeeId?: string;
      roles?: string[];
      email?: string;
      mobile?: string;
    },
  ): Promise<IdentityUserItem> {
    const username = dto.username.trim();
    if (!username || username.length < 2) throw new BadRequestException('用户名至少 2 位');
    const displayName = dto.displayName.trim() || username;
    const roles = this.sanitizeRoles(dto.roles ?? [], actor.roles);
    const existing = await this.db.select({ id: sysUser.id }).from(sysUser).where(eq(sysUser.username, username)).limit(1);
    if (existing[0]) throw new ConflictException('用户名已存在');

    if (dto.employeeId) {
      await this.assertEmployeeFree(dto.employeeId);
    }

    const password = dto.password?.trim() || this.generateTemporaryPassword();
    this.assertPasswordPolicy(password, username);

    const [created] = await this.db
      .insert(sysUser)
      .values({
        username,
        displayName,
        passwordHash: hashPassword(password),
        status: 'active',
        authType: 'local',
        employeeId: dto.employeeId || null,
        email: dto.email?.trim() || null,
        mobile: dto.mobile?.trim() || null,
      })
      .returning();

    if (roles.length > 0) {
      await this.db.insert(sysRoleMember).values(roles.map((roleCode) => ({ roleCode, userId: created.id })));
    }

    if (dto.employeeId) {
      await this.db
        .update(mdEmployee)
        .set({ platformUserId: created.id })
        .where(eq(mdEmployee.id, dto.employeeId));
    }

    await this.audit.record({
      actor: actor.userId,
      action: 'identity.create',
      objectType: 'sys_user',
      objectId: created.id,
      objectCode: username,
      detail: JSON.stringify({ roles, employeeId: dto.employeeId ?? null }),
    });

    const list = await this.listUsers({});
    const item = list.find((u) => u.id === created.id);
    if (!item) throw new NotFoundException('用户创建失败');
    return Object.assign(item, { temporaryPassword: password });
  }

  async updateUser(
    actor: { userId: string; roles: string[] },
    id: string,
    dto: { displayName?: string; email?: string | null; mobile?: string | null; employeeId?: string | null },
  ): Promise<IdentityUserItem> {
    const user = await this.requireUser(id);
    this.assertCanManageUser(actor.roles, user);
    if (dto.employeeId && dto.employeeId !== user.employeeId) {
      await this.assertEmployeeFree(dto.employeeId, id);
    }
    await this.db
      .update(sysUser)
      .set({
        displayName: dto.displayName?.trim() || user.displayName,
        email: dto.email === undefined ? user.email : dto.email,
        mobile: dto.mobile === undefined ? user.mobile : dto.mobile,
        employeeId: dto.employeeId === undefined ? user.employeeId : dto.employeeId,
        updatedAt: new Date(),
      })
      .where(eq(sysUser.id, id));

    await this.audit.record({
      actor: actor.userId,
      action: 'identity.update',
      objectType: 'sys_user',
      objectId: id,
      objectCode: user.username,
    });
    const list = await this.listUsers({});
    const found = list.find((u) => u.id === id);
    if (!found) throw new NotFoundException('用户不存在');
    return found;
  }

  async setStatus(actor: { userId: string; roles: string[] }, id: string, status: 'active' | 'disabled'): Promise<void> {
    const user = await this.requireUser(id);
    this.assertCanManageUser(actor.roles, user);
    if (id === actor.userId && status === 'disabled') {
      throw new BadRequestException('不能禁用自己的账号');
    }
    if (user.roles.includes('admin') && status === 'disabled') {
      await this.assertNotLastAdmin(id);
    }
    await this.db.update(sysUser).set({ status, updatedAt: new Date() }).where(eq(sysUser.id, id));
    if (status === 'disabled') {
      await this.sessions.revokeUser(id);
    }
    await this.audit.record({
      actor: actor.userId,
      action: status === 'disabled' ? 'identity.disable' : 'identity.enable',
      objectType: 'sys_user',
      objectId: id,
      objectCode: user.username,
    });
  }

  async setRoles(actor: { userId: string; roles: string[] }, id: string, roles: string[]): Promise<void> {
    const user = await this.requireUser(id);
    this.assertCanManageUser(actor.roles, user);
    if (id === actor.userId) {
      throw new ForbiddenException('不能修改自己的角色；请联系其他管理员操作');
    }
    const next = this.sanitizeRoles(roles, actor.roles);
    const wasAdmin = user.roles.includes('admin');
    const willAdmin = next.includes('admin');
    if (wasAdmin && !willAdmin) {
      await this.assertNotLastAdmin(id);
    }
    await this.db.delete(sysRoleMember).where(eq(sysRoleMember.userId, id));
    if (next.length > 0) {
      await this.db.insert(sysRoleMember).values(next.map((roleCode) => ({ roleCode, userId: id })));
    }
    await this.audit.record({
      actor: actor.userId,
      action: 'identity.set_roles',
      objectType: 'sys_user',
      objectId: id,
      objectCode: user.username,
      detail: JSON.stringify({ roles: next }),
    });
    /*
     * 角色变更必须让旧 token 失效：JWT 内嵌 roles，若只改 sys_role_member，
     * 被降权者仍能凭旧 token 通过 @CanCapability 检查，最长 7 天。
     */
    await this.sessions.revokeUser(id);
  }

  async resetPassword(
    actor: { userId: string; roles: string[] },
    id: string,
    password?: string,
  ): Promise<{ temporaryPassword: string }> {
    const user = await this.requireUser(id);
    this.assertCanManageUser(actor.roles, user);
    const temporaryPassword =
      password?.trim() || this.generateTemporaryPassword();
    this.assertPasswordPolicy(temporaryPassword, user.username ?? undefined);
    await this.db
      .update(sysUser)
      .set({
        passwordHash: hashPassword(temporaryPassword),
        mustChangePassword: 1,
        passwordChangedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(sysUser.id, id));
    await this.sessions.revokeUser(id);
    await this.audit.record({
      actor: actor.userId,
      action: 'identity.reset_password',
      objectType: 'sys_user',
      objectId: id,
      objectCode: user.username,
    });
    return { temporaryPassword };
  }

  async listSessions(userId: string): Promise<Array<{ id: string; jti: string; expiresAt: string; revokedAt: string | null; createdAt: string }>> {
    await this.requireUser(userId);
    const rows = await this.db
      .select()
      .from(sysLoginSession)
      .where(eq(sysLoginSession.userId, userId))
      .orderBy(desc(sysLoginSession.createdAt))
      .limit(50);
    return rows.map((r) => ({
      id: r.id,
      jti: r.jti,
      expiresAt: r.expiresAt.toISOString(),
      revokedAt: r.revokedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async revokeSession(
    actor: { userId: string; roles: string[] },
    userId: string,
    jti: string,
  ): Promise<void> {
    const target = await this.requireUser(userId);
    this.assertCanManageUser(actor.roles, target);
    await this.sessions.revoke(jti);
    await this.audit.record({
      actor: actor.userId,
      action: 'identity.revoke_session',
      objectType: 'sys_user',
      objectId: userId,
      detail: JSON.stringify({ jti }),
    });
  }

  async revokeAllSessions(
    actor: { userId: string; roles: string[] },
    userId: string,
  ): Promise<void> {
    const target = await this.requireUser(userId);
    this.assertCanManageUser(actor.roles, target);
    await this.sessions.revokeUser(userId);
    await this.audit.record({
      actor: actor.userId,
      action: 'identity.revoke_all_sessions',
      objectType: 'sys_user',
      objectId: userId,
    });
  }

  async createFeishuInvite(
    actor: { userId: string; roles: string[] },
    targetUserId: string,
  ): Promise<{ token: string; inviteUrl: string; expiresAt: string }> {
    const target = await this.requireUser(targetUserId);
    this.assertCanManageUser(actor.roles, target);
    const token = randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000);
    await this.db.insert(sysFeishuBindInvite).values({
      token,
      targetUserId,
      createdBy: actor.userId,
      expiresAt,
    });
    const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
    const inviteUrl = `${base}/login?bind_invite=${encodeURIComponent(token)}`;
    await this.audit.record({
      actor: actor.userId,
      action: 'identity.feishu_invite',
      objectType: 'sys_user',
      objectId: targetUserId,
    });
    return { token, inviteUrl, expiresAt: expiresAt.toISOString() };
  }

  async revokeFeishuInvite(actor: { userId: string }, targetUserId: string): Promise<void> {
    await this.db
      .update(sysFeishuBindInvite)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sysFeishuBindInvite.targetUserId, targetUserId),
          isNull(sysFeishuBindInvite.consumedAt),
          isNull(sysFeishuBindInvite.revokedAt),
        ),
      );
    await this.audit.record({
      actor: actor.userId,
      action: 'identity.feishu_invite_revoke',
      objectType: 'sys_user',
      objectId: targetUserId,
    });
  }

  async unbindFeishu(
    actor: { userId: string; roles: string[] },
    targetUserId: string,
  ): Promise<void> {
    const user = await this.requireUser(targetUserId);
    this.assertCanManageUser(actor.roles, user);
    await this.db
      .update(sysUser)
      .set({
        feishuOpenId: null,
        feishuUnionId: null,
        authType: 'local',
        updatedAt: new Date(),
      })
      .where(eq(sysUser.id, targetUserId));
    await this.audit.record({
      actor: actor.userId,
      action: 'identity.feishu_unbind',
      objectType: 'sys_user',
      objectId: targetUserId,
      objectCode: user.username,
    });
  }

  /** B2：通讯录点选绑定（open_id / union_id 写入目标账号） */
  async bindFeishuContact(
    actor: { userId: string },
    targetUserId: string,
    dto: { openId: string; unionId?: string; name?: string },
  ): Promise<IdentityUserItem> {
    await this.requireUser(targetUserId);
    if (!dto.openId?.trim()) {
      throw new BadRequestException('openId 必填');
    }
    const occupied = await this.db
      .select({ id: sysUser.id, username: sysUser.username })
      .from(sysUser)
      .where(eq(sysUser.feishuOpenId, dto.openId.trim()))
      .limit(1);
    if (occupied[0] && occupied[0].id !== targetUserId) {
      throw new ConflictException(
        `该飞书账号已绑定用户 ${occupied[0].username}`,
      );
    }
    const patch: {
      feishuOpenId: string;
      feishuUnionId: string | null;
      authType: string;
      updatedAt: Date;
      displayName?: string;
    } = {
      feishuOpenId: dto.openId.trim(),
      feishuUnionId: dto.unionId?.trim() || null,
      authType: 'feishu',
      updatedAt: new Date(),
    };
    if (dto.name?.trim()) patch.displayName = dto.name.trim();
    await this.db.update(sysUser).set(patch).where(eq(sysUser.id, targetUserId));
    await this.audit.record({
      actor: actor.userId,
      action: 'identity.feishu_bind_contact',
      objectType: 'sys_user',
      objectId: targetUserId,
    });
    const list = await this.listUsers({});
    const item = list.find((u) => u.id === targetUserId);
    if (!item) throw new NotFoundException('用户不存在');
    return item;
  }

  /** 供 auth callback 使用：校验并核销邀请，返回 targetUserId */
  async consumeInviteToken(token: string): Promise<string> {
    const rows = await this.db
      .select()
      .from(sysFeishuBindInvite)
      .where(eq(sysFeishuBindInvite.token, token))
      .limit(1);
    const invite = rows[0];
    if (!invite) throw new BadRequestException('邀请无效或已过期');
    if (invite.revokedAt) throw new BadRequestException('邀请已撤销');
    if (invite.consumedAt) throw new BadRequestException('邀请已使用');
    if (invite.expiresAt.getTime() <= Date.now()) throw new BadRequestException('邀请已过期');
    await this.db
      .update(sysFeishuBindInvite)
      .set({ consumedAt: new Date() })
      .where(eq(sysFeishuBindInvite.id, invite.id));
    return invite.targetUserId;
  }

  async peekInviteToken(token: string): Promise<{ targetUserId: string; expiresAt: Date } | null> {
    const rows = await this.db
      .select()
      .from(sysFeishuBindInvite)
      .where(eq(sysFeishuBindInvite.token, token))
      .limit(1);
    const invite = rows[0];
    if (!invite || invite.revokedAt || invite.consumedAt || invite.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    return { targetUserId: invite.targetUserId, expiresAt: invite.expiresAt };
  }

  private sanitizeRoles(roles: string[], actorRoles: string[]): string[] {
    const allowed = new Set<string>(ROLE_CODES);
    const next = [...new Set(roles.map((r) => r.trim()).filter((r) => allowed.has(r)))];
    if (next.includes('admin') && !actorRoles.includes('admin')) {
      throw new ForbiddenException('仅超级管理员可授予 admin 角色');
    }
    return next;
  }

  private async requireUser(id: string): Promise<IdentityUserItem> {
    const list = await this.listUsers({});
    const found = list.find((u) => u.id === id);
    if (!found) throw new NotFoundException('用户不存在');
    return found;
  }

  /**
   * 账号管理员（user_admin）不得操作超级管理员账号。
   *
   * 原实现只拦"非 admin 授予 admin 角色"，但 resetPassword / setStatus /
   * revokeAllSessions 等都能直接作用在 admin 账号上：user_admin 重置 admin
   * 密码后即可用新密码登录成 admin。这里统一在服务层收口，控制器能力码不再是
   * 唯一防线。
   */
  private assertCanManageUser(
    actorRoles: string[],
    target: Pick<IdentityUserItem, 'roles' | 'username'>,
  ): void {
    if (!target.roles.includes('admin')) return;
    if (actorRoles.includes('admin')) return;
    throw new ForbiddenException(
      `仅超级管理员可以操作超级管理员账号（目标：${target.username}）`,
    );
  }

  private async assertEmployeeFree(employeeId: string, exceptUserId?: string): Promise<void> {
    const linked = await this.db
      .select({ id: sysUser.id })
      .from(sysUser)
      .where(
        exceptUserId
          ? and(eq(sysUser.employeeId, employeeId), sql`${sysUser.id} <> ${exceptUserId}`)
          : eq(sysUser.employeeId, employeeId),
      )
      .limit(1);
    if (linked[0]) throw new ConflictException('该员工已关联其他系统账号');
    const emp = await this.db.select({ id: mdEmployee.id }).from(mdEmployee).where(eq(mdEmployee.id, employeeId)).limit(1);
    if (!emp[0]) throw new NotFoundException('员工不存在');
  }

  private async assertNotLastAdmin(userId: string): Promise<void> {
    const admins = await this.db
      .select({ userId: sysRoleMember.userId })
      .from(sysRoleMember)
      .where(eq(sysRoleMember.roleCode, 'admin'));
    const activeAdminIds: string[] = [];
    for (const row of admins) {
      const u = await this.db
        .select({ id: sysUser.id, status: sysUser.status })
        .from(sysUser)
        .where(eq(sysUser.id, row.userId))
        .limit(1);
      if (u[0]?.status === 'active') activeAdminIds.push(u[0].id);
    }
    if (activeAdminIds.length <= 1 && activeAdminIds.includes(userId)) {
      throw new BadRequestException('系统须至少保留一名启用中的管理员');
    }
  }

  /**
   * 创建/重置密码统一走登录密码策略（12 位 + 四类字符 + 不含用户名），
   * 不再允许管理员设 `12345678` 这类 8 位弱口令（P2-11）。
   */
  private assertPasswordPolicy(password: string, username?: string): void {
    const security = new LoginSecurityService(this.db);
    const result = security.validatePassword(
      password,
      DEFAULT_PASSWORD_POLICY,
      { username },
    );
    if (!result.ok) {
      throw new BadRequestException(
        `密码不符合策略：${result.errors.join('；')}`,
      );
    }
  }

  /** 随机临时密码：固定四类字符前缀 + 12 字节随机，长度约 20 位 */
  private generateTemporaryPassword(): string {
    return `Aa1!${randomBytes(12).toString('base64url')}`;
  }
}
