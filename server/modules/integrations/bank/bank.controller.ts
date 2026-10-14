import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { NeedLogin } from '@server/platform';
import { CanCapability } from '@server/modules/integrations/integration-authz';
import { actorFromRequest } from '@server/common/auth/actor';
import type { Request } from 'express';
import {
  IsBoolean,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { BankAccountService } from './bank-account.service';
import { BankStatementService } from './bank-statement.service';
import { BankReconciliationService } from './bank-reconciliation.service';
import { BankImportMappingService } from './bank-import-mapping.service';
import type {
  AutoMatchResult,
  BankAccountItem,
  BankImportMappingItem,
  BankMatchBizType,
  BankReconciliationReport,
  BankStatementImportResult,
  BankStatementItem,
  BankStatementMapping,
  BankStatementMatchStat,
  BankStatementMatchStatus,
  CreateBankAccountDto as ICreateBankAccountDto,
  ManualMatchBankStatementDto as IManualMatchBankStatementDto,
  PagedResult,
  SaveBankImportMappingDto as ISaveBankImportMappingDto,
  UnmatchBankStatementDto as IUnmatchBankStatementDto,
  UpdateBankAccountDto as IUpdateBankAccountDto,
} from '@shared/api.interface';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * 上传文件的最小结构。
 * 不用 `Express.Multer.File`：仓库 @types/express 为 v5，与 @types/multer v2 的
 * 全局命名空间声明不兼容（tsc 报 "Namespace Express has no exported member 'Multer'"）。
 */
export interface UploadedFileLike {
  originalname: string;
  size: number;
  buffer: Buffer;
}

export class CreateBankAccountDto implements ICreateBankAccountDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  accountNo!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  bankName!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  branchName?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{3}$/, { message: '币种必须为 3 位字母代码（如 CNY）' })
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  accountCode?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  openingBalance?: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  contactPerson?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

export class UpdateBankAccountDto implements IUpdateBankAccountDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  accountNo?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  bankName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  branchName?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{3}$/, { message: '币种必须为 3 位字母代码（如 CNY）' })
  currency?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  accountCode?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  openingBalance?: number;

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;

  @IsOptional()
  @IsIn(['active', 'disabled'])
  status?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  contactPerson?: string;

  @IsOptional()
  @IsString()
  @MaxLength(30)
  contactPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

/** 导入请求：multipart 表单，mapping 为 JSON 字符串（银行列名不固定，需运行期校验） */
export class ImportBankStatementDto {
  @IsUUID()
  bankAccountId!: string;

  /** JSON 字符串形式的字段映射，见 BankStatementMapping */
  @IsString()
  @MinLength(2)
  mapping!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;

  @IsOptional()
  @IsString()
  @IsIn(['true', 'false'])
  autoMatch?: string;
}

export class ManualMatchBankStatementDto implements IManualMatchBankStatementDto {
  @IsIn(['receipt', 'payment', 'voucher'])
  bizType!: BankMatchBizType;

  @IsUUID()
  bizId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

export class UnmatchBankStatementDto implements IUnmatchBankStatementDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

export class AutoMatchBankStatementDto {
  @IsOptional()
  @IsUUID()
  bankAccountId?: string;

  @IsOptional()
  @IsString()
  @Matches(PERIOD_PATTERN, { message: 'period 格式必须为 YYYY-MM' })
  period?: string;

  @IsOptional()
  @IsNumber()
  @Min(1)
  limit?: number;
}

export class SaveBankImportMappingDto implements ISaveBankImportMappingDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  bankName?: string;

  @IsObject()
  mapping!: BankStatementMapping;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

/** 运行期校验映射 JSON：transactionDate 与 amount 为必填列 */
export function parseBankStatementMapping(raw: string): BankStatementMapping {  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BadRequestException('mapping 必须是合法 JSON 字符串');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new BadRequestException('mapping 必须是 JSON 对象');
  }
  const mapping = parsed as BankStatementMapping;
  if (!mapping.transactionDate || !mapping.amount) {
    throw new BadRequestException('mapping 必须包含 transactionDate 与 amount 列名');
  }
  return mapping;
}

/**
 * C-02 银行账户与银行流水。
 * 读：@CanCapability('finance')（admin / finance_viewer）；
 * 写：@CanCapability('finance_write')（当前矩阵仅 admin 为 rw）。
 */
@NeedLogin()
@Controller('api/finance')
export class BankController {
  constructor(
    private readonly bankAccounts: BankAccountService,
    private readonly statements: BankStatementService,
    private readonly reconciliation: BankReconciliationService,
    private readonly mappings: BankImportMappingService
  ) {}

  /* ---------- 银行账户主数据 ---------- */

  @CanCapability('finance')
  @Get('bank-accounts')
  async listAccounts(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('keyword') keyword?: string
  ): Promise<PagedResult<BankAccountItem>> {
    return this.bankAccounts.listAccounts({
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
      status: status || undefined,
      keyword: keyword || undefined,
    });
  }

  @CanCapability('finance')
  @Get('bank-accounts/:id')
  async getAccount(@Param('id', ParseUUIDPipe) id: string): Promise<BankAccountItem> {
    return this.bankAccounts.getAccount(id);
  }

  @CanCapability('finance_write')
  @Post('bank-accounts')
  async createAccount(@Body() dto: CreateBankAccountDto): Promise<BankAccountItem> {
    return this.bankAccounts.createAccount(dto);
  }

  @CanCapability('finance_write')
  @Patch('bank-accounts/:id')
  async updateAccount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBankAccountDto
  ): Promise<BankAccountItem> {
    return this.bankAccounts.updateAccount(id, dto);
  }

  /* ---------- 导入字段映射模板 ---------- */

  @CanCapability('finance')
  @Get('bank-import-mappings')
  async listMappings(): Promise<BankImportMappingItem[]> {
    return this.mappings.listMappings();
  }

  @CanCapability('finance_write')
  @Post('bank-import-mappings')
  async saveMapping(
    @Body() dto: SaveBankImportMappingDto
  ): Promise<BankImportMappingItem> {
    return this.mappings.saveMapping(dto);
  }

  /* ---------- 银行流水 ---------- */

  /** 匹配率统计（验收标准：自动匹配率 > 60%） */
  @CanCapability('finance')
  @Get('bank-statements/match-stat')
  async matchStatistic(
    @Query('bankAccountId') bankAccountId?: string,
    @Query('period') period?: string
  ): Promise<BankStatementMatchStat> {
    return this.statements.matchStatistic({
      bankAccountId: bankAccountId || undefined,
      period: period || undefined,
    });
  }

  /** C-02 未匹配流水清单（人工核对入口） */
  @CanCapability('finance')
  @Get('bank-statements/unmatched')
  async listUnmatched(
    @Query('bankAccountId') bankAccountId?: string,
    @Query('period') period?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string
  ): Promise<PagedResult<BankStatementItem>> {
    return this.statements.listUnmatched({
      bankAccountId: bankAccountId || undefined,
      period: period || undefined,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
    });
  }

  @CanCapability('finance')
  @Get('bank-statements')
  async listStatements(
    @Query('bankAccountId') bankAccountId?: string,
    @Query('period') period?: string,
    @Query('matchStatus') matchStatus?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string
  ): Promise<PagedResult<BankStatementItem>> {
    return this.statements.listStatements({
      bankAccountId: bankAccountId || undefined,
      period: period || undefined,
      matchStatus: (matchStatus as BankStatementMatchStatus) || undefined,
      page: page ? Number(page) : 1,
      pageSize: pageSize ? Number(pageSize) : 20,
    });
  }

  @CanCapability('finance')
  @Get('bank-statements/:id')
  async getStatement(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<BankStatementItem> {
    return this.statements.getStatement(id);
  }

  /** Excel/CSV 解析导入（exceljs / 自实现 CSV 解析），按交易流水号去重 */
  @CanCapability('finance_write')
  @Post('bank-statements/import')
  @UseInterceptors(FileInterceptor('file'))
  async importStatements(
    @UploadedFile() file: UploadedFileLike | undefined,
    @Body() dto: ImportBankStatementDto
  ): Promise<BankStatementImportResult> {
    if (!file) throw new BadRequestException('请上传银行流水文件（.xlsx / .csv）');
    return this.statements.importStatements({
      bankAccountId: dto.bankAccountId,
      file,
      mapping: parseBankStatementMapping(dto.mapping),
      remark: dto.remark,
      autoMatch: dto.autoMatch !== 'false',
    });
  }

  /** 对未匹配流水重新执行自动匹配 */
  @CanCapability('finance_write')
  @Post('bank-statements/auto-match')
  async autoMatch(@Body() dto: AutoMatchBankStatementDto): Promise<AutoMatchResult> {
    return this.statements.autoMatch({
      bankAccountId: dto.bankAccountId,
      period: dto.period,
      limit: dto.limit,
    });
  }

  /** 人工关联：同一流水重复关联同一单据返回 409 */
  @CanCapability('finance_write')
  @Post('bank-statements/:id/match')
  async manualMatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ManualMatchBankStatementDto,
    @Req() req: Request
  ): Promise<BankStatementItem> {
    return this.statements.manualMatch(id, dto, actorFromRequest(req).userId);
  }

  /** 取消关联（幂等：本无匹配也返回当前流水） */
  @CanCapability('finance_write')
  @Post('bank-statements/:id/unmatch')
  async unmatch(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UnmatchBankStatementDto,
    @Req() req: Request
  ): Promise<BankStatementItem> {
    return this.statements.unmatch(id, dto.remark, actorFromRequest(req).userId);
  }

  /** 标记忽略（幂等，用于手续费等无需匹配的行） */
  @CanCapability('finance_write')
  @Post('bank-statements/:id/ignore')
  async ignore(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UnmatchBankStatementDto,
    @Req() req: Request
  ): Promise<BankStatementItem> {
    return this.statements.ignore(id, dto.remark, actorFromRequest(req).userId);
  }

  /* ---------- C-03 银企对账 ---------- */

  /** 银行存款余额调节表；checks 内含 passed 与 difference，左右恒等断言 */
  @CanCapability('finance')
  @Get('bank-reconciliation')
  async getReconciliation(
    @Query('bankAccountId') bankAccountId?: string,
    @Query('period') period?: string,
    @Query('bankBalance') bankBalance?: string
  ): Promise<BankReconciliationReport> {
    if (!period || !PERIOD_PATTERN.test(period)) {
      throw new BadRequestException('period 必填且格式必须为 YYYY-MM');
    }
    const manual =
      bankBalance === undefined || bankBalance === '' ? null : Number(bankBalance);
    if (manual !== null && !Number.isFinite(manual)) {
      throw new BadRequestException('bankBalance 必须为数字');
    }
    return this.reconciliation.buildReport({
      bankAccountId: bankAccountId || undefined,
      period,
      manualBankBalance: manual,
    });
  }
}
