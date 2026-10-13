import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateIf,
} from 'class-validator';
import type {
  CreateCustomerDto as ICreateCustomerDto,
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
