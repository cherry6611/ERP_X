import { Type } from 'class-transformer';
import {
  IsArray,
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import type {
  CreateContractDto as ICreateContractDto,
  CreateMilestoneDto as ICreateMilestoneDto,
  UpdateContractDto as IUpdateContractDto,
} from '@shared/api.interface';

const VAT_RATES = [0, 1, 3, 6, 9, 13] as const;
const BILLING_MODELS = [
  'project',
  'quantity',
  'subscription',
  'framework',
] as const;

export class CreateMilestoneDto implements ICreateMilestoneDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsOptional()
  @IsString()
  dueCondition?: string;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class CreateContractDto implements ICreateContractDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsUUID()
  customerId!: string;

  @IsString()
  @IsIn([...BILLING_MODELS])
  billingModel!: ICreateContractDto['billingModel'];

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsOptional()
  @IsNumber()
  @IsIn([...VAT_RATES])
  taxRate?: number;

  @IsOptional()
  @IsUUID()
  taxEntityId?: string;

  @IsOptional()
  @IsDateString()
  signDate?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  owner?: string;

  @IsOptional()
  @IsString()
  paymentTerms?: string;

  @IsOptional()
  @IsString()
  remark?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateMilestoneDto)
  milestones?: CreateMilestoneDto[];
}

export class UpdateContractDto implements IUpdateContractDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsNumber()
  @Min(0)
  amount?: number;

  @IsOptional()
  @IsNumber()
  @IsIn([...VAT_RATES])
  taxRate?: number;

  @IsOptional()
  @IsUUID()
  taxEntityId?: string;

  @IsOptional()
  @IsString()
  owner?: string;

  @IsOptional()
  @IsString()
  paymentTerms?: string;

  @IsOptional()
  @IsDateString()
  startDate?: string;

  @IsOptional()
  @IsDateString()
  endDate?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}
