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
  CreateRevenueAdjustDto as ICreateRevenueAdjustDto,
  CreateRevenueDto as ICreateRevenueDto,
  ReverseRevenueDto as IReverseRevenueDto,
} from '@shared/api.interface';

/**
 * 收入模块请求体 DTO（API-1 / NFR-M3）。
 *
 * 为什么必须用 class 而不是 interface：Nest 的 `ValidationPipe` 通过 **metatype**
 * 反射装饰器元数据；`interface` 在运行时被擦除，管道会静默放行任意请求体
 * （需求书 §1.2 记录的"20+ 处零校验 @Body()"）。这些 class 均 `implements`
 * shared 中的契约类型，保证前后端字段同源。
 */

const REVENUE_METHODS = [
  'progress',
  'milestone',
  'quantity',
  'subscription',
] as const;
const ADJUST_TYPES = ['discount', 'return', 'other'] as const;

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/u;

export class CreateRevenueDto implements ICreateRevenueDto {
  @IsUUID()
  projectId!: string;

  @IsString()
  @Matches(PERIOD_RE, { message: '期间格式须为 YYYY-MM' })
  period!: string;

  @IsString()
  @IsIn([...REVENUE_METHODS])
  method!: ICreateRevenueDto['method'];

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount!: number;

  @IsOptional()
  @IsString()
  basis?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

/** 收入调整（折让/退回等）：POST /api/revenues/adjusts */
export class CreateRevenueAdjustDto implements ICreateRevenueAdjustDto {
  @IsUUID()
  revenueId!: string;

  @IsString()
  @IsIn([...ADJUST_TYPES], { message: '调整类型不合法' })
  adjustType!: ICreateRevenueAdjustDto['adjustType'];

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01, { message: '调整金额必须大于 0' })
  amount!: number;

  @IsOptional()
  @IsString()
  reason?: string;
}

/** 收入冲回：POST /api/revenues/:id/reverse（reason 可空） */
export class ReverseRevenueDto implements IReverseRevenueDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
