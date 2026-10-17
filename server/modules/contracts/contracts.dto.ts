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
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import type { ContractItemInput } from './contract-items.service';
import type {
  CreateCalloffDto as ICreateCalloffDto,
  CreateContractDto as ICreateContractDto,
  CreateContractVersionDto as ICreateContractVersionDto,
  CreateMilestoneDto as ICreateMilestoneDto,
  ImportQuotationItemsDto as IImportQuotationItemsDto,
  UpdateContractDto as IUpdateContractDto,
  UpdateMilestoneDto as IUpdateMilestoneDto,
} from '@shared/api.interface';
import { VAT_RATES as SHARED_VAT_RATES } from '@shared/tax';

/**
 * 合同模块请求体 DTO（API-1 / NFR-M3）。
 *
 * 为什么必须用 class 而不是 interface：Nest 的 `ValidationPipe` 通过 **metatype**
 * 反射装饰器元数据；`interface` 与内联对象类型在运行时被擦除，管道会静默放行任意
 * 请求体（需求书 §1.2 记录的"20+ 处零校验 @Body()"）。这些 class 均 `implements`
 * shared 中的契约类型，保证前后端字段同源。
 */

/*
 * ⚠️ **不要在这里重新定义 VAT_RATES**（原实现是 `[0, 1, 3, 6, 9, 13]`，
 * 缺 5% 简易计税档），理由同 `master-data.dto.ts`：唯一权威是
 * `shared/tax.ts`（含 5%），数据库 CHECK 亦已放宽。
 * 合同/报价表单的税率下拉同样读该权威，因此这里维持本地副本会让
 * 「5% 能选不能存」。改为引用共享常量。
 */
const VAT_RATES = SHARED_VAT_RATES;
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

/** 合同里程碑更新（PATCH /api/contracts/milestones/:id） */
export class UpdateMilestoneDto implements IUpdateMilestoneDto {
  /** 仅允许置为已达成（其余状态由服务层状态机约束） */
  @IsOptional()
  @IsIn(['reached'], { message: '里程碑状态仅支持 reached' })
  status?: 'reached';

  @IsOptional()
  @IsDateString()
  actualDate?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  amount?: number;
}

/** 合同变更（POST /api/contracts/:id/changes） */
export class CreateContractVersionDto implements ICreateContractVersionDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(5000)
  changeLog!: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  newAmount?: number;
}

/** 合同叫料/下单（POST /api/contracts/:id/calloffs） */
export class CreateCalloffDto implements ICreateCalloffDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01, { message: '叫料金额必须大于 0' })
  amount!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  quantity?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  unitPrice?: number;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsDateString()
  orderDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;
}

/** 按报价单导入合同明细（POST /api/contracts/:id/items/import-quotation） */
export class ImportQuotationItemsDto implements IImportQuotationItemsDto {
  @IsUUID()
  quotationId!: string;
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

  /**
   * 客户（仅 `draft` 可改，服务层守卫见 `contract-update-guard.ts`）。
   * `@IsUUID()` 与 `CreateContractDto` 一致：非 uuid 的字符串不该进 SQL 比较。
   */
  @IsOptional()
  @IsUUID()
  customerId?: string;

  /** 计费模式（已关闭/已终止的合同冻结） */
  @IsOptional()
  @IsString()
  @IsIn([...BILLING_MODELS])
  billingModel?: IUpdateContractDto['billingModel'];

  @IsOptional()
  @IsString()
  owner?: string;

  @IsOptional()
  @IsString()
  paymentTerms?: string;

  /*
   * 三个日期字段是 `string | null`：`null` 表示**清空**（PATCH 语义），
   * `undefined` 表示不改。`@IsOptional()` 会跳过 `null` 的其余校验，
   * 因此清空不会被 `@IsDateString()` 拒掉；非空值仍必须是合法日期串。
   */
  @IsOptional()
  @IsDateString()
  signDate?: string | null;

  @IsOptional()
  @IsDateString()
  startDate?: string | null;

  @IsOptional()
  @IsDateString()
  endDate?: string | null;

  @IsOptional()
  @IsString()
  remark?: string;
}

/** 合同明细行入参（POST/PATCH /api/contracts/:id/items）：class DTO 让 ValidationPipe 真正生效 */
export class ContractItemBodyDto implements ContractItemInput {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  itemName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  unit?: string;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0.0001)
  quantity!: number;

  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  unitPrice!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  discountPct?: number;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  taxRate!: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  estUnitCost?: number;

  @IsOptional()
  @IsIn(['quotation', 'manual', 'change'])
  sourceType?: 'quotation' | 'manual' | 'change';

  @IsOptional()
  @IsUUID()
  sourceItemId?: string | null;
}
