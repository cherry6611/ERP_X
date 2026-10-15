import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { sysLoginAudit, sysLoginSession, sysMfaChallenge, sysUser } from '@server/database/schema';
import { hashPassword, verifyPassword } from '@server/platform/password';
import { decryptSecret, encryptSecret, secretKeyFromEnv } from '@server/common/security/secret-box';
import { buildOtpAuthUri, generateRecoveryCodes, generateTotpSecret, verifyTotp } from '@server/common/security/totp';
import { unwrapRows } from '@server/common/utils/rows';

/** B-04：密码策略（可由 sys_param 覆盖，见 B-03；此处为缺省值） */
export interface PasswordPolicy {
  minLength: number;
  requireUpper: boolean;
  requireLower: boolean;
  requireDigit: boolean;
  requireSymbol: boolean;
  /** 强制更换周期（天），0 表示不强制 */
  maxAgeDays: number;
  /** 不得与前 N 次相同 */
  historySize: number;
}

export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 12,
  requireUpper: true,
  requireLower: true,
  requireDigit: true,
  requireSymbol: true,
  maxAgeDays: 90,
  historySize: 5,
};

/** B-04：登录失败锁定策略 */
export interface LockoutPolicy {
  maxAttempts: number;
  lockMinutes: number;
}

export const DEFAULT_LOCKOUT_POLICY: LockoutPolicy = {
  maxAttempts: 5,
  lockMinutes: 15,
};

/** 强密码豁免：与用户名高度重复的密码一律拒绝 */
const WEAK_PATTERNS = [
  /^(.)\1+$/,
  /^(?:123456|password|admin|qwerty|abcd)/i,
  /^\d+$/,
];

export interface PasswordValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * B-04：登录安全服务。
 *
 * 职责：
 *   ① 密码策略校验（长度/复杂度/历史/有效期）；
 *   ② 登录失败计数与锁定（含管理员解锁）；
 *   ③ TOTP 双因素：setup（返回密钥与 otpauth URI）、确认绑定、校验、恢复码；
 *   ④ 登录审计（成功与失败均落 sys_login_audit）；
 *   ⑤ 会话设备清单与远程下线。
 */
@Injectable()
export class LoginSecurityService {
  private readonly logger = new Logger(LoginSecurityService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  /* ========== ① 密码策略 ========== */

  validatePassword(
    password: string,
    policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
    context: { username?: string } = {}
  ): PasswordValidationResult {
    const errors: string[] = [];
    if (password.length < policy.minLength) {
      errors.push(`密码长度至少 ${policy.minLength} 位`);
    }
    if (policy.requireUpper && !/[A-Z]/.test(password)) errors.push('密码需包含大写字母');
    if (policy.requireLower && !/[a-z]/.test(password)) errors.push('密码需包含小写字母');
    if (policy.requireDigit && !/\d/.test(password)) errors.push('密码需包含数字');
    if (policy.requireSymbol && !/[^A-Za-z0-9]/.test(password)) {
      errors.push('密码需包含特殊字符');
    }
    for (const pattern of WEAK_PATTERNS) {
      if (pattern.test(password)) {
        errors.push('密码过于简单，请避免常见弱口令或连续重复字符');
        break;
      }
    }
    if (context.username && context.username.length >= 3) {
      const lowerPassword = password.toLowerCase();
      const lowerUser = context.username.toLowerCase();
      if (lowerPassword.includes(lowerUser)) {
        errors.push('密码不得包含用户名');
      }
    }
    return { ok: errors.length === 0, errors };
  }

  /** 密码是否已过期（超过 maxAgeDays） */
  isPasswordExpired(
    changedAt: Date | null | undefined,
    policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY,
    now: Date = new Date()
  ): boolean {
    if (policy.maxAgeDays <= 0) return false;
    if (!changedAt) return true;
    const ageDays = (now.getTime() - changedAt.getTime()) / 86_400_000;
    return ageDays > policy.maxAgeDays;
  }

  /** 密码是否与前 N 次重复 */
  isPasswordReused(
    password: string,
    history: string[],
    currentHash?: string | null
  ): boolean {
    if (currentHash && verifyPassword(password, currentHash)) return true;
    return history.some((hash) => verifyPassword(password, hash));
  }

  /** 校验并设置新密码（含历史与有效期处理） */
  async changePassword(params: {
    userId: string;
    newPassword: string;
    currentPassword?: string;
    policy?: PasswordPolicy;
    actorUserId?: string;
  }): Promise<{ ok: true }> {
    const policy = params.policy ?? DEFAULT_PASSWORD_POLICY;
    const rows = await this.db
      .select({
        id: sysUser.id,
        username: sysUser.username,
        passwordHash: sysUser.passwordHash,
        passwordHistory: sysUser.passwordHistory,
      })
      .from(sysUser)
      .where(eq(sysUser.id, params.userId))
      .limit(1);
    if (rows.length === 0) throw new BadRequestException('用户不存在');
    const user = rows[0];
    if (params.currentPassword != null && user.passwordHash) {
      if (!verifyPassword(params.currentPassword, user.passwordHash)) {
        throw new BadRequestException('当前密码不正确');
      }
    }
    const validation = this.validatePassword(params.newPassword, policy, {
      username: user.username ?? undefined,
    });
    if (!validation.ok) {
      throw new BadRequestException(`密码不符合策略：${validation.errors.join('；')}`);
    }
    const history = this.parseHistory(user.passwordHistory);
    if (this.isPasswordReused(params.newPassword, history, user.passwordHash)) {
      throw new BadRequestException(
        `新密码不得与最近 ${policy.historySize} 次使用的密码相同`
      );
    }
    const newHistory = user.passwordHash
      ? [user.passwordHash, ...history].slice(0, policy.historySize)
      : history;
    await this.db
      .update(sysUser)
      .set({
        passwordHash: hashPassword(params.newPassword),
        passwordHistory: JSON.stringify(newHistory),
        passwordChangedAt: new Date(),
        mustChangePassword: 0,
        failedLoginAttempts: 0,
        lockedUntil: null,
        updatedAt: new Date(),
      })
      .where(eq(sysUser.id, params.userId));
    this.logger.log(`密码已更新 userId=${params.userId} by=${params.actorUserId ?? params.userId}`);
    return { ok: true };
  }

  private parseHistory(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }

  /* ========== ② 登录失败锁定 ========== */

  async assertNotLocked(
    userId: string,
    policy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY
  ): Promise<void> {
    const rows = await this.db
      .select({ lockedUntil: sysUser.lockedUntil, failed: sysUser.failedLoginAttempts })
      .from(sysUser)
      .where(eq(sysUser.id, userId))
      .limit(1);
    const row = rows[0];
    if (!row?.lockedUntil) return;
    if (row.lockedUntil.getTime() > Date.now()) {
      const minutes = Math.ceil((row.lockedUntil.getTime() - Date.now()) / 60_000);
      throw new BadRequestException(
        `账号已被锁定，请在 ${minutes} 分钟后重试或联系管理员解锁（连续失败 ${row.failed} 次）`
      );
    }
    // 锁定已过期 → 重置计数
    await this.db
      .update(sysUser)
      .set({ failedLoginAttempts: 0, lockedUntil: null, updatedAt: new Date() })
      .where(eq(sysUser.id, userId));
    void policy;
  }

  async recordFailedLogin(
    userId: string | null,
    policy: LockoutPolicy = DEFAULT_LOCKOUT_POLICY
  ): Promise<{ locked: boolean; attempts: number; lockedUntil: Date | null }> {
    if (!userId) return { locked: false, attempts: 0, lockedUntil: null };
    const rows = await this.db
      .select({ failed: sysUser.failedLoginAttempts })
      .from(sysUser)
      .where(eq(sysUser.id, userId))
      .limit(1);
    const attempts = Number(rows[0]?.failed ?? 0) + 1;
    const locked = attempts >= policy.maxAttempts;
    const lockedUntil = locked
      ? new Date(Date.now() + policy.lockMinutes * 60_000)
      : null;
    await this.db
      .update(sysUser)
      .set({
        failedLoginAttempts: locked ? 0 : attempts,
        lockedUntil,
        updatedAt: new Date(),
      })
      .where(eq(sysUser.id, userId));
    if (locked) {
      this.logger.warn(
        `账号锁定 userId=${userId} 连续失败 ${attempts} 次，锁定 ${policy.lockMinutes} 分钟`
      );
    }
    return { locked, attempts, lockedUntil };
  }

  async clearFailedLogin(userId: string): Promise<void> {
    await this.db
      .update(sysUser)
      .set({ failedLoginAttempts: 0, lockedUntil: null, updatedAt: new Date() })
      .where(eq(sysUser.id, userId));
  }

  /** 管理员解锁 */
  async unlock(userId: string, actorUserId: string): Promise<{ ok: true }> {
    await this.db
      .update(sysUser)
      .set({ failedLoginAttempts: 0, lockedUntil: null, updatedAt: new Date() })
      .where(eq(sysUser.id, userId));
    await this.writeLoginAudit({
      userId,
      result: 'unlock',
      reason: `管理员 ${actorUserId} 解锁账号`,
      authMethod: 'admin',
    });
    return { ok: true };
  }

  /* ========== ③ TOTP 双因素 ========== */

  /** 角色 → 是否强制 MFA（需求书：admin 与财务强制开启） */
  static requiresMfa(roles: string[]): boolean {
    return roles.some((role) =>
      ['admin', 'user_admin', 'finance_viewer'].includes(role)
    );
  }

  async mfaStatus(userId: string): Promise<{
    enabled: boolean;
    bound: boolean;
    required: boolean;
    recoveryCodesLeft: number;
  }> {
    const rows = await this.db
      .select({
        enabled: sysUser.mfaEnabled,
        boundAt: sysUser.mfaBoundAt,
        override: sysUser.mfaRequiredOverride,
      })
      .from(sysUser)
      .where(eq(sysUser.id, userId))
      .limit(1);
    const row = rows[0];
    const roles = await this.loadRoles(userId);
    const roleRequires = LoginSecurityService.requiresMfa(roles);
    const required =
      row?.override === 1 ? true : row?.override === 0 ? false : roleRequires;
    const codes = await this.db.execute(sql`
      SELECT count(*)::int AS total FROM sys_mfa_recovery_code
      WHERE user_id = ${userId}::uuid AND used_at IS NULL
    `);
    const list = unwrapRows<{ total: number }>(codes);
    return {
      enabled: Number(row?.enabled ?? 0) === 1,
      bound: Boolean(row?.boundAt),
      required,
      recoveryCodesLeft: Number(list[0]?.total ?? 0),
    };
  }

  private async loadRoles(userId: string): Promise<string[]> {
    // 注意：sys_role_member.user_id 是 varchar(64)（uuid 以文本存储，见 0000_baseline.sql），
    // 不能 ::uuid 强转，否则报 operator does not exist: character varying = uuid
    const rows = await this.db.execute(sql`
      SELECT role_code FROM sys_role_member WHERE user_id = ${userId}
    `);
    return unwrapRows<{ role_code: string }>(rows).map((row) => row.role_code);
  }

  /** 生成（或重新生成）TOTP 密钥并返回 otpauth URI；此时尚未生效 */
  async setupMfa(userId: string): Promise<{
    secret: string;
    otpauthUri: string;
    recoveryCodes: string[];
  }> {
    const key = secretKeyFromEnv();
    if (!key) {
      throw new BadRequestException(
        '服务端未配置密钥（APP_SECRET_KEY / SECRET_BOX_KEY），无法安全存储 MFA 密钥'
      );
    }
    const rows = await this.db
      .select({ username: sysUser.username, displayName: sysUser.displayName })
      .from(sysUser)
      .where(eq(sysUser.id, userId))
      .limit(1);
    if (rows.length === 0) throw new BadRequestException('用户不存在');
    const account = rows[0].username || rows[0].displayName || userId;
    const secret = generateTotpSecret();
    await this.db
      .update(sysUser)
      .set({
        mfaSecretEnc: encryptSecret(secret, key),
        mfaEnabled: 0,
        mfaBoundAt: null,
        updatedAt: new Date(),
      })
      .where(eq(sysUser.id, userId));
    const recoveryCodes = generateRecoveryCodes();
    // 旧恢复码作废，写入新码（仅存 hash）
    await this.db.execute(sql`
      DELETE FROM sys_mfa_recovery_code WHERE user_id = ${userId}::uuid AND used_at IS NULL
    `);
    for (const code of recoveryCodes) {
      await this.db.execute(sql`
        INSERT INTO sys_mfa_recovery_code (user_id, code_hash)
        VALUES (${userId}::uuid, ${this.hashRecoveryCode(code)})
        ON CONFLICT (code_hash) DO NOTHING
      `);
    }
    return {
      secret,
      otpauthUri: buildOtpAuthUri({ secret, accountName: account }),
      recoveryCodes,
    };
  }

  private hashRecoveryCode(code: string): string {
    return createHash('sha256')
      .update(code.replace(/-/g, '').toUpperCase())
      .digest('hex');
  }

  /** 确认绑定：校验一次 TOTP 后才真正启用 */
  async confirmMfa(userId: string, code: string): Promise<{ ok: true }> {
    const secret = await this.loadSecret(userId);
    if (!secret) throw new BadRequestException('请先生成 MFA 密钥');
    if (!verifyTotp(secret, code)) {
      throw new BadRequestException('验证码不正确，请确认设备时间与验证器 App 一致');
    }
    await this.db
      .update(sysUser)
      .set({ mfaEnabled: 1, mfaBoundAt: new Date(), updatedAt: new Date() })
      .where(eq(sysUser.id, userId));
    await this.writeLoginAudit({
      userId,
      result: 'mfa_bound',
      authMethod: 'totp',
    });
    return { ok: true };
  }

  /** 关闭 MFA（需当前 TOTP 或恢复码验证） */
  async disableMfa(userId: string, code: string): Promise<{ ok: true }> {
    const secret = await this.loadSecret(userId);
    const validTotp = secret ? verifyTotp(secret, code) : false;
    const validRecovery = validTotp ? true : await this.consumeRecoveryCode(userId, code);
    if (!validTotp && !validRecovery) {
      throw new BadRequestException('验证码或恢复码不正确');
    }
    await this.db
      .update(sysUser)
      .set({
        mfaEnabled: 0,
        mfaBoundAt: null,
        mfaSecretEnc: null,
        updatedAt: new Date(),
      })
      .where(eq(sysUser.id, userId));
    await this.db.execute(sql`
      DELETE FROM sys_mfa_recovery_code WHERE user_id = ${userId}::uuid
    `);
    await this.writeLoginAudit({ userId, result: 'mfa_disabled', authMethod: 'totp' });
    return { ok: true };
  }

  /** 校验 MFA 验证码（TOTP 或一次性恢复码） */
  async verifyMfa(userId: string, code: string): Promise<boolean> {
    const secret = await this.loadSecret(userId);
    if (secret && verifyTotp(secret, code)) return true;
    return this.consumeRecoveryCode(userId, code);
  }

  private async consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
    const hash = this.hashRecoveryCode(code);
    const rows = await this.db.execute(sql`
      UPDATE sys_mfa_recovery_code
      SET used_at = CURRENT_TIMESTAMP
      WHERE user_id = ${userId}::uuid AND code_hash = ${hash} AND used_at IS NULL
      RETURNING id
    `);
    const list = Array.isArray(rows)
      ? (rows as unknown[])
      : ((rows as { rows?: unknown[] }).rows ?? []);
    return list.length > 0;
  }

  private async loadSecret(userId: string): Promise<string | null> {
    const rows = await this.db
      .select({ enc: sysUser.mfaSecretEnc })
      .from(sysUser)
      .where(eq(sysUser.id, userId))
      .limit(1);
    const enc = rows[0]?.enc;
    if (!enc) return null;
    try {
      return decryptSecret(enc, secretKeyFromEnv());
    } catch (error) {
      this.logger.error(
        `MFA 密钥解密失败 userId=${userId} ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  /* ========== MFA 临时挑战票据 ========== */

  async createChallenge(params: {
    userId: string;
    ip?: string;
    userAgent?: string;
    ttlSeconds?: number;
  }): Promise<{ token: string; expiresAt: Date }> {
    const token = createHash('sha256')
      .update(`${params.userId}:${Date.now()}:${Math.random()}`)
      .digest('hex');
    const expiresAt = new Date(Date.now() + (params.ttlSeconds ?? 300) * 1000);
    await this.db.insert(sysMfaChallenge).values({
      userId: params.userId,
      tokenHash: this.hashToken(token),
      expiresAt,
      ip: params.ip ?? null,
      userAgent: params.userAgent?.slice(0, 500) ?? null,
    });
    return { token, expiresAt };
  }

  async consumeChallenge(token: string): Promise<string | null> {
    const rows = await this.db
      .select({
        id: sysMfaChallenge.id,
        userId: sysMfaChallenge.userId,
        expiresAt: sysMfaChallenge.expiresAt,
        consumedAt: sysMfaChallenge.consumedAt,
      })
      .from(sysMfaChallenge)
      .where(eq(sysMfaChallenge.tokenHash, this.hashToken(token)))
      .limit(1);
    const row = rows[0];
    if (!row || row.consumedAt || row.expiresAt.getTime() < Date.now()) return null;
    const updated = await this.db
      .update(sysMfaChallenge)
      .set({ consumedAt: new Date() })
      .where(and(eq(sysMfaChallenge.id, row.id), isNull(sysMfaChallenge.consumedAt)))
      .returning({ id: sysMfaChallenge.id });
    if (updated.length === 0) return null;
    return row.userId;
  }

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /** 清理过期挑战票据（由 cron 调用） */
  async purgeChallenges(): Promise<void> {
    await this.db.execute(sql`
      DELETE FROM sys_mfa_challenge
      WHERE expires_at < CURRENT_TIMESTAMP - interval '1 day'
    `);
  }

  /* ========== ④ 登录审计 ========== */

  async writeLoginAudit(params: {
    username?: string | null;
    userId?: string | null;
    result: 'success' | 'failed' | 'locked' | 'mfa_bound' | 'mfa_disabled' | 'unlock' | 'logout';
    reason?: string | null;
    authMethod?: string | null;
    ip?: string | null;
    userAgent?: string | null;
  }): Promise<void> {
    try {
      await this.db.insert(sysLoginAudit).values({
        username: params.username?.slice(0, 128) ?? null,
        userId: params.userId ?? null,
        result: params.result,
        reason: params.reason?.slice(0, 64) ?? null,
        authMethod: params.authMethod?.slice(0, 20) ?? null,
        ip: params.ip?.slice(0, 64) ?? null,
        userAgent: params.userAgent?.slice(0, 500) ?? null,
      });
    } catch (error) {
      // 审计写入失败不得阻塞登录（但必须留日志，见 NFR-S2）
      this.logger.error(
        `登录审计写入失败 user=${params.username ?? params.userId ?? '-'} ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async listLoginAudit(limit = 100): Promise<
    Array<{
      id: string;
      username: string | null;
      userId: string | null;
      result: string;
      reason: string | null;
      authMethod: string | null;
      ip: string | null;
      userAgent: string | null;
      createdAt: string;
    }>
  > {
    const rows = await this.db
      .select({
        id: sysLoginAudit.id,
        username: sysLoginAudit.username,
        userId: sysLoginAudit.userId,
        result: sysLoginAudit.result,
        reason: sysLoginAudit.reason,
        authMethod: sysLoginAudit.authMethod,
        ip: sysLoginAudit.ip,
        userAgent: sysLoginAudit.userAgent,
        createdAt: sysLoginAudit.createdAt,
      })
      .from(sysLoginAudit)
      .orderBy(desc(sysLoginAudit.createdAt))
      .limit(Math.min(Math.max(limit, 1), 500));
    return rows.map((row) => ({
      id: row.id,
      username: row.username ?? null,
      userId: row.userId ?? null,
      result: row.result,
      reason: row.reason ?? null,
      authMethod: row.authMethod ?? null,
      ip: row.ip ?? null,
      userAgent: row.userAgent ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /* ========== ⑤ 会话设备管理 ========== */

  /** 记录会话设备信息（登录成功后调用） */
  async tagSession(params: {
    jti: string;
    ip?: string | null;
    userAgent?: string | null;
    authMethod?: string | null;
  }): Promise<void> {
    const label = this.deviceLabel(params.userAgent ?? null);
    await this.db
      .update(sysLoginSession)
      .set({
        ip: params.ip?.slice(0, 64) ?? null,
        userAgent: params.userAgent?.slice(0, 500) ?? null,
        deviceLabel: label,
        authMethod: params.authMethod?.slice(0, 20) ?? null,
      })
      .where(eq(sysLoginSession.jti, params.jti));
  }

  private deviceLabel(userAgent: string | null): string {
    if (!userAgent) return '未知设备';
    const ua = userAgent;
    const os = /Windows/i.test(ua)
      ? 'Windows'
      : /Macintosh|Mac OS X/i.test(ua)
        ? 'macOS'
        : /Android/i.test(ua)
          ? 'Android'
          : /iPhone|iPad|iOS/i.test(ua)
            ? 'iOS'
            : /Linux/i.test(ua)
              ? 'Linux'
              : '未知系统';
    const browser = /Edg\//i.test(ua)
      ? 'Edge'
      : /Chrome\//i.test(ua)
        ? 'Chrome'
        : /Firefox\//i.test(ua)
          ? 'Firefox'
          : /Safari\//i.test(ua)
            ? 'Safari'
            : '未知浏览器';
    return `${os} · ${browser}`;
  }

  /** B-04：远程下线指定设备（只能下线自己的会话） */
  async revokeSession(jti: string, userId: string): Promise<void> {
    const updated = await this.db
      .update(sysLoginSession)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sysLoginSession.jti, jti),
          eq(sysLoginSession.userId, userId),
          isNull(sysLoginSession.revokedAt)
        )
      )
      .returning({ jti: sysLoginSession.jti });
    if (updated.length === 0) {
      throw new BadRequestException('会话不存在、已下线或不属于当前账号');
    }
    await this.writeLoginAudit({
      userId,
      result: 'logout',
      reason: 'session_revoked',
      authMethod: 'session',
    });
  }

  async listSessions(userId: string): Promise<    Array<{
      jti: string;
      ip: string | null;
      userAgent: string | null;
      deviceLabel: string | null;
      authMethod: string | null;
      createdAt: string;
      expiresAt: string;
      revokedAt: string | null;
      current: boolean;
    }>
  > {
    const rows = await this.db
      .select({
        jti: sysLoginSession.jti,
        ip: sysLoginSession.ip,
        userAgent: sysLoginSession.userAgent,
        deviceLabel: sysLoginSession.deviceLabel,
        authMethod: sysLoginSession.authMethod,
        createdAt: sysLoginSession.createdAt,
        expiresAt: sysLoginSession.expiresAt,
        revokedAt: sysLoginSession.revokedAt,
      })
      .from(sysLoginSession)
      .where(
        and(
          eq(sysLoginSession.userId, userId),
          gt(sysLoginSession.expiresAt, new Date())
        )
      )
      .orderBy(desc(sysLoginSession.createdAt))
      .limit(50);
    return rows.map((row) => ({
      jti: row.jti,
      ip: row.ip ?? null,
      userAgent: row.userAgent ?? null,
      deviceLabel: row.deviceLabel ?? this.deviceLabel(row.userAgent ?? null),
      authMethod: row.authMethod ?? null,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
      current: false,
    }));
  }
}
