import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';
import type { Request } from 'express';
import { CanCapability, NeedLogin } from '@server/platform';
import { IdentityService } from './identity.service';
import type { BindFeishuContactDto as IBindFeishuContactDto } from '@shared/api.interface';

class CreateUserDto {
  @IsString()
  @MinLength(2)
  username!: string;

  @IsString()
  @MinLength(1)
  displayName!: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  roles?: string[];

  @IsOptional()
  @IsString()
  email?: string;

  @IsOptional()
  @IsString()
  mobile?: string;
}

class UpdateUserDto {
  @IsOptional()
  @IsString()
  displayName?: string;

  @IsOptional()
  @IsString()
  email?: string | null;

  @IsOptional()
  @IsString()
  mobile?: string | null;

  @IsOptional()
  @IsUUID()
  employeeId?: string | null;
}

class StatusDto {
  @IsIn(['active', 'disabled'])
  status!: 'active' | 'disabled';
}

class RolesDto {
  @IsArray()
  @IsString({ each: true })
  roles!: string[];
}

class ResetPasswordDto {
  @IsOptional()
  @IsString()
  @MinLength(8)
  password?: string;
}

/**
 * 飞书联系人绑定入参（class DTO：openId 必填，避免空值触发飞书侧 400）。
 *
 * 注意：**必须定义在 controller 类之前**。`@Body()` 会把 DTO 的构造器
 * 作为设计期元数据写在 controller 的装饰器上，而 TS 编译到 CJS 后
 * 类声明仍是 `let/const`（TDZ）；若 DTO 定义在 controller 之后，
 * 生产构建启动时会抛 `Cannot access 'X' before initialization`
 * （`tsc --noEmit` 与 jest(ts-jest) 都发现不了，只有真正 require 编译产物才暴露）。
 */
export class BindFeishuContactBodyDto implements IBindFeishuContactDto {
  @IsString()
  @IsNotEmpty()
  openId!: string;

  @IsOptional()
  @IsString()
  unionId?: string;

  @IsOptional()
  @IsString()
  name?: string;
}

@NeedLogin()
@CanCapability('identity')
@Controller('api/identity')
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  private actor(req: Request) {
    return {
      userId: req.userContext?.userId ?? '',
      roles: req.userContext?.roles ?? [],
    };
  }

  @Get('users')
  list(
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('role') role?: string,
  ) {
    return this.identity.listUsers({ q, status, role });
  }

  @Post('users')
  async create(@Req() req: Request, @Body() dto: CreateUserDto) {
    const result = await this.identity.createUser(this.actor(req), dto);
    return result;
  }

  @Patch('users/:id')
  update(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.identity.updateUser(this.actor(req), id, dto);
  }

  @Patch('users/:id/status')
  setStatus(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: StatusDto,
  ) {
    return this.identity.setStatus(this.actor(req), id, dto.status).then(() => ({ ok: true }));
  }

  @Put('users/:id/roles')
  setRoles(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RolesDto,
  ) {
    return this.identity.setRoles(this.actor(req), id, dto.roles).then(() => ({ ok: true }));
  }

  @Post('users/:id/reset-password')
  resetPassword(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResetPasswordDto,
  ) {
    return this.identity.resetPassword(this.actor(req), id, dto.password);
  }

  @Get('users/:id/sessions')
  sessions(@Param('id', ParseUUIDPipe) id: string) {
    return this.identity.listSessions(id);
  }

  @Post('users/:id/sessions/:jti/revoke')
  revokeSession(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('jti') jti: string,
  ) {
    return this.identity.revokeSession(this.actor(req), id, jti).then(() => ({ ok: true }));
  }

  @Post('users/:id/sessions/revoke-all')
  revokeAll(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.identity.revokeAllSessions(this.actor(req), id).then(() => ({ ok: true }));
  }

  @Post('users/:id/feishu/invite')
  invite(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.identity.createFeishuInvite(this.actor(req), id);
  }

  @Post('users/:id/feishu/invite/revoke')
  revokeInvite(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.identity.revokeFeishuInvite(this.actor(req), id).then(() => ({ ok: true }));
  }

  @Delete('users/:id/feishu')
  unbind(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string) {
    return this.identity.unbindFeishu(this.actor(req), id).then(() => ({ ok: true }));
  }

  @Post('users/:id/feishu/bind-contact')
  bindContact(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: BindFeishuContactBodyDto,
  ) {
    return this.identity.bindFeishuContact(this.actor(req), id, body);
  }
}
