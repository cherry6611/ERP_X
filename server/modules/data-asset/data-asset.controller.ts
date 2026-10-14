import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CanCapability, NeedLogin } from '@server/platform';
import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
} from 'class-validator';
import { DataAssetService } from './data-asset.service';
import type {
  CreateDatasetDto as ICreateDatasetDto,
  CreateGrantDto as ICreateGrantDto,
  DatasetItem,
  GrantItem,
  GrantWarningItem,
  PagedResult,
  UpdateDatasetDto as IUpdateDatasetDto,
} from '@shared/api.interface';

export class CreateDatasetDto implements ICreateDatasetDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsString()
  maskLevel?: string;

  @IsOptional()
  @IsUUID()
  contractId?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

export class UpdateDatasetDto implements IUpdateDatasetDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsString()
  source?: string;

  @IsOptional()
  @IsString()
  maskLevel?: string;

  @IsString()
  @IsIn(['active', 'offline'])
  status?: 'active' | 'offline';

  @IsOptional()
  @IsString()
  remark?: string;
}

export class CreateGrantDto implements ICreateGrantDto {
  @IsUUID()
  datasetId!: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsString()
  scope?: string;

  @IsDateString()
  startDate!: string;

  @IsDateString()
  endDate!: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

function parsePage(page?: string): number {
  const parsed = Number(page ?? '1');
  return Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : 1;
}

function parsePageSize(pageSize?: string): number {
  const parsed = Number(pageSize ?? '20');
  if (!Number.isFinite(parsed)) return 20;
  return Math.min(100, Math.max(1, Math.floor(parsed)));
}

@NeedLogin()
@Controller('api/data-asset')
export class DataAssetController {
  constructor(private readonly dataAssetService: DataAssetService) {}

  /* ========== 数据集目录 ========== */

  @Get('datasets')
  async listDatasets(
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string
  ): Promise<PagedResult<DatasetItem>> {
    return this.dataAssetService.listDatasets(
      status,
      parsePage(page),
      parsePageSize(pageSize)
    );
  }

  @CanCapability('audit')
  @Post('datasets')
  async createDataset(
    @Body() dto: CreateDatasetDto
  ): Promise<DatasetItem> {
    return this.dataAssetService.createDataset(dto);
  }

  @CanCapability('audit')
  @Patch('datasets/:id')
  async updateDataset(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDatasetDto
  ): Promise<DatasetItem> {
    return this.dataAssetService.updateDataset(id, dto);
  }

  @CanCapability('audit')
  @Post('datasets/:id/actions/:action')
  async datasetAction(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('action') action: 'offline' | 'activate'
  ): Promise<DatasetItem> {
    return this.dataAssetService.datasetAction(id, action);
  }

  /* ========== 授权记录 ========== */

  @Get('grants')
  async listGrants(
    @Query('datasetId') datasetId?: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string
  ): Promise<PagedResult<GrantItem>> {
    return this.dataAssetService.listGrants(
      datasetId,
      status,
      parsePage(page),
      parsePageSize(pageSize)
    );
  }

  @CanCapability('audit')
  @Post('grants')
  async createGrant(@Body() dto: CreateGrantDto): Promise<GrantItem> {
    return this.dataAssetService.createGrant(dto);
  }

  @CanCapability('audit')
  @Post('grants/:id/actions/expire')
  async expireGrant(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<GrantItem> {
    return this.dataAssetService.expireGrant(id);
  }

  /* ========== 到期预警 ========== */

  @Get('grant-warnings')
  async listGrantWarnings(): Promise<GrantWarningItem[]> {
    return this.dataAssetService.listGrantWarnings();
  }
}
