import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import type {
  CreateContactDto as ICreateContactDto,
  CreateLeadDto as ICreateLeadDto,
  CreateOpportunityDto as ICreateOpportunityDto,
  CreateSupplierDto as ICreateSupplierDto,
  UpdateCustomerDto as IUpdateCustomerDto,
  UpdateLeadDto as IUpdateLeadDto,
  UpdateOpportunityDto as IUpdateOpportunityDto,
  UpdateSupplierDto as IUpdateSupplierDto,
} from '@shared/api.interface';

/**
 * CRM / 主数据请求体 DTO（API-1）。
 *
 * 为什么必须用 class 而不是 interface：
 * Nest 的 `ValidationPipe` 通过 **metatype** 反射装饰器元数据；`interface` 在运行时
 * 被擦除，管道会静默放行任意请求体（需求书 §1.2 记录的"20+ 处零校验 @Body()"）。
 * 这些 class 均 `implements` shared 中的契约类型，保证前后端字段同源。
 *
 * 校验口径（API-7）：金额用 `@IsNumber({ maxDecimalPlaces: 2 })` + `@Min`，
 * 时间用 `@IsDateString()`，UUID 用 `@IsUUID()`。
 */

const LEAD_STATUSES = ['new', 'following', 'converted', 'lost'] as const;
const OPPORTUNITY_STAGES = [
  'new',
  'following',
  'quoting',
  'negotiating',
  'won',
  'lost',
] as const;

/* ========== 客户 ========== */

export class UpdateCustomerDto implements IUpdateCustomerDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  uscc?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  industry?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  creditLevel?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  creditLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(3650)
  termsDays?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;

  @IsOptional()
  @IsUUID()
  taxEntityId?: string | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  defaultTaxRate?: number | null;
}

/* ========== 联系人 ========== */

export class CreateContactDto implements ICreateContactDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @IsEmail({}, { message: '邮箱格式不正确' })
  @MaxLength(200)
  email?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  position?: string;

  @IsOptional()
  @IsBoolean()
  isPrimary?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;
}

/* ========== 供应商 ========== */

export class CreateSupplierDto implements ICreateSupplierDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  contactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  bankAccount?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  rating?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;

  @IsOptional()
  @IsUUID()
  taxEntityId?: string | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  defaultTaxRate?: number | null;
}

export class UpdateSupplierDto implements IUpdateSupplierDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  contactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  bankAccount?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  rating?: number;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;

  @IsOptional()
  @IsUUID()
  taxEntityId?: string | null;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  defaultTaxRate?: number | null;
}

/* ========== 线索 ========== */

export class CreateLeadDto implements ICreateLeadDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  customerName!: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  source?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  contactName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  owner?: string;

  @IsOptional()
  @IsDateString()
  nextDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;
}

export class UpdateLeadDto implements IUpdateLeadDto {
  @IsOptional()
  @IsIn([...LEAD_STATUSES], { message: '线索状态不合法' })
  status?: (typeof LEAD_STATUSES)[number];

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  followNote?: string;

  @IsOptional()
  @IsDateString()
  nextDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;
}

/* ========== 商机 ========== */

export class CreateOpportunityDto implements ICreateOpportunityDto {
  @IsUUID()
  customerId!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  title!: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  winRate?: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  owner?: string;

  @IsOptional()
  @IsDateString()
  expectedDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;
}

export class UpdateOpportunityDto implements IUpdateOpportunityDto {
  @IsOptional()
  @IsIn([...OPPORTUNITY_STAGES], { message: '商机阶段不合法' })
  stage?: (typeof OPPORTUNITY_STAGES)[number];

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  winRate?: number;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  owner?: string;

  @IsOptional()
  @IsDateString()
  expectedDate?: string;

  /** 选定最终成交报价单；传 null 清除 */
  @IsOptional()
  @IsUUID()
  wonQuotationId?: string | null;
}
