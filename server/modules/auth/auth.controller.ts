import { Body, Controller, Get, Post, Query, Req, Res, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { IsNotEmpty, IsString } from 'class-validator';
import type { Request, Response } from 'express';
import { NeedLogin, Public } from '@server/platform';
import { readCookie, SESSION_COOKIE } from '@server/platform/jwt';
import { oauthStateMatches } from '@server/common/security/oauth-state';
import { consumeRate } from '@server/common/security/rate-limit';
import { AuthService } from './auth.service';

const STATE_COOKIE = 'erp_oauth_state';
const MODE_COOKIE = 'erp_oauth_mode';

/**
 * 授权完成后的落地页。
 * 回调永远打在后端（:3000），而开发模式下后端的 `/` 是 hbs 视图、
 * dist/client 尚未构建，直接 redirect('/') 会 500。
 * 用 APP_BASE_URL 显式指回前端开发服务器（本地填 http://127.0.0.1:5173）。
 */
function homeUrl(): string {
  return process.env.APP_BASE_URL || '/';
}

class LoginDto {
  @IsString()
  @IsNotEmpty()
  username!: string;

  @IsString()
  @IsNotEmpty()
  password!: string;
}

@NeedLogin()
@Controller('api/auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('login')
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response
  ) {
    // 修复 P0-3（暴力破解）：登录端点原本只受全局 600 次/分钟约束，
    // 等于允许约 600 次/分钟的密码猜测。按 IP + 账号双维度限速。
    consumeRate(`login-ip:${req.ip ?? 'unknown'}`, 20, 15 * 60 * 1000);
    consumeRate(
      `login-user:${String(dto.username ?? '').trim().toLowerCase()}`,
      5,
      15 * 60 * 1000
    );
    const result = await this.auth.login(dto.username, dto.password);
    this.writeCookie(res, result.token);
    return { user: result.user };
  }

  @Public()
  @Get('feishu/start')
  async start(@Res() res: Response): Promise<void> {
    const state = randomBytes(16).toString('hex');
    const url = await this.auth.authorizeUrl(state);
    res.setHeader('Set-Cookie', [
      `${STATE_COOKIE}=${state}; HttpOnly; Path=/; Max-Age=300; SameSite=Lax${this.secureFlag()}`,
      `${MODE_COOKIE}=login; HttpOnly; Path=/; Max-Age=300; SameSite=Lax${this.secureFlag()}`,
    ]);
    res.redirect(url);
  }

  @Get('feishu/bind')
  async bind(@Req() req: Request, @Res() res: Response): Promise<void> {
    const state = randomBytes(16).toString('hex');
    const url = await this.auth.authorizeUrl(state);
    const session = readCookie(req.headers.cookie, SESSION_COOKIE);
    res.setHeader('Set-Cookie', [
      session ? `${SESSION_COOKIE}=${encodeURIComponent(session)}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax` : '',
      `${STATE_COOKIE}=${state}; HttpOnly; Path=/; Max-Age=300; SameSite=Lax${this.secureFlag()}`,
      `${MODE_COOKIE}=bind; HttpOnly; Path=/; Max-Age=300; SameSite=Lax${this.secureFlag()}`,
    ].filter(Boolean));
    res.redirect(url);
  }

  @Public()
  @Get('feishu/callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const expected = readCookie(req.headers.cookie, STATE_COOKIE);
    if (!oauthStateMatches(expected, state)) {
      throw new UnauthorizedException('飞书登录 state 无效');
    }
    const mode = readCookie(req.headers.cookie, MODE_COOKIE);
    const bindUserId = mode === 'bind' ? req.userContext?.userId : undefined;
    if (mode === 'bind' && !bindUserId) {
      throw new UnauthorizedException('请先登录后再绑定飞书');
    }
    const result = await this.auth.feishuLogin(code, bindUserId);
    // S-02：校验通过后立即清除 state，防止 5 分钟窗口重放
    res.setHeader('Set-Cookie', [
      `${SESSION_COOKIE}=${encodeURIComponent(result.token)}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`,
      `${STATE_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
      `${MODE_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
    ]);
    res.redirect(homeUrl());
  }

  @Public()
  @Post('logout')
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<{ ok: true }> {
    await this.auth.logout(readCookie(req.headers.cookie, SESSION_COOKIE));
    res.setHeader('Set-Cookie', [
      `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
      `${STATE_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
      `${MODE_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`,
    ]);
    return { ok: true };
  }

  @Get('me')
  async me(@Req() req: Request) {
    const userId = req.userContext?.userId ?? '';
    const user = await this.auth.me(userId);
    return { user };
  }

  /** 生产环境统一给 Cookie 追加 Secure（会话令牌与 OAuth state/mode 都要带） */
  private secureFlag(): string {
    return process.env.NODE_ENV === 'production' ? '; Secure' : '';
  }

  private writeCookie(res: Response, token: string): void {
    // 修复 P1-2：生产环境必须带 Secure，否则会话令牌可能在明文链路上被截获
    const secure = this.secureFlag();
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax${secure}`,
    );
  }
}
