import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { CanCapability, NeedLogin } from '@server/platform';
import type { Request } from 'express';
import {
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ReportsService } from './reports.service';
import { LedgersService } from './ledgers.service';
import { YearEndService } from './year-end.service';
import { VatDeclarationService } from './vat-declaration.service';
import { AuxiliaryService } from './auxiliary.service';
import type {
  CreateAuxDimensionDto as ICreateAuxDimensionDto,
  ToggleAuxDimensionDto as IToggleAuxDimensionDto,
} from '@shared/api.interface';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 反年结入参：必须携带审批确认与原因（A-04 留痕要求） */
export class ReverseYearEndDto {
  @IsOptional()
  @IsString()
  taxEntityId?: string;

  @IsString()
  reason!: string;

  @IsBoolean()
  approved!: boolean;
}

/** 结转损益入参 */
export class CarryForwardDto {
  @Matches(PERIOD_PATTERN, { message: '期间格式必须为 YYYY-MM' })
  period!: string;

  @IsOptional()
  @IsUUID()
  taxEntityId?: string;
}

/** 确认增值税申报底稿 */
export class ConfirmVatDto {
  @Matches(PERIOD_PATTERN, { message: '期间格式必须为 YYYY-MM' })
  period!: string;

  @IsOptional()
  @IsUUID()
  taxEntityId?: string;

  @IsOptional()
  @IsString()
  differenceReason?: string;
}

const REPORT_CODES = ['balance_sheet', 'income_statement', 'cash_flow'] as const;
type ReportCodeParam = (typeof REPORT_CODES)[number];

/** A-05：辅助核算维度创建入参（class DTO，必须定义在 controller 之前） */
export class CreateAuxDimensionBodyDto implements ICreateAuxDimensionDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,31}$/, {
    message: '维度编码必须为小写字母开头、仅含小写字母/数字/下划线，长度 2~32',
  })
  code!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  name!: string;

  @IsOptional()
  @IsIn(['department', 'project', 'customer', 'supplier', 'employee', 'custom'])
  sourceType?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  remark?: string;
}

/** A-05：辅助核算维度启停入参 */
export class ToggleAuxDimensionBodyDto implements IToggleAuxDimensionDto {
  @IsBoolean()
  enabled!: boolean;
}

@NeedLogin()
@Controller('api/finance')
export class FinanceReportsController {
  constructor(
    private readonly reportsService: ReportsService,
    private readonly ledgersService: LedgersService,
    private readonly yearEndService: YearEndService,
    private readonly vatService: VatDeclarationService,
    private readonly auxiliaryService: AuxiliaryService,
  ) {}

  private assertPeriod(period: string | undefined): string {
    if (!period || !PERIOD_PATTERN.test(period)) {
      throw new BadRequestException('period 必填且格式为 YYYY-MM');
    }
    return period;
  }

  /* ========== A-01 / A-02 法定财务报表 ========== */

  @CanCapability('finance')
  @Get('reports/balance-sheet')
  getBalanceSheet(
    @Query('period') period?: string,
    @Query('taxEntityId') taxEntityId?: string,
  ) {
    return this.reportsService.balanceSheet({
      period: this.assertPeriod(period),
      taxEntityId: taxEntityId || undefined,
    });
  }

  @CanCapability('finance')
  @Get('reports/income-statement')
  getIncomeStatement(
    @Query('period') period?: string,
    @Query('taxEntityId') taxEntityId?: string,
  ) {
    return this.reportsService.incomeStatement({
      period: this.assertPeriod(period),
      taxEntityId: taxEntityId || undefined,
    });
  }

  @CanCapability('finance')
  @Get('reports/cash-flow')
  getCashFlow(
    @Query('period') period?: string,
    @Query('taxEntityId') taxEntityId?: string,
  ) {
    return this.reportsService.cashFlow({
      period: this.assertPeriod(period),
      taxEntityId: taxEntityId || undefined,
    });
  }

  /**
   * 统一入口：前端 Tab 切换时只换 reportCode，无需分辨三套接口。
   * 注意路由顺序——必须排在 `reports/templates/:reportCode` 之前，
   * 否则 `templates` 会被当作 reportCode 匹配（Nest 按注册顺序匹配）。
   */
  @CanCapability('finance')
  @Get('reports/:reportCode')
  getReport(
    @Param('reportCode') reportCode: string,
    @Query('period') period?: string,
    @Query('taxEntityId') taxEntityId?: string,
  ) {
    if (!REPORT_CODES.includes(reportCode as ReportCodeParam)) {
      throw new BadRequestException(
        `不支持的报表编码：${reportCode}（可选 ${REPORT_CODES.join(' / ')}）`
      );
    }
    return this.reportsService.getReport(reportCode as ReportCodeParam, {
      period: this.assertPeriod(period),
      taxEntityId: taxEntityId || undefined,
    });
  }

  /** 报表模板（口径评审与前端分组小标题用） */
  @CanCapability('finance')
  @Get('reports/templates/:reportCode')
  listTemplates(@Param('reportCode') reportCode: string) {
    return this.reportsService.listTemplates(reportCode);
  }

  /**
   * A-12 / C-06：报表打印数据包（抬头/Logo/签章位/金额大写）。
   *
   * 打印本身走纯前端（react-to-print + @media print），后端只提供数据包，
   * 避免引入服务端渲染 PDF 的运维成本（需求书 §2.1 A-12 需求细化①）。
   */
  @CanCapability('finance')
  @Get('reports/:reportCode/print')
  getReportPrintPack(
    @Param('reportCode') reportCode: string,
    @Req() req: Request,
    @Query('period') period?: string,
    @Query('taxEntityId') taxEntityId?: string,
  ) {
    if (!REPORT_CODES.includes(reportCode as ReportCodeParam)) {
      throw new BadRequestException(
        `不支持的报表编码：${reportCode}（可选 ${REPORT_CODES.join(' / ')}）`
      );
    }
    return this.reportsService.printPack(reportCode as ReportCodeParam, {
      period: this.assertPeriod(period),
      taxEntityId: taxEntityId || undefined,
      operator: req.userContext?.userName ?? req.userContext?.userId ?? null,
    });
  }

  /* ========== A-03 账簿 ========== */

  @CanCapability('finance')
  @Get('ledgers/account-balance')
  getAccountBalance(
    @Query('period') period?: string,
    @Query('level') level?: string,
    @Query('taxEntityId') taxEntityId?: string,
  ) {
    return this.ledgersService.accountBalance({
      period: this.assertPeriod(period),
      level: level ? Math.min(Math.max(Number(level) || 6, 1), 6) : undefined,
      taxEntityId: taxEntityId || undefined,
    });
  }

  @CanCapability('finance')
  @Get('ledgers/general')
  getGeneralLedger(
    @Query('period') period?: string,
    @Query('taxEntityId') taxEntityId?: string,
  ) {
    return this.ledgersService.generalLedger({
      period: this.assertPeriod(period),
      taxEntityId: taxEntityId || undefined,
    });
  }

  @CanCapability('finance')
  @Get('ledgers/detail')
  getDetailLedger(
    @Query('accountCode') accountCode?: string,
    @Query('period') period?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('taxEntityId') taxEntityId?: string,
    @Query('includeChildren') includeChildren?: string,
  ) {
    if (!accountCode) {
      throw new BadRequestException('accountCode 必填');
    }
    return this.ledgersService.detailLedger({
      accountCode,
      period: this.assertPeriod(period),
      page: Math.max(1, Number(page) || 1),
      pageSize: Math.min(Math.max(Number(pageSize) || 50, 1), 500),
      taxEntityId: taxEntityId || undefined,
      includeChildren: includeChildren === 'true',
    });
  }

  @CanCapability('finance')
  @Get('ledgers/aux-balance')
  getAuxBalance(
    @Query('period') period?: string,
    @Query('dimension') dimension?: string,
    @Query('dimensionId') dimensionId?: string,
    @Query('taxEntityId') taxEntityId?: string,
  ) {
    if (!dimension) {
      throw new BadRequestException('dimension 必填（如 project / department）');
    }
    return this.ledgersService.auxBalance({
      period: this.assertPeriod(period),
      dimensionCode: dimension,
      dimensionId: dimensionId || undefined,
      taxEntityId: taxEntityId || undefined,
    });
  }

  @CanCapability('finance')
  @Get('ledgers/aux-dimensions')
  listAuxDimensions() {
    return this.auxiliaryService.listDimensions();
  }

  @CanCapability('finance')
  @Get('ledgers/trial-balance')
  getTrialBalance(@Query('period') period?: string) {
    return this.ledgersService.trialBalance(this.assertPeriod(period));
  }

  /* ========== A-04 期末结转损益与年结 ========== */

  @CanCapability('finance')
  @Get('year-end/preview')
  previewCarryForward(
    @Query('period') period?: string,
    @Query('taxEntityId') taxEntityId?: string,
  ) {
    return this.yearEndService.previewCarryForward({
      period: this.assertPeriod(period),
      taxEntityId: taxEntityId || undefined,
    });
  }

  @CanCapability('finance_write')
  @Post('year-end/carry-forward')
  carryForward(@Body() body: CarryForwardDto, @Req() req: Request) {
    const userId = req.userContext?.userId ?? 'anonymous';
    return this.yearEndService.carryForward({
      period: body.period,
      taxEntityId: body.taxEntityId || undefined,
      userId,
    });
  }

  @CanCapability('finance_write')
  @Post('year-end/:fiscalYear/reverse')
  reverseYearEnd(
    @Param('fiscalYear') fiscalYear: string,
    @Body() dto: ReverseYearEndDto,
    @Req() req: Request,
  ) {
    const year = Number(fiscalYear);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new BadRequestException('fiscalYear 必须为 2000~2100 之间的整数');
    }
    const userId = req.userContext?.userId ?? 'anonymous';
    return this.yearEndService.reverseYearEnd({
      fiscalYear: year,
      taxEntityId: dto.taxEntityId || undefined,
      userId,
      reason: dto.reason,
      approved: dto.approved === true,
    });
  }

  @CanCapability('finance')
  @Get('year-end/status')
  yearEndStatus(@Query('taxEntityId') taxEntityId?: string) {
    return this.yearEndService.listStatus(taxEntityId || undefined);
  }

  @CanCapability('finance')
  @Get('year-end/log')
  yearEndLog(@Query('fiscalYear') fiscalYear?: string) {
    const year = fiscalYear ? Number(fiscalYear) : undefined;
    return this.yearEndService.listLog(year);
  }

  /* ========== A-06 增值税申报底稿 ========== */

  @CanCapability('finance')
  @Get('tax-declaration')
  getVatDeclaration(
    @Query('period') period?: string,
    @Query('taxEntityId') taxEntityId?: string,
  ) {
    return this.vatService.generate({
      period: this.assertPeriod(period),
      taxEntityId: taxEntityId || undefined,
    });
  }

  @CanCapability('finance_write')
  @Post('tax-declaration/confirm')
  confirmVatDeclaration(@Body() dto: ConfirmVatDto, @Req() req: Request) {
    const userId = req.userContext?.userId ?? 'anonymous';
    return this.vatService.confirm(dto, userId);
  }

  @CanCapability('finance')
  @Get('tax-declaration/list')
  listVatDeclarations(@Query('limit') limit?: string) {
    return this.vatService.list(
      Math.min(Math.max(Number(limit) || 24, 1), 120)
    );
  }

  /* ========== A-05 辅助核算维度维护 ========== */

  @CanCapability('finance_write')
  @Post('ledgers/aux-dimensions')
  createAuxDimension(@Body() body: CreateAuxDimensionBodyDto) {
    return this.auxiliaryService.createDimension(body);
  }

  @CanCapability('finance_write')
  @Post('ledgers/aux-dimensions/:code/enabled')
  toggleAuxDimension(
    @Param('code') code: string,
    @Body() body: ToggleAuxDimensionBodyDto,
  ) {
    return this.auxiliaryService.setEnabled(code, body.enabled);
  }
}
