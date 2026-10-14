import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';
import type {
  ApWriteoffDto as IApWriteoffDto,
  ArWriteoffDto as IArWriteoffDto,
  CreateApDto as ICreateApDto,
  CreateArDto as ICreateArDto,
  CreateInvoiceDto as ICreateInvoiceDto,
  CreatePaymentDto as ICreatePaymentDto,
  CreateReceiptDto as ICreateReceiptDto,
  GenerateVendorSettlementDto as IGenerateVendorSettlementDto,
  UpdateInvoiceDto as IUpdateInvoiceDto,
} from '@shared/api.interface';

/**
 * 财务请求体 DTO（API-1）。
 *
 * 这些 class `implements` shared 中的契约类型，字段与前后端契约同源；
 * 用 class 而非 interface 的原因：interface 在运行时被擦除，
 * Nest ValidationPipe 会静默放行任意请求体（需求书 §1.2 记录的技术债）。
 */

export class CreateArDto implements ICreateArDto {
  @IsUUID()
  contractId!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsString()
  source?: string;

  /** D-19：收入确认幂等键，如 revenue:{code} */
  @IsOptional()
  @IsString()
  sourceRef?: string;

  @IsOptional()
  @IsString()
  remark?: string;

  @IsOptional()
  @IsString()
  ownerUserId?: string;
}

export class ArWriteoffDto implements IArWriteoffDto {
  @IsUUID()
  arId!: string;

  @IsUUID()
  receiptId!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;
}

export class ApWriteoffDto implements IApWriteoffDto {
  @IsUUID()
  apId!: string;

  @IsUUID()
  paymentId!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;
}

export class CreateReceiptDto implements ICreateReceiptDto {
  @IsUUID()
  customerId!: string;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsOptional()
  @IsDateString()
  receiptDate?: string;

  @IsOptional()
  @IsString()
  method?: string;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class CreateApDto implements ICreateApDto {
  @IsUUID()
  supplierId!: string;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsString()
  remark?: string;

  @IsOptional()
  @IsString()
  sourceRef?: string;
}

export class CreatePaymentDto implements ICreatePaymentDto {
  @IsUUID()
  apId!: string;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsOptional()
  @IsDateString()
  payDate?: string;

  @IsOptional()
  @IsString()
  method?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

/**
 * 发票开具（A-06 / C-01 前置）：`direction` 决定进销项，
 * 销项需 `contractId`，进项需 `supplierId`（由 service 做进一步一致性校验）。
 */
export class CreateInvoiceDto implements ICreateInvoiceDto {
  @IsOptional()
  @IsUUID()
  contractId?: string;

  @IsIn(['vat_special', 'vat_normal', 'electronic'], {
    message: '发票类型不合法',
  })
  invoiceType!: 'vat_special' | 'vat_normal' | 'electronic';

  @IsOptional()
  @IsIn(['sales', 'purchase'], { message: 'direction 仅支持 sales / purchase' })
  direction?: 'sales' | 'purchase';

  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @IsUUID()
  arId?: string;

  @IsOptional()
  @IsUUID()
  apId?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  taxRate?: number;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  invoiceNo?: string;

  @IsOptional()
  @IsDateString()
  invoiceDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;
}

/** 发票补充关联（PATCH /api/finance/invoices/:id）：arId 传 null 表示清除关联 */
export class UpdateInvoiceDto implements IUpdateInvoiceDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  invoiceNo?: string;

  @IsOptional()
  @IsUUID()
  arId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;
}

/** 外协供应商结算生成（按供应商 + 月份，可选项目） */
export class GenerateVendorSettlementDto implements IGenerateVendorSettlementDto {
  @IsUUID()
  supplierId!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period 必须为 YYYY-MM' })
  period!: string;

  @IsOptional()
  @IsUUID()
  projectId?: string | null;

  /** 生成的应付单到期日（缺省由 service 按账期推算） */
  @IsOptional()
  @IsDateString()
  dueDate?: string;
}
