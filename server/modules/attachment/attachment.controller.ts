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
import { ATTACHMENT_RESOURCE_TYPES } from '@shared/api.interface';
import type {
  Attachment,
  CreateAttachmentDto as ICreateAttachmentDto,
} from '@shared/api.interface';

export class ListAttachmentsQueryDto {
  @IsString()
  @IsIn([...ATTACHMENT_RESOURCE_TYPES])
  resourceType!: 'fin_expense_claim' | 'erp_contract' | 'pur_request' | 'hr_leave_request' | 'fin_voucher' | 'fin_expense_apply' | 'pur_order' | 'ast_asset' | 'da_dataset' | 'da_grant' | 'erp_project' | 'crm_lead' | 'crm_opportunity' | 'admin_rent_contract' | 'admin_bill' | 'erp_invoice' | 'crm_quotation' | 'erp_project_cost' | 'erp_deliverable';

  @IsUUID()
  resourceId!: string;
}

export class CreateAttachmentDto implements ICreateAttachmentDto {
  @IsString()
  @IsIn([...ATTACHMENT_RESOURCE_TYPES])
  resourceType!: 'fin_expense_claim' | 'erp_contract' | 'pur_request' | 'hr_leave_request' | 'fin_voucher' | 'fin_expense_apply' | 'pur_order' | 'ast_asset' | 'da_dataset' | 'da_grant' | 'erp_project' | 'crm_lead' | 'crm_opportunity' | 'admin_rent_contract' | 'admin_bill' | 'erp_invoice' | 'crm_quotation' | 'erp_project_cost' | 'erp_deliverable';

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

  @CanRole(['admin'])
  @Delete(':id')
  @NeedLogin()
  async remove(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<void> {
    return this.attachmentService.remove(req.userContext.userId, id);
  }
}
