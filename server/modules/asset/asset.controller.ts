import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { CanCapability, NeedLogin } from '@server/platform';
import type { Request } from 'express';
import { actorFromRequest } from '@server/common/auth/actor';
import {
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
} from 'class-validator';
import { AssetService } from './asset.service';
import { AssetDepreciationService } from './asset-depreciation.service';
import { AssetLifecycleService } from './asset-lifecycle.service';
import type {
  AssetChangeAction,
  AssetChangeItem,
  AssetDepreciationItem,
  AssetDisposalItem,
  AssetDisposalPreview,
  AssetImpairmentItem,
  AssetLifecycleResult,
  CreateAssetDisposalDto as ICreateAssetDisposalDto,
  CreateAssetImpairmentDto as ICreateAssetImpairmentDto,
  DisposalAction,
  ImpairmentTestPreview,
  AssetItem,
  AssetOverview,
  CreateAssetChangeDto as ICreateAssetChangeDto,
  CreateAssetDto as ICreateAssetDto,
  DepreciatePeriodDto as IDepreciatePeriodDto,
  DepreciateResult,
  PagedResult,
} from '@shared/api.interface';

export class CreateAssetDto implements ICreateAssetDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsString()
  @IsIn(['server_gpu', 'office', 'other'])
  category!: 'server_gpu' | 'office' | 'other';

  @IsNumber()
  @Min(0)
  originalValue!: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  residualValue?: number;

  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsUUID()
  taxEntityId?: string;

  @IsOptional()
  @IsDateString()
  purchaseDate?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  usefulMonths?: number;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class SetAssetTaxEntityDto {
  @IsUUID()
  taxEntityId!: string;
}

export class CreateAssetChangeDto implements ICreateAssetChangeDto {
  @IsUUID()
  assetId!: string;

  @IsString()
  @IsIn(['receive', 'transfer', 'scrap'])
  changeType!: 'receive' | 'transfer' | 'scrap';

  @IsOptional()
  @IsString()
  afterValue?: string;

  /**
   * D-08：转交目标（结构化）。`changeType='transfer'` 时**至少填一个**，
   * 否则审批通过后归属不会变化（服务层会直接拒绝，避免"看起来成功"）。
   */
  @IsOptional()
  @IsUUID()
  targetDepartmentId?: string;

  @IsOptional()
  @IsUUID()
  targetProjectId?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class DepreciatePeriodDto implements IDepreciatePeriodDto {
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: '期间格式必须为 YYYY-MM',
  })
  period!: string;
}

/* ========== D-08：减值与处置（class DTO 必须定义在 controller 之前） ========== */

/** 减值测试计提入参 */
export class CreateAssetImpairmentDto implements ICreateAssetImpairmentDto {
  @IsUUID()
  assetId!: string;

  @IsDateString()
  testDate!: string;

  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: '期间格式必须为 YYYY-MM' })
  period!: string;

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  recoverableAmount!: number;

  @IsOptional()
  @IsString()
  method?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

/** 处置申请入参 */
export class CreateAssetDisposalDto implements ICreateAssetDisposalDto {
  @IsUUID()
  assetId!: string;

  @IsIn(['sale', 'scrap', 'donate'], {
    message: '处置方式仅支持 sale / scrap / donate',
  })
  disposalType!: 'sale' | 'scrap' | 'donate';

  @IsDateString()
  applyDate!: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  disposalIncome?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  taxRate?: number;

  @IsOptional()
  @IsString()
  reason?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

@NeedLogin()
@Controller('api/asset')
export class AssetController {
  constructor(
    private readonly assetService: AssetService,
    private readonly assetDepreciationService: AssetDepreciationService,
    private readonly assetLifecycleService: AssetLifecycleService
  ) {}

  @Get('assets')
  async listAssets(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('category') category?: string,
    @Query('projectId') projectId?: string
  ): Promise<PagedResult<AssetItem>> {
    return this.assetService.listAssets({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      status,
      category,
      projectId,
    });
  }

  @CanCapability('pur_asset')
  @Post('assets')
  async createAsset(@Body() dto: CreateAssetDto): Promise<AssetItem> {
    return this.assetService.createAsset(dto);
  }

  @CanCapability('pur_asset')
  @Patch('assets/:id/tax-entity')
  async setAssetTaxEntity(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetAssetTaxEntityDto,
  ): Promise<AssetItem> {
    return this.assetService.setAssetTaxEntity(id, dto.taxEntityId);
  }

  @Get('changes')
  async listChanges(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string
  ): Promise<PagedResult<AssetChangeItem>> {
    return this.assetService.listChanges({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      status,
    });
  }

  @CanCapability('self_service')
  @Post('changes')
  async createChange(
    @Body() dto: CreateAssetChangeDto
  ): Promise<AssetChangeItem> {
    return this.assetService.createChange(dto);
  }

  @CanCapability('pur_asset')
  @Post('changes/:id/actions/:action')
  async changeAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('action') action: string
  ): Promise<AssetChangeItem> {
    if (action !== 'approve' && action !== 'reject') {
      throw new BadRequestException('不支持的操作，仅允许 approve / reject');
    }
    return this.assetService.changeAction(id, action as AssetChangeAction);
  }

  @Get('depreciations')
  async listDepreciations(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('period') period?: string,
    @Query('assetId') assetId?: string
  ): Promise<PagedResult<AssetDepreciationItem>> {
    return this.assetDepreciationService.listDepreciations({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      period,
      assetId,
    });
  }

  @CanCapability('pur_asset')
  @Post('depreciate')
  async depreciate(
    @Body() dto: DepreciatePeriodDto
  ): Promise<DepreciateResult> {
    return this.assetDepreciationService.depreciate(dto);
  }

  @Get('overview')
  async getOverview(): Promise<AssetOverview> {
    return this.assetService.getOverview();
  }

  /* ========== D-08 资产全生命周期 ========== */

  /** 完整生命周期时间线（建卡 / 变更 / 折旧 / 减值 / 处置） */
  @Get('assets/:id/lifecycle')
  async lifecycle(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<AssetLifecycleResult> {
    return this.assetLifecycleService.lifecycle(id);
  }

  /** 资产归属与保管人 */
  @Get('assets/:id/ownership')
  async ownership(@Param('id', ParseUUIDPipe) id: string) {
    return this.assetLifecycleService.ownership(id);
  }

  /** 减值测试预览（不落库，用于前端确认后提交） */
  @Get('impairment-test')
  async impairmentTest(
    @Query('assetId', ParseUUIDPipe) assetId: string,
    @Query('recoverableAmount') recoverableAmount: string
  ): Promise<ImpairmentTestPreview> {
    if (!assetId) throw new BadRequestException('assetId 必填');
    const amount = Number(recoverableAmount);
    if (!Number.isFinite(amount)) {
      throw new BadRequestException('recoverableAmount 必填且必须为数值');
    }
    return this.assetLifecycleService.previewImpairmentTest({
      assetId,
      recoverableAmount: amount,
    });
  }

  @Get('impairments')
  async listImpairments(
    @Query('assetId') assetId?: string,
    @Query('period') period?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string
  ) {
    return this.assetLifecycleService.listImpairments({
      assetId,
      period,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @CanCapability('pur_asset')
  @Post('impairments')
  async createImpairment(
    @Req() req: Request,
    @Body() dto: CreateAssetImpairmentDto
  ): Promise<AssetImpairmentItem> {
    return this.assetLifecycleService.createImpairment(
      dto,
      actorFromRequest(req).userId
    );
  }

  @CanCapability('pur_asset')
  @Post('impairments/:id/delete')
  async deleteImpairment(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<{ ok: true }> {
    return this.assetLifecycleService.deleteImpairment(
      id,
      actorFromRequest(req).userId
    );
  }

  /** 处置预览（给出净值、销项税、预计损益与将生成的分录） */
  @Get('disposal-preview')
  async disposalPreview(
    @Query('assetId', ParseUUIDPipe) assetId: string,
    @Query('disposalType') disposalType: string,
    @Query('disposalIncome') disposalIncome?: string,
    @Query('taxRate') taxRate?: string
  ): Promise<AssetDisposalPreview> {
    if (!assetId) throw new BadRequestException('assetId 必填');
    if (!['sale', 'scrap', 'donate'].includes(disposalType)) {
      throw new BadRequestException('disposalType 仅支持 sale / scrap / donate');
    }
    return this.assetLifecycleService.previewDisposal({
      assetId,
      disposalType: disposalType as 'sale' | 'scrap' | 'donate',
      disposalIncome: disposalIncome ? Number(disposalIncome) : undefined,
      taxRate: taxRate ? Number(taxRate) : undefined,
    });
  }

  @Get('disposals')
  async listDisposals(
    @Query('assetId') assetId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string
  ) {
    return this.assetLifecycleService.listDisposals({
      assetId,
      status,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @CanCapability('pur_asset')
  @Post('disposals')
  async createDisposal(
    @Req() req: Request,
    @Body() dto: CreateAssetDisposalDto
  ): Promise<AssetDisposalItem> {
    return this.assetLifecycleService.createDisposal(
      dto,
      actorFromRequest(req).userId
    );
  }

  @CanCapability('pur_asset')
  @Post('disposals/:id/actions/:action')
  async disposalAction(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('action') action: string
  ): Promise<AssetDisposalItem> {
    if (action !== 'complete' && action !== 'reject') {
      throw new BadRequestException('不支持的操作，仅允许 complete / reject');
    }
    return this.assetLifecycleService.disposalAction(
      id,
      action as DisposalAction,
      actorFromRequest(req).userId
    );
  }
}
