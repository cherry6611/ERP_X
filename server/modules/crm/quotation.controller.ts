import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CanCapability, NeedLogin } from '@server/platform';
import { IsArray, IsIn, IsNumber, IsOptional, IsString, IsUUID, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { QuotationService } from './quotation.service';
import { QuotationImportService } from './quotation-import.service';
import type {
  Contract,
  CreateQuotationDto,
  FeishuBitableImportDto,
  FeishuBitablePreviewDto,
  ParsedQuotationDraft,
  ParseQuotationDocDto,
  Quotation,
  QuotationItemInput,
} from '@shared/api.interface';

class QuotationItemBodyDto implements QuotationItemInput {
  @IsString()
  itemName!: string;

  @IsOptional()
  @IsString()
  unit?: string;

  @IsNumber()
  @Min(0)
  quantity!: number;

  @IsNumber()
  @Min(0)
  unitPrice!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discountPct?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  estUnitCost?: number;

  @IsOptional()
  @IsString()
  remark?: string;
}

class CreateQuotationBodyDto implements CreateQuotationDto {
  @IsUUID()
  customerId!: string;

  @IsOptional()
  @IsUUID()
  opportunityId?: string;

  @IsString()
  title!: string;

  @IsOptional()
  @IsString()
  quoteDate?: string;

  @IsOptional()
  @IsString()
  validUntil?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  discountPct?: number;

  @IsOptional()
  @IsString()
  remark?: string;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuotationItemBodyDto)
  items!: QuotationItemInput[];
}

class ParseQuotationDocBodyDto implements ParseQuotationDocDto {
  @IsString()
  docUrl!: string;
}

/**
 * 飞书多维表格预览入参。
 * `implements` shared 契约类型保证字段同源；用 class 而非 interface 是为了让
 * Nest ValidationPipe 真正生效（interface 在运行时被擦除，管道会静默放行）。
 */
class FeishuBitablePreviewBodyDto implements FeishuBitablePreviewDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  recordIds?: string[];
}

/** 飞书多维表格导入入参（recordIds 非空，否则导入没有意义） */
class FeishuBitableImportBodyDto implements FeishuBitableImportDto {
  @IsUUID()
  customerId!: string;

  @IsArray()
  @IsString({ each: true })
  recordIds!: string[];

  @IsOptional()
  @IsUUID()
  opportunityId?: string;
}

class ListQuotationsQueryDto {
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsUUID()
  opportunityId?: string;

  @IsOptional()
  @IsIn(['draft', 'pending_approval', 'approved', 'converted', 'void'])
  status?: 'draft' | 'pending_approval' | 'approved' | 'converted' | 'void';
}

@NeedLogin()
@Controller('api/crm/quotations')
export class QuotationController {
  constructor(
    private readonly quotationService: QuotationService,
    private readonly quotationImportService: QuotationImportService
  ) {}

  // 文档解析与新建属销售日常工作流的一部分，所有登录用户可用；
  // 编辑/提交/审批/作废/转合同仍限管理员。
  @Post('parse-doc')
  async parseDoc(
    @Body() dto: ParseQuotationDocBodyDto
  ): Promise<ParsedQuotationDraft> {
    return this.quotationImportService.parseDoc(dto);
  }

  @Post('parse-file')
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 15 * 1024 * 1024 } }),
  )
  async parseFile(
    @UploadedFile()
    file: { originalname: string; mimetype: string; size: number; buffer: Buffer },
  ): Promise<ParsedQuotationDraft> {
    return this.quotationImportService.parseUploadedFile(file);
  }

  @Get('feishu-bitable/meta')
  feishuBitableMeta() {
    return this.quotationImportService.getBitableMeta();
  }

  @Get('feishu-bitable/records')
  feishuBitableRecords() {
    return this.quotationImportService.listBitableRecords();
  }

  @Post('feishu-bitable/preview')
  feishuBitablePreview(@Body() body: FeishuBitablePreviewBodyDto) {
    return this.quotationImportService.previewFromBitable(body.recordIds ?? []);
  }

  @CanCapability('crm_write')
  @Post('feishu-bitable/import')
  async feishuBitableImport(
    @Body() body: FeishuBitableImportBodyDto,
  ): Promise<Quotation> {
    const draft = await this.quotationImportService.previewFromBitable(
      body.recordIds ?? [],
    );
    if (!draft.title) {
      throw new BadRequestException('多维表格未映射到报价标题，请补全字段映射');
    }
    return this.quotationService.create({
      customerId: body.customerId,
      opportunityId: body.opportunityId,
      title: draft.title,
      quoteDate: draft.quoteDate ?? undefined,
      validUntil: draft.validUntil ?? undefined,
      discountPct: draft.headerDiscountPct ?? 0,
      remark: draft.remark ?? undefined,
      items: draft.items.map((item) => ({
        itemName: item.itemName,
        unit: item.unit ?? '人天',
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        discountPct: item.discountPct ?? 0,
        estUnitCost: item.estUnitCost ?? 0,
        remark: item.remark ?? undefined,
      })),
    });
  }

  @Get()
  async list(@Query() query: ListQuotationsQueryDto): Promise<Quotation[]> {
    return this.quotationService.list(query);
  }

  @Post()
  async create(@Body() dto: CreateQuotationBodyDto): Promise<Quotation> {
    return this.quotationService.create(dto);
  }

  @Get(':id')
  async detail(@Param('id', ParseUUIDPipe) id: string): Promise<Quotation> {
    return this.quotationService.detail(id);
  }

  @CanCapability('crm_write')
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateQuotationBodyDto
  ): Promise<Quotation> {
    return this.quotationService.update(id, dto);
  }

  @CanCapability('crm_write')
  @Post(':id/submit')
  async submit(@Param('id', ParseUUIDPipe) id: string): Promise<Quotation> {
    return this.quotationService.submit(id);
  }

  @CanCapability('crm_write')
  @Post(':id/approve')
  async approve(@Param('id', ParseUUIDPipe) id: string): Promise<Quotation> {
    return this.quotationService.approve(id);
  }

  @CanCapability('crm_write')
  @Post(':id/reject')
  async reject(@Param('id', ParseUUIDPipe) id: string): Promise<Quotation> {
    return this.quotationService.reject(id);
  }

  @CanCapability('crm_write')
  @Post(':id/void')
  async void(@Param('id', ParseUUIDPipe) id: string): Promise<Quotation> {
    return this.quotationService.void(id);
  }

  @CanCapability('crm_write')
  @Post(':id/convert')
  async convert(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<Contract> {
    return this.quotationService.convert(id);
  }
}
