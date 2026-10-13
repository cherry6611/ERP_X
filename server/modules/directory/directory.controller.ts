import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { IsArray, IsString } from 'class-validator';
import type { Request } from 'express';
import { CanRole, NeedLogin } from '@server/platform';
import { DirectoryService } from './directory.service';

class BatchUsersDto {
  @IsArray()
  @IsString({ each: true })
  ids!: string[];
}

function canSeePii(roles: string[] | undefined): boolean {
  return (roles ?? []).some((r) => r === 'admin' || r === 'hr_manager');
}

@NeedLogin()
@Controller('api')
export class DirectoryController {
  constructor(private readonly directory: DirectoryService) {}

  /**
   * A6：选人组件全员可用；非 admin/hr_manager 脱敏邮箱等 PII。
   * 完整档案仅管理员/HR 可查。
   */
  @Get('users/search')
  async searchUsers(
    @Req() req: Request,
    @Query('query') query = '',
    @Query('pageSize') pageSize = '20'
  ) {
    const userList = await this.directory.searchUsers(
      query,
      Number(pageSize) || 20,
      canSeePii(req.userContext?.roles)
    );
    return { data: { userList } };
  }

  @Post('users/batch')
  async batch(@Req() req: Request, @Body() dto: BatchUsersDto) {
    const userInfoMap = await this.directory.usersByIds(
      dto.ids ?? [],
      canSeePii(req.userContext?.roles)
    );
    return { data: { userInfoMap } };
  }

  @Get('departments/search')
  async searchDepartments(
    @Query('query') query = '',
    @Query('pageSize') pageSize = '20'
  ) {
    const departmentList = await this.directory.searchDepartments(
      query,
      Number(pageSize) || 20
    );
    return { data: { departmentList } };
  }

  @CanRole(['admin', 'hr_manager'])
  @Get('users/:id/profile')
  async profile(@Param('id') id: string) {
    return this.directory.profile(id);
  }
}
