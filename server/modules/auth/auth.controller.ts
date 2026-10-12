import { Body, Controller, Get, Post, Query, Req, Res } from '@nestjs/common';
import { IsNotEmpty, IsString } from 'class-validator';
import type { Request, Response } from 'express';
import { NeedLogin, Public } from '@server/platform';
import { SESSION_COOKIE } from '@server/platform/jwt';
import { AuthService } from './auth.service';

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
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.auth.login(dto.username, dto.password);
    this.writeCookie(res, result.token);
    return { user: result.user };
  }

  @Public()
  @Get('feishu/start')
  start(@Res() res: Response): void {
    const appId = process.env.FEISHU_APP_ID ?? '';
    const redirect = encodeURIComponent(process.env.FEISHU_REDIRECT_URI ?? '');
    res.redirect(
      `https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=${appId}&redirect_uri=${redirect}&response_type=code`,
    );
  }

  @Public()
  @Get('feishu/callback')
  async callback(@Query('code') code: string, @Res() res: Response): Promise<void> {
    const result = await this.auth.feishuLogin(code);
    this.writeCookie(res, result.token);
    res.redirect('/');
  }

  @Public()
  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response): { ok: true } {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
    return { ok: true };
  }

  @Get('me')
  async me(@Req() req: Request) {
    const userId = req.userContext?.userId ?? '';
    const user = await this.auth.me(userId);
    return { user };
  }

  private writeCookie(res: Response, token: string): void {
    res.setHeader(
      'Set-Cookie',
      `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Path=/; Max-Age=604800; SameSite=Lax`,
    );
  }
}
