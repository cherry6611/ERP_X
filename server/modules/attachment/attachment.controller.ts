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
import { NeedLogin } from '@server/platform';
import type { Request } from 'express';
import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import { AttachmentService } from './attachment.service';
import {
  ATTACHMENT_RESOURCE_TYPES,
  type AttachmentResourceType,
} from '@shared/api.interface';
import type {
  Attachment,
  CreateAttachmentDto as ICreateAttachmentDto,
  ParsedFeishuDocLink,
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

  @IsOptional()
  @IsString()
  feishuToken?: string;

  @IsOptional()
  @IsString()
  feishuDocType?: string;

  @IsOptional()
  @IsString()
  feishuUrl?: string;
}

export class ParseFeishuUrlDto {
  @IsString()
  @IsNotEmpty()
  url!: string;
}

@NeedLogin()
@Controller('api/attachments')
export class AttachmentController {
  constructor(private readonly attachmentService: AttachmentService) {}

  @Get()
  async list(
    @Req() req: Request,
    @Query() query: ListAttachmentsQueryDto,
  ): Promise<Attachment[]> {
    const userId = req.userContext?.userId ?? '';
    return this.attachmentService.listWithAclCheck(
      userId,
      req.userContext?.userName ?? userId,
      query.resourceType,
      query.resourceId,
    );
  }

  @Post('parse-feishu-url')
  async parseFeishuUrl(
    @Body() dto: ParseFeishuUrlDto,
  ): Promise<ParsedFeishuDocLink> {
    return this.attachmentService.parseFeishuUrl(dto.url);
  }

  @Post()
  async create(
    @Req() req: Request,
    @Body() dto: CreateAttachmentDto,
  ): Promise<Attachment> {
    const userId = req.userContext?.userId ?? '';
    return this.attachmentService.create(
      userId,
      req.userContext?.userName ?? userId,
      dto,
    );
  }

  @Delete(':id')
  async remove(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.attachmentService.remove(
      req.userContext?.userId ?? '',
      id,
      req.userContext?.roles ?? [],
    );
  }
}
