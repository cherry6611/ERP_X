import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
} from 'class-validator';
import type {
  CreateRevenueDto as ICreateRevenueDto,
} from '@shared/api.interface';

const REVENUE_METHODS = [
  'progress',
  'milestone',
  'quantity',
  'subscription',
] as const;

export class CreateRevenueDto implements ICreateRevenueDto {
  @IsUUID()
  projectId!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}$/)
  period!: string;

  @IsString()
  @IsIn([...REVENUE_METHODS])
  method!: ICreateRevenueDto['method'];

  @IsNumber()
  @Min(0)
  amount!: number;

  @IsOptional()
  @IsString()
  basis?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}
