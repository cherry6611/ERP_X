import {
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
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
 *
 * `urbanMaintRate`（城建税率）同样是百分数，但区间是 **(0, 100]**，与库约束
 * `chk_tax_entity_urban_maint_rate` 一致 —— 用 `@IsPositive` 而非 `@Min(0)`，
 * 是为了把"误填 0"挡在入参层（400），而不是留给库约束去拒（500）。
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

  /**
   * 城建税率（百分数：市区 7 / 县镇 5 / 其他 1）。
   *
   * 可选：未配置时附加税计提会**拒绝出数**（不按 0 计提），因此允许先建主体、
   * 后补税率 —— 强制必填会阻断一个本来能正常开票报税的主体建档。
   */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive({ message: '城建税率必须大于 0（百分数，如 7 表示 7%）' })
  @Max(100, { message: '城建税率不得大于 100（百分数口径）' })
  urbanMaintRate?: number | null;

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

  /** 城建税率（百分数，>0 且 ≤100）；传 null 表示清除配置（附加税计提将拒绝出数） */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive({ message: '城建税率必须大于 0（百分数，如 7 表示 7%）' })
  @Max(100, { message: '城建税率不得大于 100（百分数口径）' })
  urbanMaintRate?: number | null;

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
