import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { IsNotEmpty, IsString, Matches, MinLength } from 'class-validator';
import type { Request, Response } from 'express';
import { CanCapability, NeedLogin, Public } from '@server/platform';
import { readCookie, readSession as readSessionToken, SESSION_COOKIE } from '@server/platform/jwt';
import { oauthStateMatches } from '@server/common/security/oauth-state';
import { consumeRate } from '@server/common/security/rate-limit';
import { IdentityService } from '@server/modules/identity/identity.service';
import { AuthService, MfaRequiredException } from './auth.service';
import { LoginSecurityService } from './login-security.service';

const STATE_COOKIE = 'erp_oauth_state';
const MODE_COOKIE = 'erp_oauth_mode';
const INVITE_COOKIE = 'erp_oauth_invite';

function homeUrl(): string {
  return process.env.APP_BASE_URL || '/';
}

function loginErrorUrl(message: string): string {
  const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  const q = encodeURIComponent(message);
  return `${base}/login?feishu_error=${q}`;
}

function loginSuccessUrl(message?: string): string {
  const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
  if (!message) return `${base}/`;
  return `${base}/login?feishu_ok=${encodeURIComponent(message)}`;
}

function httpErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof HttpException) {
    const body = error.getResponse();
    if (typeof body === 'string') return body;
    if (body && typeof body === 'object' && 'message' in body) {
      const m = (body as { message: string | string[] }).message;
      return Array.isArray(m) ? m.join('；') : String(m);
    }
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

class LoginDto {
  @IsString()
  @IsNotEmpty()
  username!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

/** B-04：MFA 第二步校验 */
class VerifyMfaDto {
  @IsString()
  @IsNotEmpty()
  mfaToken!: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: '动态验证码为 6 位数字' })
  code!: string;
}

/** B-04：确认绑定 MFA */
class ConfirmMfaDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: '动态验证码为 6 位数字' })
  code!: string;
}

/** B-04：关闭 MFA（TOTP 或一次性恢复码） */
class DisableMfaDto {
  @IsString()
  @IsNotEmpty()
  code!: string;
}

/** B-04：修改自己的密码 */
class ChangePasswordDto {
  @IsString()
  @IsNotEmpty()
  currentPassword!: string;

  @IsString()
  @MinLength(8, { message: '新密码至少 8 位' })
  newPassword!: string;
}

@NeedLogin()
@Controller('api/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly identity: IdentityService,
    private readonly security: LoginSecurityService,
  ) {}

  @Public()
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    const context = {
      ip: req.ip ?? null,
      userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
    };
    // 仅对失败尝试限流，避免自动化/联调被成功登录误伤；失败阈值仍防爆破
    try {
      const result = await this.auth.login(dto.username, dto.password, context);
      if (result.mfaRequired) {
        // B-04：密码已通过，但未签发会话，需二次验证
        return {
          mfaRequired: true as const,
          mfaToken: result.mfaToken,
          expiresAt: result.expiresAt,
          userName: result.userName,
        };
      }
      this.writeCookie(res, result.token);
      return { mfaRequired: false as const, user: result.user };
    } catch (error: unknown) {
      await consumeRate(`login-ip:${req.ip ?? 'unknown'}`, 40, 15 * 60 * 1000);
      await consumeRate(
        `login-user:${String(dto.username ?? '').trim().toLowerCase()}`,
        10,
        15 * 60 * 1000,
      );
      throw error;
    }
  }

  /** B-04：MFA 第二步——校验动态码并签发会话 */
  @Public()
  @Post('mfa/verify')
  async verifyMfa(
    @Body() dto: VerifyMfaDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    try {
      const result = await this.auth.verifyMfaLogin(dto.mfaToken, dto.code, {
        ip: req.ip ?? null,
        userAgent: (req.headers['user-agent'] as string | undefined) ?? null,
      });
      this.writeCookie(res, result.token);
      return { user: result.user };
    } catch (error: unknown) {
      await consumeRate(`mfa-ip:${req.ip ?? 'unknown'}`, 30, 15 * 60 * 1000);
      throw error;
    }
  }

  /** B-04：查询自己的 MFA 状态 */
  @Get('mfa/status')
  async mfaStatus(@Req() req: Request) {
    const userId = this.requireUserId(req);
    return this.security.mfaStatus(userId);
  }

  /** B-04：生成 MFA 密钥与恢复码（此时尚未生效，需 confirm 校验一次动态码） */
  @Post('mfa/setup')
  async mfaSetup(@Req() req: Request) {
    const userId = this.requireUserId(req);
    return this.security.setupMfa(userId);
  }

  /** B-04：确认绑定 */
  @Post('mfa/confirm')
  async mfaConfirm(@Body() dto: ConfirmMfaDto, @Req() req: Request) {
    const userId = this.requireUserId(req);
    return this.security.confirmMfa(userId, dto.code);
  }

  /** B-04：关闭 MFA */
  @Post('mfa/disable')
  async mfaDisable(@Body() dto: DisableMfaDto, @Req() req: Request) {
    const userId = this.requireUserId(req);
    return this.security.disableMfa(userId, dto.code);
  }

  /** B-04：修改自己的密码（含密码策略与历史校验） */
  @Post('password/change')
  async changePassword(@Body() dto: ChangePasswordDto, @Req() req: Request) {
    const userId = this.requireUserId(req);
    return this.security.changePassword({
      userId,
      currentPassword: dto.currentPassword,
      newPassword: dto.newPassword,
    });
  }

  /** B-04：登录设备/会话清单 */
  @Get('sessions')
  async listSessions(@Req() req: Request) {
    const userId = this.requireUserId(req);
    const sessions = await this.security.listSessions(userId);
    const currentToken = readCookie(req.headers.cookie, SESSION_COOKIE);
    const secret = process.env.JWT_SECRET ?? '';
    const currentJti = currentToken && secret ? readJti(currentToken, secret) : null;
    return sessions.map((session) => ({
      ...session,
      current: currentJti != null && session.jti === currentJti,
    }));
  }

  /** B-04：远程下线指定设备 */
  @Post('sessions/:jti/revoke')
  async revokeSession(
    @Param('jti') jti: string,
    @Req() req: Request
  ) {
    const userId = this.requireUserId(req);
    const own = await this.security.listSessions(userId);
    if (!own.some((session) => session.jti === jti)) {
      throw new UnauthorizedException('该会话不属于当前账号');
    }
    await this.security.revokeSession(jti, userId);
    return { ok: true };
  }

  /** B-04：管理员解锁账号 / 查看登录审计 */
  @CanCapability('identity')
  @Post('users/:userId/unlock')
  async unlockUser(
    @Param('userId', ParseUUIDPipe) userId: string,
    @Req() req: Request
  ) {
    const actor = this.requireUserId(req);
    return this.security.unlock(userId, actor);
  }

  @CanCapability('admin_ops')
  @Get('login-audit')
  async loginAudit(@Query('limit') limit?: string) {
    return this.security.listLoginAudit(Number(limit) || 100);
  }

  private requireUserId(req: Request): string {
    const userId = req.userContext?.userId;
    if (!userId) throw new UnauthorizedException('请先登录');
    return userId;
  }

  @Public()
  @Get('feishu/start')
  async start(@Res() res: Response): Promise<void> {
    try {
      const state = randomBytes(16).toString('hex');
      const url = await this.auth.authorizeUrl(state);
      res.setHeader('Set-Cookie', [
        `${STATE_COOKIE}=${state}; HttpOnly; Path=/; Max-Age=300; SameSite=Lax${this.secureFlag()}`,
        `${MODE_COOKIE}=login; HttpOnly; Path=/; Max-Age=300; SameSite=Lax${this.secureFlag()}`,
        `${INVITE_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${this.secureFlag()}`,
      ]);
      res.redirect(url);
    } catch (error: unknown) {
      res.redirect(loginErrorUrl(httpErrorMessage(error, '飞书登录启动失败')));
    }
  }

  @Get('feishu/bind')
  async bind(@Req() req: Request, @Res() res: Response): Promise<void> {
    try {
      const state = randomBytes(16).toString('hex');
      const url = await this.auth.authorizeUrl(state);
      const session = readCookie(req.headers.cookie, SESSION_COOKIE);
      res.setHeader('Set-Cookie', [
        session
          ? `${SESSION_COOKIE}=${encodeURIComponent(session)}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax${this.secureFlag()}`
          : '',
        `${STATE_COOKIE}=${state}; HttpOnly; Path=/; Max-Age=300; SameSite=Lax${this.secureFlag()}`,
        `${MODE_COOKIE}=bind; HttpOnly; Path=/; Max-Age=300; SameSite=Lax${this.secureFlag()}`,
        `${INVITE_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${this.secureFlag()}`,
      ].filter(Boolean));
      res.redirect(url);
    } catch (error: unknown) {
      res.redirect(loginErrorUrl(httpErrorMessage(error, '飞书绑定启动失败')));
    }
  }

  /** 管理员邀请代绑：Public，凭 invite token 进入 OAuth */
  @Public()
  @Get('feishu/invite-start')
  async inviteStart(@Query('token') token: string, @Res() res: Response): Promise<void> {
    try {
      if (!token?.trim()) throw new UnauthorizedException('缺少邀请令牌');
      const peek = await this.identity.peekInviteToken(token.trim());
      if (!peek) throw new UnauthorizedException('邀请无效或已过期');
      const state = randomBytes(16).toString('hex');
      const url = await this.auth.authorizeUrl(state);
      res.setHeader('Set-Cookie', [
        `${STATE_COOKIE}=${state}; HttpOnly; Path=/; Max-Age=300; SameSite=Lax${this.secureFlag()}`,
        `${MODE_COOKIE}=invite; HttpOnly; Path=/; Max-Age=300; SameSite=Lax${this.secureFlag()}`,
        `${INVITE_COOKIE}=${encodeURIComponent(token.trim())}; HttpOnly; Path=/; Max-Age=300; SameSite=Lax${this.secureFlag()}`,
      ]);
      res.redirect(url);
    } catch (error: unknown) {
      res.redirect(loginErrorUrl(httpErrorMessage(error, '飞书邀请绑定启动失败')));
    }
  }

  @Public()
  @Get('feishu/callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    try {
      const expected = readCookie(req.headers.cookie, STATE_COOKIE);
      if (!oauthStateMatches(expected, state)) {
        throw new UnauthorizedException('飞书登录 state 无效');
      }
      const mode = readCookie(req.headers.cookie, MODE_COOKIE);
      let bindUserId: string | undefined =
        mode === 'bind' ? req.userContext?.userId : undefined;
      if (mode === 'bind' && !bindUserId) {
        throw new UnauthorizedException('请先登录后再绑定飞书');
      }
      if (mode === 'invite') {
        const inviteToken = readCookie(req.headers.cookie, INVITE_COOKIE);
        if (!inviteToken) throw new UnauthorizedException('邀请会话失效，请重新打开邀请链接');
        bindUserId = await this.identity.consumeInviteToken(inviteToken);
      }
      if (!code) {
        throw new UnauthorizedException('飞书授权未返回 code');
      }
      const result = await this.auth.feishuLogin(code, bindUserId);
      const secure = this.secureFlag();
      res.setHeader('Set-Cookie', [
        `${SESSION_COOKIE}=${encodeURIComponent(result.token)}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax${secure}`,
        `${STATE_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`,
        `${MODE_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`,
        `${INVITE_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`,
      ]);
      if (mode === 'invite') {
        res.redirect(loginSuccessUrl('飞书绑定成功，已为您登录'));
        return;
      }
      res.redirect(homeUrl());
    } catch (error: unknown) {
      // B-04：飞书登录命中 MFA 时，把挑战票据带回登录页做第二步验证
      if (error instanceof MfaRequiredException) {
        const base = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
        this.clearOauthCookies(res);
        res.redirect(
          `${base}/login?mfa_required=1&mfa_token=${encodeURIComponent(error.mfaToken)}`
        );
        return;
      }
      this.clearOauthCookies(res);
      res.redirect(loginErrorUrl(httpErrorMessage(error, '飞书登录失败')));
    }
  }

  @Public()
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    await this.auth.logout(readCookie(req.headers.cookie, SESSION_COOKIE));
    const secure = this.secureFlag();
    res.setHeader('Set-Cookie', [
      `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`,
      `${STATE_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`,
      `${MODE_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`,
      `${INVITE_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`,
    ]);
    return { ok: true };
  }

  @Get('me')
  async me(@Req() req: Request) {
    const userId = req.userContext?.userId ?? '';
    const user = await this.auth.me(userId);
    return { user };
  }

  private secureFlag(): string {
    const base = (process.env.APP_BASE_URL ?? '').toLowerCase();
    if (process.env.NODE_ENV === 'production' || base.startsWith('https://')) {
      return '; Secure';
    }
    return '';
  }

  private clearOauthCookies(res: Response): void {
    const secure = this.secureFlag();
    res.setHeader('Set-Cookie', [
      `${STATE_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`,
      `${MODE_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`,
      `${INVITE_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`,
    ]);
  }

  private writeCookie(res: Response, token: string): void {
    const secure = this.secureFlag();
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax${secure}`,
    );
  }
}

/** 从会话 Cookie 中读出 jti，用于标记"当前设备" */
function readJti(token: string, secret: string): string | null {
  const claims = readSessionToken(token, secret);
  return claims?.jti ?? null;
}
