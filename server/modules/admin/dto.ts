import {
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateIf,
} from 'class-validator';
import type {
  AdminBillActionDto as IAdminBillActionDto,
  CreateAdminAffairDto as ICreateAdminAffairDto,
  CreateAdminAssetDto as ICreateAdminAssetDto,
  CreateAdminBillDto as ICreateAdminBillDto,
  CreateAdminRentContractDto as ICreateAdminRentContractDto,
  UpdateAdminAffairDto as IUpdateAdminAffairDto,
  UpdateAdminAssetDto as IUpdateAdminAssetDto,
  UpdateAdminBillDto as IUpdateAdminBillDto,
  UpdateAdminRentContractDto as IUpdateAdminRentContractDto,
} from '@shared/api.interface';

const nullable = (_: unknown, value: unknown): boolean => value !== null;

export class CreateAdminRentContractDto implements ICreateAdminRentContractDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsNotEmpty()
  propertyAddress!: string;

  @IsString()
  @IsNotEmpty()
  lessor!: string;

  @IsNumber()
  @Min(0)
  monthlyRent!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  deposit?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  area?: number;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsOptional()
  @IsString()
  @IsIn(['monthly', 'quarterly', 'half_yearly', 'yearly'])
  paymentCycle?: 'monthly' | 'quarterly' | 'half_yearly' | 'yearly';

  @IsOptional()
  @IsUUID()
  taxEntityId?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class UpdateAdminRentContractDto implements IUpdateAdminRentContractDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  propertyAddress?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  lessor?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  monthlyRent?: number;

  @IsOptional()
  @ValidateIf(nullable)
  @IsNumber()
  @Min(0)
  deposit?: number | null;

  @IsOptional()
  @ValidateIf(nullable)
  @IsNumber()
  @Min(0)
  area?: number | null;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  @IsIn(['monthly', 'quarterly', 'half_yearly', 'yearly'])
  paymentCycle?: 'monthly' | 'quarterly' | 'half_yearly' | 'yearly';

  @IsOptional()
  @ValidateIf(nullable)
  @IsString()
  remark?: string | null;
}

export class CreateAdminBillDto implements ICreateAdminBillDto {
  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsString()
  @IsIn(['rent', 'property', 'water_electric', 'office', 'vehicle_travel', 'other'])
  billType!: 'rent' | 'property' | 'water_electric' | 'office' | 'vehicle_travel' | 'other';

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsString()
  @IsNotEmpty()
  period!: string;

  @IsDateString()
  expenseDate!: string;

  @IsOptional()
  @IsString()
  payee?: string;

  @IsOptional()
  @IsUUID()
  rentContractId?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class UpdateAdminBillDto implements IUpdateAdminBillDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  title?: string;

  @IsOptional()
  @IsString()
  @IsIn(['rent', 'property', 'water_electric', 'office', 'vehicle_travel', 'other'])
  billType?: 'rent' | 'property' | 'water_electric' | 'office' | 'vehicle_travel' | 'other';

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  period?: string;

  @IsOptional()
  @IsDateString()
  expenseDate?: string;

  @IsOptional()
  @ValidateIf(nullable)
  @IsString()
  payee?: string | null;

  @IsOptional()
  @ValidateIf(nullable)
  @IsUUID()
  rentContractId?: string | null;

  @IsOptional()
  @ValidateIf(nullable)
  @IsString()
  remark?: string | null;
}

export class AdminBillActionDto implements IAdminBillActionDto {
  @IsOptional()
  @IsDateString()
  payDate?: string;

  @IsOptional()
  @IsString()
  payMethod?: string;

  @IsOptional()
  @IsString()
  approveRemark?: string;
}

export class CreateAdminAssetDto implements ICreateAdminAssetDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsIn(['office_equipment', 'office_furniture', 'other'])
  category!: 'office_equipment' | 'office_furniture' | 'other';

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsNumber()
  @Min(0)
  unitPrice!: number;

  @IsOptional()
  @IsString()
  location?: string;

  @IsOptional()
  @IsString()
  owner?: string;

  @IsOptional()
  @IsDateString()
  purchaseDate?: string;

  @IsOptional()
  @IsString()
  @IsIn(['in_use', 'idle', 'scrapped'])
  status?: 'in_use' | 'idle' | 'scrapped';

  @IsOptional()
  @IsString()
  remark?: string;
}

export class UpdateAdminAssetDto implements IUpdateAdminAssetDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  @IsIn(['office_equipment', 'office_furniture', 'other'])
  category?: 'office_equipment' | 'office_furniture' | 'other';

  @IsOptional()
  @IsInt()
  @Min(1)
  quantity?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  unitPrice?: number;

  @IsOptional()
  @ValidateIf(nullable)
  @IsString()
  location?: string | null;

  @IsOptional()
  @ValidateIf(nullable)
  @IsString()
  owner?: string | null;

  @IsOptional()
  @ValidateIf(nullable)
  @IsDateString()
  purchaseDate?: string | null;

  @IsOptional()
  @IsString()
  @IsIn(['in_use', 'idle', 'scrapped'])
  status?: 'in_use' | 'idle' | 'scrapped';

  @IsOptional()
  @ValidateIf(nullable)
  @IsString()
  remark?: string | null;
}

export class CreateAdminAffairDto implements ICreateAdminAffairDto {
  @IsString()
  @IsIn(['vehicle', 'travel'])
  affairType!: 'vehicle' | 'travel';

  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  participants?: string[];

  @IsDateString()
  startDate!: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class UpdateAdminAffairDto implements IUpdateAdminAffairDto {
  @IsOptional()
  @IsString()
  @IsIn(['vehicle', 'travel'])
  affairType?: 'vehicle' | 'travel';

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  title?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  participants?: string[];

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @ValidateIf(nullable)
  @IsDateString()
  endDate?: string | null;

  @IsOptional()
  @ValidateIf(nullable)
  @IsNumber()
  @Min(0)
  amount?: number | null;

  @IsOptional()
  @ValidateIf(nullable)
  @IsString()
  remark?: string | null;
}
