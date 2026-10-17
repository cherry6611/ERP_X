import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CanCapability, NeedLogin } from '@server/platform';
import { actorFromRequest } from '@server/common/auth/actor';
import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  ValidateIf,
} from 'class-validator';
import { DataAssetService } from './data-asset.service';
import type {
  CreateDatasetDto as ICreateDatasetDto,
  CreateGrantDto as ICreateGrantDto,
  DatasetFieldItem,
  DatasetItem,
  GrantItem,
  GrantRevokeLogItem,
  GrantRevokeReason,
  GrantWarningItem,
  MaskLevelOption,
  MaskPreviewResult,
  PagedResult,
  RevokeGrantDto as IRevokeGrantDto,
  RevokeGrantResult,
  SensitiveFieldKind,
  UpdateDatasetDto as IUpdateDatasetDto,
  UpsertDatasetFieldDto as IUpsertDatasetFieldDto,
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

  /*
   * 关联合同（PATCH 三态）：UUID 换绑 / null 解除关联 / 不传则不动。
   *
   * `@IsOptional()` 让 `undefined` 与 `null` 都短路放行（class-validator 把二者
   * 一同视为"未提供"），`@ValidateIf` 再把 `null` 显式排除，于是**非 null 即必须
   * 是合法 UUID** —— 与 `master-data.dto.ts#UpdateCustomerDto.taxEntityId`、
   * `tax-entity.dto.ts` 的既有写法逐字一致。
   */
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsUUID()
  contractId?: string | null;

  /*
   * ⚠️ `@IsOptional()` 是**必须**的（本轮修复的连带缺陷）。
   *
   * 原先这里只有 `@IsString() @IsIn([...])`：Nest 的 `ValidationPipe` 没开
   * `skipMissingProperties`，而 class-validator 在没有 `@IsOptional()` 时
   * **会拿 `undefined` 去过校验器** —— 于是「不带 status 的 PATCH」一律 400。
   *
   * 而前端编辑弹窗的 payload 里**从来没有 status**（状态流转走
   * `POST datasets/:id/actions/:action`），结果是「编辑数据集」保存必定失败，
   * 本轮的「关联合同可改」也会被同一道闸门挡掉。
   */
  @IsOptional()
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

/* ========== C-13：脱敏字段登记与授权回收（class 必须在 controller 之前） ========== */

/** 脱敏字段登记入参：列名 + 字段语义 */
export class UpsertDatasetFieldDto implements IUpsertDatasetFieldDto {
  @IsString()
  @IsNotEmpty()
  columnName!: string;

  @IsIn([
    'name',
    'phone',
    'email',
    'id_card',
    'bank_account',
    'address',
    'amount',
    'location',
    'other',
  ], { message: '字段语义不合法' })
  fieldKind!: SensitiveFieldKind;

  @IsOptional()
  @IsString()
  fieldLabel?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

/** 授权回收入参：L4 需 reviewedBy + destructionProof（双人确认 + 销毁凭证） */
export class RevokeGrantDto implements IRevokeGrantDto {
  @IsIn(['expired', 'manual', 'contract_terminated', 'violation', 'project_closed'], {
    message: '回收原因不合法',
  })
  reason!: GrantRevokeReason;

  @IsOptional()
  @IsString()
  reviewedBy?: string;

  @IsOptional()
  @IsString()
  destructionProof?: string;

  @IsOptional()
  @IsString()
  remark?: string;
}

/** 脱敏预览入参：一行样例数据 */
export class PreviewMaskingDto {
  /** 样例行（列名 → 值）；用 record 而非内联类型，让前端可自由传样例 */
  sample!: Record<string, unknown>;
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

  @CanCapability('data_asset')
  @Post('datasets')
  async createDataset(
    @Body() dto: CreateDatasetDto
  ): Promise<DatasetItem> {
    return this.dataAssetService.createDataset(dto);
  }

  @CanCapability('data_asset')
  @Patch('datasets/:id')
  async updateDataset(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDatasetDto
  ): Promise<DatasetItem> {
    return this.dataAssetService.updateDataset(id, dto);
  }

  @CanCapability('data_asset')
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

  @CanCapability('data_asset')
  @Post('grants')
  async createGrant(@Body() dto: CreateGrantDto): Promise<GrantItem> {
    return this.dataAssetService.createGrant(dto);
  }

  @CanCapability('data_asset')
  @Post('grants/:id/actions/expire')
  async expireGrant(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<GrantItem> {
    return this.dataAssetService.expireGrant(id);
  }

  /* ========== C-13 授权回收审计 ========== */

  /**
   * 人工回收授权（留痕）。到期失效走 `actions/expire`（系统行为，无需复核）。
   * L4 核心数据必须双人确认 + 销毁凭证，否则 400。
   */
  @CanCapability('data_asset')
  @Post('grants/:id/actions/revoke')
  async revokeGrant(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RevokeGrantDto
  ): Promise<RevokeGrantResult> {
    return this.dataAssetService.revokeGrant(
      id,
      dto,
      actorFromRequest(req).userId
    );
  }

  @Get('grant-revoke-logs')
  async listRevokeLogs(
    @Query('grantId') grantId?: string,
    @Query('datasetId') datasetId?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string
  ): Promise<PagedResult<GrantRevokeLogItem>> {
    return this.dataAssetService.listRevokeLogs({
      grantId,
      datasetId,
      page: parsePage(page),
      pageSize: parsePageSize(pageSize),
    });
  }

  /* ========== C-13 脱敏字段登记与预览 ========== */

  /** 脱敏等级字典（前端下拉；L4 会标注需要销毁凭证） */
  @Get('mask-levels')
  listMaskLevels(): MaskLevelOption[] {
    return this.dataAssetService.listMaskLevels();
  }

  @Get('datasets/:id/fields')
  async listDatasetFields(
    @Param('id', ParseUUIDPipe) id: string
  ): Promise<DatasetFieldItem[]> {
    return this.dataAssetService.listDatasetFields(id);
  }

  @CanCapability('data_asset')
  @Post('datasets/:id/fields')
  async upsertDatasetField(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpsertDatasetFieldDto
  ): Promise<DatasetFieldItem> {
    return this.dataAssetService.upsertDatasetField(id, dto);
  }

  @CanCapability('data_asset')
  @Post('datasets/:id/fields/:columnName/delete')
  async deleteDatasetField(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('columnName') columnName: string
  ): Promise<{ ok: true }> {
    return this.dataAssetService.deleteDatasetField(id, columnName);
  }

  /** 脱敏预览：导出前先看一行样例会变成什么样 */
  @Post('datasets/:id/mask-preview')
  async previewMasking(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PreviewMaskingDto
  ): Promise<MaskPreviewResult> {
    return this.dataAssetService.previewMasking(id, dto.sample ?? {});
  }

  /* ========== 到期预警 ========== */

  @Get('grant-warnings')
  async listGrantWarnings(): Promise<GrantWarningItem[]> {
    return this.dataAssetService.listGrantWarnings();
  }
}
