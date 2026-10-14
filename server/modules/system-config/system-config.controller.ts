import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { CanCapability, NeedLogin, Public } from '@server/platform';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { ROLE_CODES, type RoleCode } from '@shared/rbac';
import type {
  DataScopeResource,
  DataScopeType,
} from '@shared/api.interface';
import { DictService } from './dict.service';
import {
  DATA_SCOPE_RESOURCES,
  DATA_SCOPE_TYPES,
  DataScopeService,
} from '@server/common/auth/data-scope.service';
import {
  SystemConfigService,
  type DatePattern,
  type ResetPolicy,
} from './system-config.service';

/** B-03：字典项新增/更新 */
class UpsertDictDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,63}$/, {
    message: 'dictType 必须为小写字母开头、仅含小写字母/数字/下划线，长度 2~64',
  })
  dictType!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  dictKey!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  dictLabel!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  extra?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(9999)
  sortNo?: number;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  remark?: string;
}

/** B-03：参数更新 */
class UpdateParamDto {
  @IsString()
  @MaxLength(500)
  paramValue!: string;
}

/** B-08：编号规则新增/更新 */
class UpsertCodeRuleDto {
  @IsString()
  @Matches(/^[A-Z][A-Z0-9_]{1,39}$/, {
    message: 'bizType 必须为大写字母开头、仅含大写字母/数字/下划线，长度 2~40',
  })
  bizType!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  bizName?: string;

  @IsString()
  @Matches(/^[A-Z0-9]{1,16}$/, { message: 'prefix 必须为 1~16 位大写字母或数字' })
  prefix!: string;

  @IsOptional()
  @IsIn(['YYYYMM', 'YYYY', 'NONE'])
  datePattern?: DatePattern;

  @IsOptional()
  @IsInt()
  @Min(3)
  @Max(10)
  seqLength?: number;

  @IsOptional()
  @IsIn(['never', 'yearly', 'monthly'])
  resetPolicy?: ResetPolicy;

  @IsOptional()
  @IsBoolean()
  allowReuse?: boolean;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  remark?: string;
}

/** B-07：保留策略更新 */
class UpdateRetentionDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(36500)
  retainDays?: number;

  @IsOptional()
  @IsIn(['none', 'archive', 'delete'])
  action?: 'none' | 'archive' | 'delete';

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  remark?: string;
}

/**
 * B-02：数据级权限（行级可见范围）配置写入。
 *
 * `customIds` 只在 `scope='custom'` 时生效；为避免"配置成 custom 但没给 id → 用户什么都看不到"
 * 这类静默故障，这里不做业务兜底，而是由 service 把空数组原样落库，
 * 并在 `DataScopeService` 侧 fail-closed（返回空集 + warn 日志），行为可观测。
 */
class UpsertDataScopeDto {
  @IsString()
  @IsIn([...ROLE_CODES])
  roleCode!: RoleCode;

  @IsString()
  @IsIn([...DATA_SCOPE_RESOURCES])
  resourceType!: DataScopeResource;

  @IsString()
  @IsIn([...DATA_SCOPE_TYPES])
  scope!: DataScopeType;

  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true, message: 'customIds 必须为 UUID 列表' })
  customIds?: string[];

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  remark?: string;
}

/**
 * B-03 系统字典与参数 / B-08 编号规则 / B-07 数据保留策略。
 *
 * 权限：读写均要求 `admin`（字典与编号规则会影响全站行为，
 * 参照需求书 §7.2「GET/POST/PATCH /api/system/dictionary* → admin」）。
 * 例外：`GET /api/system/dictionary/options` 对所有登录用户开放，
 * 因为前端下拉需要字典标签（只返回启用项，不含 remark 等内部字段）。
 */
@NeedLogin()
@Controller('api/system')
export class SystemConfigController {
  constructor(
    private readonly service: SystemConfigService,
    private readonly dictService: DictService,
    private readonly dataScopeService: DataScopeService,
  ) {}

  /* ========== 字典 ========== */

  /** 前端下拉用的字典快照（登录即可读；只返回启用项） */
  @Get('dictionary/options')
  async dictionaryOptions(
    @Query('types') types?: string
  ) {
    const wanted = types
      ? types.split(',').map((item) => item.trim()).filter(Boolean)
      : null;
    const all = (await this.dictService.listAll(false)) as Array<{
      dictType: string;
      dictKey: string;
      dictLabel: string;
      extra: string | null;
      sortNo: number;
      enabled: boolean;
    }>;
    const result: Record<string, Array<{ key: string; label: string; extra: string | null }>> = {};
    for (const item of all) {
      if (!item.enabled) continue;
      if (wanted && !wanted.includes(item.dictType)) continue;
      result[item.dictType] = [
        ...(result[item.dictType] ?? []),
        { key: item.dictKey, label: item.dictLabel, extra: item.extra },
      ];
    }
    // 税率档位额外暴露数值数组，便于前端做算术校验
    const taxRates = await this.dictService.taxRates();
    return { dictionary: result, taxRates };
  }

  @CanCapability('admin_ops')
  @Get('dictionary')
  async listDictionary(@Query('dictType') dictType?: string) {
    return this.service.listDicts(dictType);
  }

  @CanCapability('admin_ops')
  @Post('dictionary')
  async upsertDictionary(@Body() dto: UpsertDictDto) {
    return this.service.upsertDict(dto);
  }

  @CanCapability('admin_ops')
  @Post('dictionary/:dictType/:dictKey/delete')
  async deleteDictionary(
    @Param('dictType') dictType: string,
    @Param('dictKey') dictKey: string
  ) {
    return this.service.deleteDict(dictType, dictKey);
  }

  /** 参数读取（登录即可读，设置页需要展示；仅 admin 可写） */
  @Get('params')
  async listParams() {
    return this.service.listParams();
  }

  @CanCapability('admin_ops')
  @Post('params/:paramKey')
  async updateParam(
    @Param('paramKey') paramKey: string,
    @Body() dto: UpdateParamDto
  ) {
    return this.service.updateParam(paramKey, dto.paramValue);
  }

  /* ========== B-08 编号规则 ========== */

  @CanCapability('admin_ops')
  @Get('code-rules')
  async listCodeRules() {
    return this.service.listCodeRules();
  }

  @CanCapability('admin_ops')
  @Post('code-rules')
  async upsertCodeRule(@Body() dto: UpsertCodeRuleDto) {
    return this.service.upsertCodeRule(dto);
  }

  /* ========== B-07 数据保留策略 ========== */

  @CanCapability('audit')
  @Get('retention-policies')
  async listRetention() {
    return this.service.listRetentionPolicies();
  }

  @CanCapability('admin_ops')
  @Post('retention-policies/:dataType')
  async updateRetention(
    @Param('dataType') dataType: string,
    @Body() dto: UpdateRetentionDto
  ) {
    return this.service.updateRetentionPolicy(dataType, dto);
  }

  /* ========== B-02 数据级权限（行级可见范围）配置 ========== */

  /**
   * 角色 × 资源类型 → 可见范围。
   *
   * 与字典/参数的取舍不同：数据权限配置本身是**权限信息**，
   * 不能让普通登录用户读到（能读到就能推断出别人的可见范围），故读也要求 `admin_ops`。
   */
  @CanCapability('admin_ops')
  @Get('data-scopes')
  async listDataScopes() {
    return this.dataScopeService.listConfigs();
  }

  @CanCapability('admin_ops')
  @Post('data-scopes')
  async upsertDataScope(@Body() dto: UpsertDataScopeDto) {
    const result = await this.dataScopeService.upsertConfig(dto);
    // 部门缓存与配置无关但版本一变就清，避免"改了配置还按旧部门集合过滤"
    this.dataScopeService.invalidate();
    return result;
  }

  /** 供设置页校验：参数变更后需要前端刷新字典缓存 */
  @Get('cache-version')
  cacheVersion(): { ok: true; at: string } {
    if (!process.env.JWT_SECRET) {
      throw new BadRequestException('服务未正确配置');
    }
    return { ok: true, at: new Date().toISOString() };
  }
}
