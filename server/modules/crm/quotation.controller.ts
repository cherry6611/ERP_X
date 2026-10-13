import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CanRole, NeedLogin } from '@server/platform';
import { IsArray, IsIn, IsNumber, IsOptional, IsString, IsUUID, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { QuotationService } from './quotation.service';
import { QuotationImportService } from './quotation-import.service';
import type {
  Contract,
  CreateQuotationDto,
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

  @CanRole(['admin'])
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateQuotationBodyDto
  ): Promise<Quotation> {
    return this.quotationService.update(id, dto);
  }

  @CanRole(['admin'])
  @Post(':id/submit')
  async submit(@Param('id', ParseUUIDPipe) id: string): Promise<Quotation> {
    return this.quotationService.submit(id);
  }

  @CanRole(['admin'])
  @Post(':id/approve')
  async approve(@Param('id', ParseUUIDPipe) id: string): Promise<Quotation> {
    return this.quotationService.approve(id);
  }

  @CanRole(['admin'])
  @Post(':id/reject')
  async reject(@Param('id', ParseUUIDPipe) id: string): Promise<Quotation> {
    return this.quotationService.reject(id);
  }

  @CanRole(['admin'])
  @Post(':id/void')
  async void(@Param('id', ParseUUIDPipe) id: string): Promise<Quotation> {
    return this.quotationService.void(id);
  }

  @CanRole(['admin'])
  @Post(':id/convert')
  async convert(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<Contract> {
    return this.quotationService.convert(id);
  }
}
