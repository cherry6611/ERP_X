import {
  ArrayMaxSize,
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
  ValidateIf,
} from 'class-validator';
import type {
  ApWriteoffDto as IApWriteoffDto,
  ArWriteoffDto as IArWriteoffDto,
  BatchInvoiceVerifyDto as IBatchInvoiceVerifyDto,
  CertifyInvoiceDto as ICertifyInvoiceDto,
  CreateApDto as ICreateApDto,
  CreateArDto as ICreateArDto,
  CreateInvoiceDto as ICreateInvoiceDto,
  CreatePaymentDto as ICreatePaymentDto,
  CreateReceiptDto as ICreateReceiptDto,
  GenerateVendorSettlementDto as IGenerateVendorSettlementDto,
  UpdateInvoiceDto as IUpdateInvoiceDto,
} from '@shared/api.interface';

/**
 * 财务请求体 DTO（API-1）。
 *
 * 这些 class `implements` shared 中的契约类型，字段与前后端契约同源；
 * 用 class 而非 interface 的原因：interface 在运行时被擦除，
 * Nest ValidationPipe 会静默放行任意请求体（需求书 §1.2 记录的技术债）。
 */

export class CreateArDto implements ICreateArDto {
  @IsUUID()
  contractId!: string;

  @IsNumber()
  @Min(0.01)
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

  /** D-19：收入确认幂等键，如 revenue:{code} */
  @IsOptional()
  @IsString()
  sourceRef?: string;

  @IsOptional()
  @IsString()
  remark?: string;

  @IsOptional()
  @IsString()
  ownerUserId?: string;
}

export class ArWriteoffDto implements IArWriteoffDto {
  @IsUUID()
  arId!: string;

  @IsUUID()
  receiptId!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;
}

export class ApWriteoffDto implements IApWriteoffDto {
  @IsUUID()
  apId!: string;

  @IsUUID()
  paymentId!: string;

  @IsNumber()
  @Min(0.01)
  amount!: number;
}

export class CreateReceiptDto implements ICreateReceiptDto {
  @IsUUID()
  customerId!: string;

  /**
   * 直接核销的应收单（可选）。校验与独立「核销」接口共用
   * `ArService.applyWriteoffInTx`，所以这里只需保证它是合法 UUID；
   * 作废/客户不一致/超额等业务守卫在 service 里统一判定。
   */
  @IsOptional()
  @IsUUID()
  arId?: string;

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

/**
 * 发票开具（A-06 / C-01 前置）：`direction` 决定进销项，
 * 销项需 `contractId`，进项需 `supplierId`（由 service 做进一步一致性校验）。
 */
export class CreateInvoiceDto implements ICreateInvoiceDto {
  @IsOptional()
  @IsUUID()
  contractId?: string;

  @IsIn(['vat_special', 'vat_normal', 'electronic'], {
    message: '发票类型不合法',
  })
  invoiceType!: 'vat_special' | 'vat_normal' | 'electronic';

  @IsOptional()
  @IsIn(['sales', 'purchase'], { message: 'direction 仅支持 sales / purchase' })
  direction?: 'sales' | 'purchase';

  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @IsUUID()
  arId?: string;

  @IsOptional()
  @IsUUID()
  apId?: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  taxRate?: number;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  invoiceNo?: string;

  @IsOptional()
  @IsDateString()
  invoiceDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;
}

/** 发票补充关联 + 登记后编辑（PATCH /api/finance/invoices/:id）；可空字段传 null 表示清除 */
export class UpdateInvoiceDto implements IUpdateInvoiceDto {
  @IsOptional()
  @IsString()
  @MaxLength(50)
  invoiceNo?: string;

  @IsOptional()
  @IsUUID()
  arId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;

  /*
   * ── 登记后编辑（用户要求）──
   *
   * 可空 UUID 一律用「`@IsOptional()` + `@ValidateIf((_, v) => v !== null)`
   * + `@IsUUID()`」这一组：`@IsOptional()` 让 `undefined` 与 `null` 都短路放行
   * （class-validator 把二者一同视为"未提供"），`@ValidateIf` 再把 `null` 显式排除，
   * 于是**非 null 即必须是合法 UUID**。与 `data-asset.controller.ts`、
   * `master-data.dto.ts#UpdateCustomerDto.taxEntityId` 的既有写法逐字一致。
   *
   * 金额/税率沿用 `CreateInvoiceDto` 的 `@IsNumber({ maxDecimalPlaces: 2 })`（AGENTS.md API-1）。
   *
   * ⚠️ 这些字段能否真正写入**由 service 判定**（凭证是否已过账），见
   * `server/modules/finance/invoice-edit-guard.ts`。此处只负责"格式合法 + 允许出现"——
   * 不加这些字段的话，`forbidNonWhitelisted` 会把请求直接 400，编辑功能根本到不了 service。
   */
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  taxRate?: number;

  @IsOptional()
  @IsDateString()
  invoiceDate?: string;

  @IsOptional()
  @IsIn(['vat_special', 'vat_normal', 'electronic'], {
    message: 'invoiceType 仅支持 vat_special / vat_normal / electronic',
  })
  invoiceType?: IUpdateInvoiceDto['invoiceType'];

  @IsOptional()
  @IsIn(['sales', 'purchase'], {
    message: 'direction 仅支持 sales / purchase',
  })
  direction?: IUpdateInvoiceDto['direction'];

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  projectId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  contractId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  supplierId?: string | null;

  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  apId?: string | null;
}

/** 外协供应商结算生成（按供应商 + 月份，可选项目） */
export class GenerateVendorSettlementDto implements IGenerateVendorSettlementDto {
  @IsUUID()
  supplierId!: string;

  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'period 必须为 YYYY-MM' })
  period!: string;

  @IsOptional()
  @IsUUID()
  projectId?: string | null;

  /** 生成的应付单到期日（缺省由 service 按账期推算） */
  @IsOptional()
  @IsDateString()
  dueDate?: string;
}

/* ===================== C-01 发票查验与勾选认证 ===================== */

/** 勾选认证入参（API-1：class DTO，字段与 shared 契约同源） */
export class CertifyInvoiceDto implements ICertifyInvoiceDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'certificationPeriod 必须为 YYYY-MM（税款所属期）',
  })
  certificationPeriod!: string;

  @IsOptional()
  @IsIn(['certify', 'deduct'], {
    message: 'action 仅支持 certify（认证）/ deduct（已抵扣）',
  })
  action?: 'certify' | 'deduct';
}

/** 批量查验入参 */
export class BatchInvoiceVerifyDto implements IBatchInvoiceVerifyDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'ids 至少包含 1 张发票' })
  @ArrayMaxSize(200, { message: 'ids 最多 200 张（超过请分批）' })
  @IsUUID('4', { each: true, message: 'ids 每项必须为合法 UUID' })
  ids!: string[];
}
