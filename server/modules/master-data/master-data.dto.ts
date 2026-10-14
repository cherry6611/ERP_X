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

const VAT_RATES = [0, 1, 3, 6, 9, 13] as const;

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
