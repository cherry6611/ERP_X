import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { NeedLogin } from '@server/platform';
import { CanCapability } from '@server/modules/integrations/integration-authz';
import { actorFromRequest } from '@server/common/auth/actor';
import { IsIn, IsObject, IsOptional, IsString } from 'class-validator';
import { ExportsService } from './exports.service';
import { EXPORT_RESOURCES } from './export-resources';
import type {
  CreateExportTaskDto as ICreateExportTaskDto,
  ExportResourceType,
  ExportTaskItem,
  ExportTaskStatus,
  PagedResult,
} from '@shared/api.interface';

export class CreateExportTaskDto implements ICreateExportTaskDto {
  @IsIn(Object.keys(EXPORT_RESOURCES))
  resourceType!: ExportResourceType;

  @IsOptional()
  @IsIn(['xlsx', 'csv'])
  format?: 'xlsx' | 'csv';

  @IsOptional()
  @IsObject()
  filterParams?: Record<string, string | number | boolean | null>;
}

/**
 * C-07 统一异步导出。
 * 读（任务状态/列表/下载）：@CanCapability('finance')；
 * 写（创建任务）：@CanCapability('finance_write')。
 */
@NeedLogin()
@Controller('api/exports')
export class ExportsController {
  constructor(private readonly exportsService: ExportsService) {}

  /** 创建导出任务（202 语义：任务已入队，状态轮询 /api/exports/:id） */
  @CanCapability('finance_write')
  @Post()
  @HttpCode(202)
  async createTask(@Body() dto: CreateExportTaskDto, @Req() req: Request): Promise<ExportTaskItem> {
    return this.exportsService.createTask(dto, actorFromRequest(req));
  }

  /** 我的导出列表（admin 可见全部） */
  @CanCapability('finance')
  @Get()
  async listTasks(
    @Req() req: Request,
    @Query('status') status?: string,
    @Query('resourceType') resourceType?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string
  ): Promise<PagedResult<ExportTaskItem>> {
    const actor = actorFromRequest(req);
    return this.exportsService.listTasks(
      {
        status: (status as ExportTaskStatus) || undefined,
        resourceType: (resourceType as ExportResourceType) || undefined,
        page: page ? Number(page) : 1,
        pageSize: pageSize ? Number(pageSize) : 20,
      },
      { userId: actor.userId, roles: req.userContext?.roles ?? [] }
    );
  }

  /** 单任务状态与下载链接 */
  @CanCapability('finance')
  @Get(':id')
  async getTask(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request
  ): Promise<ExportTaskItem> {
    const actor = actorFromRequest(req);
    return this.exportsService.getTask(id, {
      userId: actor.userId,
      roles: req.userContext?.roles ?? [],
    });
  }

  /** 下载导出文件（仅任务发起人或 admin） */
  @CanCapability('finance')
  @Get(':id/download')
  @Header('Cache-Control', 'private, no-store')
  async download(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
    @Res() res: Response
  ): Promise<void> {
    const actor = actorFromRequest(req);
    const file = await this.exportsService.openDownload(id, {
      userId: actor.userId,
      roles: req.userContext?.roles ?? [],
    });
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Content-Length', String(file.size));
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(file.fileName)}"`
    );
    file.stream.pipe(res);
  }
}
