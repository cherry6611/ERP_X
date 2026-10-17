import {
  IsBoolean,
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
  ValidateIf,
} from 'class-validator';
import type {
  CreateContactDto as ICreateContactDto,
  CreateCustomerDto as ICreateCustomerDto,
  CreateSupplierDto as ICreateSupplierDto,
  UpdateCustomerDto as IUpdateCustomerDto,
  UpdateSupplierDto as IUpdateSupplierDto,
} from '@shared/api.interface';
import { VAT_RATES as SHARED_VAT_RATES } from '@shared/tax';

/*
 * ⚠️ **不要在这里重新定义 VAT_RATES**（原实现是 `[0, 1, 3, 6, 9, 13]`）。
 *
 * 那是一个**过期副本**：唯一权威 `shared/tax.ts` 的 `VAT_RATES` 是
 * `[0, 1, 3, 5, 6, 9, 13]`（含 5% 简易计税档），数据库 CHECK
 * `chk_customer_default_tax_rate` 也已由迁移
 * `2026-10-16-fix04-tax-rate-5pct-and-revenue-unique.sql` 放宽到含 5%。
 * 而客户/供应商表单的下拉来自 `resolveRateOptions()`（读 `shared/tax.ts`），
 * 「关联纳税主体 = 不指定」时返回全量档位 —— **5% 就在下拉里**。
 *
 * 后果（本会话实测）：选 5% 保存必然被本文件的 `@IsIn` 拒绝，返回 400
 * `defaultTaxRate must be one of the following values: 0, 1, 3, 6, 9, 13`，
 * 前端只弹「保存失败」；而同一仓的发票/合同表单用的是同一个 helper，
 * 于是同一个税率在有的入口能存、在有的入口不能 —— 典型的口径分叉。
 *
 * 判据：档位集合的**唯一权威是 `@shared/tax`**（前端下拉、库层 CHECK、
 * 校验层三处必须同源）。这里改为直接引用它，杜绝再次漂移。
 */
const VAT_RATES = SHARED_VAT_RATES;

export class CreateCustomerDto implements ICreateCustomerDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  uscc?: string;

  @IsOptional()
  @IsString()
  industry?: string;

  @IsOptional()
  @IsString()
  creditLevel?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  creditLimit?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  termsDays?: number;

  @IsOptional()
  @IsString()
  status?: string;

  @IsOptional()
  @IsString()
  remark?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  taxEntityId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @IsIn([...VAT_RATES])
  defaultTaxRate?: number | null;
}

/** 客户更新（PATCH 语义：全部字段可选） */
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
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  taxEntityId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @IsIn([...VAT_RATES])
  defaultTaxRate?: number | null;
}

/** 联系人新增 */
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

/** 供应商新增 */
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
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  taxEntityId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @IsIn([...VAT_RATES])
  defaultTaxRate?: number | null;
}

/** 供应商更新 */
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
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  taxEntityId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber()
  @IsIn([...VAT_RATES])
  defaultTaxRate?: number | null;
}
