import {
  IsBoolean,
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
  @IsIn([1, 5, 7], {
    message:
      '城建税率只能是 7（市区）、5（县镇）或 1（其他）；请填百分数而非小数（7% 填 7，不是 0.07）',
  })
  urbanMaintRate?: number | null;

  /**
   * T9：增值税申报周期（小规模免征额度判定的必要要件）。
   *
   * 可选：未声明时底稿不做免征判定（按偏严口径不减免，不会少缴），
   * 并在差异区提示补录。**不允许**默认成 monthly —— 在季报主体上按月判定
   * 会在「季度合计 > 30 万但单月都不超 10 万」时错误免征 → 少缴。
   */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(['monthly', 'quarterly'], {
    message: '增值税申报周期仅支持 monthly（按月）/ quarterly（按季）',
  })
  vatFilingCycle?: 'monthly' | 'quarterly' | null;

  /** T9：是否启用免征额度判定；传 false 表示放弃免税权（一律不免征） */
  @IsOptional()
  @IsBoolean()
  vatExemptionEnabled?: boolean;

  /**
   * §4.7(e)：企业所得税「小型微利企业」资格。
   *
   * 三态：`true` 确认享受（5% 实际税负）/ `false` 确认不享受（25%）/
   * `null` 显式清空回「未确认」。省略该字段表示"不改动"。
   *
   * `@ValidateIf((_, v) => v !== null)` 是必须的：不加它，`@IsBoolean()`
   * 会把显式的 `null` 判为非法 —— 而 `null` 恰恰是"清空回未确认"的合法表达，
   * 少了它使用者就**无法把误标的小微资格改回去**（只能一直享受 5%，即持续少缴）。
   * 同一写法见本文件的 `vatFilingCycle`。
   */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsBoolean()
  citSmallMicro?: boolean | null;

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
  @IsIn([1, 5, 7], {
    message:
      '城建税率只能是 7（市区）、5（县镇）或 1（其他）；请填百分数而非小数（7% 填 7，不是 0.07）',
  })
  urbanMaintRate?: number | null;

  /**
   * T9：增值税申报周期（小规模免征额度判定的必要要件）。
   *
   * 可选：未声明时底稿不做免征判定（按偏严口径不减免，不会少缴），
   * 并在差异区提示补录。**不允许**默认成 monthly —— 在季报主体上按月判定
   * 会在「季度合计 > 30 万但单月都不超 10 万」时错误免征 → 少缴。
   */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsIn(['monthly', 'quarterly'], {
    message: '增值税申报周期仅支持 monthly（按月）/ quarterly（按季）',
  })
  vatFilingCycle?: 'monthly' | 'quarterly' | null;

  /** T9：是否启用免征额度判定；传 false 表示放弃免税权（一律不免征） */
  @IsOptional()
  @IsBoolean()
  vatExemptionEnabled?: boolean;

  /**
   * §4.7(e)：企业所得税「小型微利企业」资格。
   *
   * 三态：`true` 确认享受（5% 实际税负）/ `false` 确认不享受（25%）/
   * `null` 显式清空回「未确认」。省略该字段表示"不改动"。
   *
   * `@ValidateIf((_, v) => v !== null)` 是必须的：不加它，`@IsBoolean()`
   * 会把显式的 `null` 判为非法 —— 而 `null` 恰恰是"清空回未确认"的合法表达，
   * 少了它使用者就**无法把误标的小微资格改回去**（只能一直享受 5%，即持续少缴）。
   * 同一写法见本文件的 `vatFilingCycle`。
   */
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsBoolean()
  citSmallMicro?: boolean | null;

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
