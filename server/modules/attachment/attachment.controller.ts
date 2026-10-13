import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { CanRole, NeedLogin } from '@server/platform';
import type { Request } from 'express';
import { IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, IsUUID, Min } from 'class-validator';
import { AttachmentService } from './attachment.service';
import { ATTACHMENT_RESOURCE_TYPES, type AttachmentResourceType } from '@shared/api.interface';
import type {
  Attachment,
  CreateAttachmentDto as ICreateAttachmentDto,
} from '@shared/api.interface';

export class ListAttachmentsQueryDto {
  @IsString()
  @IsIn([...ATTACHMENT_RESOURCE_TYPES])
  resourceType!: AttachmentResourceType;

  @IsUUID()
  resourceId!: string;
}

export class CreateAttachmentDto implements ICreateAttachmentDto {
  @IsString()
  @IsIn([...ATTACHMENT_RESOURCE_TYPES])
  resourceType!: AttachmentResourceType;

  @IsUUID()
  resourceId!: string;

  @IsString()
  @IsNotEmpty()
  fileName!: string;

  @IsString()
  @IsNotEmpty()
  fileUrl!: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  fileSize?: number;

  @IsOptional()
  @IsIn(['upload', 'feishu_doc'])
  sourceType?: 'upload' | 'feishu_doc';
}

@NeedLogin()
@Controller('api/attachments')
export class AttachmentController {
  constructor(private readonly attachmentService: AttachmentService) {}

  @Get()
  @NeedLogin()
  async list(
    @Req() req: Request,
    @Query() query: ListAttachmentsQueryDto,
  ): Promise<Attachment[]> {
    return this.attachmentService.listWithAclCheck(
      req.userContext.userId,
      req.userContext.userName ?? req.userContext.userId,
      query.resourceType,
      query.resourceId,
    );
  }

  @Post()
  @NeedLogin()
  async create(
    @Req() req: Request,
    @Body() dto: CreateAttachmentDto,
  ): Promise<Attachment> {
    return this.attachmentService.create(
      req.userContext.userId,
      req.userContext.userName ?? req.userContext.userId,
      dto,
    );
  }

  @Delete(':id')
  @NeedLogin()
  async remove(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.attachmentService.remove(
      req.userContext.userId,
      id,
      req.userContext.roles ?? []
    );
  }
}
