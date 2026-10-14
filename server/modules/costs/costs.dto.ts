import {
  ArrayMinSize,
  IsArray,
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
import { Type } from 'class-transformer';
import { ValidateNested } from 'class-validator';
import type {
  CostAllocationTarget as ICostAllocationTarget,
  CreateAllocationDto as ICreateAllocationDto,
  CreateCostAllocationBatchDto as ICreateCostAllocationBatchDto,
  CreateLaborRateDto as ICreateLaborRateDto,
} from '@shared/api.interface';

/**
 * 成本模块请求体 DTO（API-1 / NFR-M3）。
 *
 * 为什么必须用 class 而不是 interface：Nest 的 `ValidationPipe` 通过 **metatype**
 * 反射装饰器元数据；`interface` 在运行时被擦除，管道会静默放行任意请求体
 * （需求书 §1.2 记录的"20+ 处零校验 @Body()"）。这些 class 均 `implements`
 * shared 中的契约类型，保证前后端字段同源。
 *
 * 校验口径（需求书 §7.1）：金额 `@IsNumber({ maxDecimalPlaces: 2 })` + `@Min`，
 * 期间 `@Matches(/^\d{4}-(0[1-9]|1[0-2])$/)`，UUID `@IsUUID()`。
 */

const COST_TYPES = [
  'labor',
  'outsource',
  'compute',
  'storage',
  'tool',
  'travel',
  'flex_labor',
] as const;

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/u;

/** 角色工时费率（POST /api/costs/labor-rates） */
export class CreateLaborRateDto implements ICreateLaborRateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  roleName!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01, { message: '费率必须大于 0' })
  rate!: number;

  @IsOptional()
  @IsDateString()
  effectiveFrom?: string;
}

/** 公共成本分摊（POST /api/costs/allocations） */
export class CreateAllocationDto implements ICreateAllocationDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  sourceDesc!: string;

  @IsString()
  @IsIn([...COST_TYPES], { message: '非法的成本类型' })
  costType!: ICreateAllocationDto['costType'];

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01, { message: '分摊金额必须大于 0' })
  amount!: number;

  @IsUUID()
  targetProjectId!: string;

  @IsString()
  @Matches(PERIOD_RE, { message: '期间格式须为 YYYY-MM' })
  period!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  sourceRef!: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

/**
 * D-07：分摊目标（项目 + 权重）。
 *
 * 为什么用嵌套 class 而不是裸对象：`@Body()` 里的嵌套结构必须用
 * `@ValidateNested` + `@Type` 才能让 ValidationPipe 真正校验到内层字段；
 * 用 interface 或内联对象类型会在运行时被擦除，内层 `weight` 传字符串也能通过。
 */
export class CostAllocationTargetDto implements ICostAllocationTarget {
  @IsUUID()
  projectId!: string;

  @IsNumber({ maxDecimalPlaces: 6 })
  @Min(0.000001, { message: '分摊权重必须大于 0' })
  weight!: number;
}

/**
 * D-07：一笔公共成本按权重分摊到多个项目。
 *
 * 与单目标 `CreateAllocationDto` 的区别：一次请求生成 N 条分摊记录，
 * 金额由服务端用**最大余数法**计算并保证 `Σ amount === amount`（到分）。
 * 手工拆 N 笔的做法极易出现合计差 1 分（凭证不平），故提供此批量入口。
 */
export class CreateCostAllocationBatchDto
  implements ICreateCostAllocationBatchDto
{
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  sourceDesc!: string;

  @IsString()
  @IsIn([...COST_TYPES], { message: '非法的成本类型' })
  costType!: ICreateCostAllocationBatchDto['costType'];

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01, { message: '分摊金额必须大于 0' })
  amount!: number;

  @IsString()
  @Matches(PERIOD_RE, { message: '期间格式须为 YYYY-MM' })
  period!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  sourceRef!: string;

  @IsArray()
  @ArrayMinSize(1, { message: '分摊目标至少 1 项' })
  @ValidateNested({ each: true })
  @Type(() => CostAllocationTargetDto)
  targets!: CostAllocationTargetDto[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  remark?: string;
}