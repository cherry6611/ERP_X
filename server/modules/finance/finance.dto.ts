import {
  IsDateString,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import type {
  CreateApDto as ICreateApDto,
  CreateArDto as ICreateArDto,
  CreatePaymentDto as ICreatePaymentDto,
  CreateReceiptDto as ICreateReceiptDto,
} from '@shared/api.interface';

export class CreateArDto implements ICreateArDto {
  @IsUUID()
  contractId!: string;

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
  ownerUserId?: string;
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
