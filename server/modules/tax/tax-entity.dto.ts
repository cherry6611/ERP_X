import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';

/**
 * 纳税主体请求体 DTO（API-1）。
 *
 * 用 class 而非 interface 的原因：Nest ValidationPipe 依赖运行时 metatype，
 * interface 会被擦除导致管道静默放行任意请求体（需求书 §1.2 记录的技术债）。
 *
 * 税率口径：`defaultOutputRate` / `defaultInputRate` 是百分数（如 6 表示 6%），
 * 与 `shared/tax.ts` 的 VAT_RATES 一致；这里只做区间校验（0~100），
 * 是否为"法定档位"由 service 按纳税人资格（一般/小规模）判定，避免把两处口径混淆。
 */

export class CreateTaxEntityDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(20)
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(20)
  uscc?: string | null;

  @IsIn(['general', 'small'], { message: '纳税人资格仅支持 general / small' })
  taxpayerType!: 'general' | 'small';

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  defaultOutputRate!: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  defaultInputRate!: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  invoiceTitle?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(300)
  invoiceAddress?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(40)
  invoicePhone?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  invoiceBank?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(64)
  invoiceAccount?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(1000)
  remark?: string | null;
}

/** 更新请求体：全部字段可选（PATCH 语义） */
export class UpdateTaxEntityDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(20)
  uscc?: string | null;

  @IsOptional()
  @IsIn(['general', 'small'], { message: '纳税人资格仅支持 general / small' })
  taxpayerType?: 'general' | 'small';

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  defaultOutputRate?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  defaultInputRate?: number;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  invoiceTitle?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(300)
  invoiceAddress?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(40)
  invoicePhone?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(200)
  invoiceBank?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(64)
  invoiceAccount?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(1000)
  remark?: string | null;
}
