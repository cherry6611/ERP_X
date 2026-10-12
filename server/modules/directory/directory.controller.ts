import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import { IsArray, IsString } from 'class-validator';
import { NeedLogin } from '@server/platform';
import { DirectoryService } from './directory.service';

class BatchUsersDto {
  @IsArray()
  @IsString({ each: true })
  ids!: string[];
}

@NeedLogin()
@Controller('api')
export class DirectoryController {
  constructor(private readonly directory: DirectoryService) {}

  @Get('users/search')
  async searchUsers(@Query('query') query = '', @Query('pageSize') pageSize = '20') {
    const userList = await this.directory.searchUsers(query, Number(pageSize) || 20);
    return { data: { userList } };
  }

  @Post('users/batch')
  async batch(@Body() dto: BatchUsersDto) {
    const userInfoMap = await this.directory.usersByIds(dto.ids ?? []);
    return { data: { userInfoMap } };
  }

  @Get('departments/search')
  async searchDepartments(@Query('query') query = '', @Query('pageSize') pageSize = '20') {
    const departmentList = await this.directory.searchDepartments(query, Number(pageSize) || 20);
    return { data: { departmentList } };
  }

  @Get('users/:id/profile')
  async profile(@Param('id') id: string) {
    return this.directory.profile(id);
  }
}
