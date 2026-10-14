import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CanCapability, NeedLogin } from '@server/platform';
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
import type {
  AssetChangeAction,
  AssetChangeItem,
  AssetDepreciationItem,
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

export class CreateAssetChangeDto implements ICreateAssetChangeDto {
  @IsUUID()
  assetId!: string;

  @IsString()
  @IsIn(['receive', 'transfer', 'scrap'])
  changeType!: 'receive' | 'transfer' | 'scrap';

  @IsOptional()
  @IsString()
  afterValue?: string;

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

@NeedLogin()
@Controller('api/asset')
export class AssetController {
  constructor(
    private readonly assetService: AssetService,
    private readonly assetDepreciationService: AssetDepreciationService
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
}
