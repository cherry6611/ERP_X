import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, asc, eq, sql } from 'drizzle-orm';
import {
  sysCodeRule,
  sysDataRetentionPolicy,
  sysDict,
  sysParam,
} from '@server/database/schema';
import { DictService, type DictItem, type ParamItem } from './dict.service';
import { unwrapRows } from '@server/common/utils/rows';

/** B-08：编号规则的日期段格式 */
export type DatePattern = 'YYYYMM' | 'YYYY' | 'NONE';
export type ResetPolicy = 'never' | 'yearly' | 'monthly';

export interface CodeRule {
  bizType: string;
  bizName: string;
  prefix: string;
  datePattern: DatePattern;
  seqLength: number;
  resetPolicy: ResetPolicy;
  allowReuse: boolean;
  enabled: boolean;
  remark: string | null;
}

/**
 * B-03 + B-08：系统字典 / 参数 / 编号规则的写侧服务。
 *
 * 写侧规则：
 * - 字典项被业务引用时不允许删除（B-03 验收标准③）→ 内置项只能停用；
 * - 修改后必须 `DictService.invalidate()`，否则多实例读到旧值；
 * - 编号规则改动需审计留痕（由全局 audit 拦截器按 objectType 记录）。
 */
@Injectable()
export class SystemConfigService {
  private readonly logger = new Logger(SystemConfigService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly dictService: DictService,
  ) {}

  /* ========== 字典 ========== */

  async listDicts(dictType?: string): Promise<DictItem[]> {
    const all = await this.dictService.listAll(false);
    const items = all as DictItem[];
    return dictType ? items.filter((item) => item.dictType === dictType) : items;
  }

  async upsertDict(dto: {
    dictType: string;
    dictKey: string;
    dictLabel: string;
    extra?: string | null;
    sortNo?: number;
    enabled?: boolean;
    remark?: string | null;
  }): Promise<DictItem> {
    const dictType = dto.dictType?.trim();
    const dictKey = dto.dictKey?.trim();
    const dictLabel = dto.dictLabel?.trim();
    if (!dictType || !/^[a-z][a-z0-9_]{1,63}$/.test(dictType)) {
      throw new BadRequestException(
        'dictType 必须为小写字母开头、仅含小写字母/数字/下划线，长度 2~64'
      );
    }
    if (!dictKey || dictKey.length > 64) {
      throw new BadRequestException('dictKey 必填且长度不超过 64');
    }
    if (!dictLabel || dictLabel.length > 120) {
      throw new BadRequestException('dictLabel 必填且长度不超过 120');
    }
    const existing = await this.db
      .select({ id: sysDict.id, builtin: sysDict.builtin })
      .from(sysDict)
      .where(and(eq(sysDict.dictType, dictType), eq(sysDict.dictKey, dictKey)))
      .limit(1);
    const values = {
      dictType,
      dictKey,
      dictLabel,
      extra: dto.extra ?? null,
      sortNo: dto.sortNo ?? 100,
      enabled: dto.enabled === false ? 0 : 1,
      remark: dto.remark ?? null,
      updatedAt: new Date(),
    };
    if (existing.length > 0) {
      await this.db.update(sysDict).set(values).where(eq(sysDict.id, existing[0].id));
    } else {
      await this.db.insert(sysDict).values({ ...values, builtin: 0 });
    }
    this.dictService.invalidate();
    this.logger.log(`字典已更新 ${dictType}.${dictKey} = ${dictLabel}`);
    return {
      dictType,
      dictKey,
      dictLabel,
      extra: values.extra,
      sortNo: values.sortNo,
      enabled: values.enabled === 1,
      builtin: existing.length > 0 ? Number(existing[0].builtin ?? 0) === 1 : false,
      remark: values.remark,
    };
  }

  /**
   * 删除字典项。B-03 验收标准③："字典项删除时被引用的不允许删除"。
   * 实现方式：内置项（builtin=1）一律拒绝删除（只能停用）；
   * 同时对已知业务表做引用计数校验。
   */
  async deleteDict(dictType: string, dictKey: string): Promise<{ ok: true }> {
    const rows = await this.db
      .select({ id: sysDict.id, builtin: sysDict.builtin })
      .from(sysDict)
      .where(and(eq(sysDict.dictType, dictType), eq(sysDict.dictKey, dictKey)))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('字典项不存在');
    if (Number(rows[0].builtin ?? 0) === 1) {
      throw new ConflictException(
        '系统内置字典项不允许删除，请改为"停用"（避免历史数据与页面出现空白）'
      );
    }
    const references = await this.countReferences(dictType, dictKey);
    if (references > 0) {
      throw new ConflictException(
        `该字典项已被 ${references} 条业务数据引用，不允许删除；请改为"停用"`
      );
    }
    await this.db.delete(sysDict).where(eq(sysDict.id, rows[0].id));
    this.dictService.invalidate();
    return { ok: true };
  }

  /** 字典项的业务引用计数（只覆盖会落库的字典类型） */
  private async countReferences(dictType: string, dictKey: string): Promise<number> {
    const targets: Record<string, { table: string; column: string }> = {
      cost_type: { table: 'erp_project_cost', column: 'cost_type' },
      expense_category: {
        table: 'fin_expense_claim',
        column: 'expense_category',
      },
      invoice_type: { table: 'erp_invoice', column: 'invoice_type' },
      deliverable_type: { table: 'erp_deliverable', column: 'deliverable_type' },
    };
    const target = targets[dictType];
    if (!target) return 0;
    try {
      const result = await this.db.execute(sql`
        SELECT count(*)::int AS total
        FROM ${sql.raw(`"${target.table}"`)}
        WHERE ${sql.raw(`"${target.column}"`)} = ${dictKey}
      `);
      return Number(unwrapRows<{ total: number }>(result)[0]?.total ?? 0);
    } catch (error) {
      // 表或列不存在时（尚未迁移/字段改名）不阻塞删除，但要留日志
      this.logger.warn(
        `字典引用计数失败 ${dictType}.${dictKey}：${error instanceof Error ? error.message : String(error)}`
      );
      return 0;
    }
  }

  /* ========== 参数 ========== */

  async listParams(): Promise<ParamItem[]> {
    return this.dictService.listParams();
  }

  async updateParam(
    paramKey: string,
    paramValue: string
  ): Promise<ParamItem> {
    const rows = await this.db
      .select({
        id: sysParam.id,
        valueType: sysParam.valueType,
        editable: sysParam.editable,
      })
      .from(sysParam)
      .where(eq(sysParam.paramKey, paramKey))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException(`参数 ${paramKey} 不存在`);
    if (Number(rows[0].editable ?? 1) !== 1) {
      throw new BadRequestException(
        `参数 ${paramKey} 为只读参数（涉及财务口径红线），不允许在界面修改`
      );
    }
    const valueType = (rows[0].valueType ?? 'string') as ParamItem['valueType'];
    this.assertParamValue(paramKey, valueType, paramValue);
    await this.db
      .update(sysParam)
      .set({ paramValue, updatedAt: new Date() })
      .where(eq(sysParam.id, rows[0].id));
    this.dictService.invalidate();
    this.logger.log(`参数已更新 ${paramKey} = ${paramValue}`);
    const updated = await this.dictService.getParam(paramKey);
    if (!updated) throw new NotFoundException(`参数 ${paramKey} 更新后读取失败`);
    return updated;
  }

  private assertParamValue(
    key: string,
    valueType: ParamItem['valueType'],
    value: string
  ): void {
    if (value.length > 500) {
      throw new BadRequestException('参数值长度不得超过 500');
    }
    if (valueType === 'number') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) {
        throw new BadRequestException(`参数 ${key} 必须为数字`);
      }
      if (parsed < 0) throw new BadRequestException(`参数 ${key} 不得为负数`);
      return;
    }
    if (valueType === 'boolean') {
      if (!['0', '1', 'true', 'false'].includes(value.toLowerCase())) {
        throw new BadRequestException(`参数 ${key} 必须为 0/1/true/false`);
      }
      return;
    }
    if (valueType === 'json') {
      try {
        JSON.parse(value);
      } catch {
        throw new BadRequestException(`参数 ${key} 必须为合法 JSON`);
      }
    }
  }

  /* ========== B-08 编号规则 ========== */

  private toCodeRule(row: {
    bizType: string;
    bizName: string;
    prefix: string;
    datePattern: string;
    seqLength: number;
    resetPolicy: string;
    allowReuse: number;
    enabled: number;
    remark: string | null;
  }): CodeRule {
    return {
      bizType: row.bizType,
      bizName: row.bizName,
      prefix: row.prefix,
      datePattern: (row.datePattern ?? 'YYYYMM') as DatePattern,
      seqLength: Number(row.seqLength ?? 4),
      resetPolicy: (row.resetPolicy ?? 'monthly') as ResetPolicy,
      allowReuse: Number(row.allowReuse ?? 0) === 1,
      enabled: Number(row.enabled ?? 1) === 1,
      remark: row.remark ?? null,
    };
  }

  async listCodeRules(): Promise<CodeRule[]> {
    const rows = await this.db
      .select({
        bizType: sysCodeRule.bizType,
        bizName: sysCodeRule.bizName,
        prefix: sysCodeRule.prefix,
        datePattern: sysCodeRule.datePattern,
        seqLength: sysCodeRule.seqLength,
        resetPolicy: sysCodeRule.resetPolicy,
        allowReuse: sysCodeRule.allowReuse,
        enabled: sysCodeRule.enabled,
        remark: sysCodeRule.remark,
      })
      .from(sysCodeRule)
      .orderBy(asc(sysCodeRule.bizType));
    return rows.map((row) => this.toCodeRule(row));
  }

  /**
   * 财务类单据编号禁止重用（B-09 审计红线）：
   * 凭证、发票、收付款、工资单一律 `allow_reuse = 0` 且不允许被改为 1。
   */
  static readonly NO_REUSE_BIZ_TYPES = [
    'VOUCHER',
    'INVOICE',
    'RECEIPT',
    'PAYMENT',
    'PAYROLL',
    'AP_BILL',
    'AR_BILL',
  ];

  async upsertCodeRule(dto: {
    bizType: string;
    bizName?: string;
    prefix: string;
    datePattern?: DatePattern;
    seqLength?: number;
    resetPolicy?: ResetPolicy;
    allowReuse?: boolean;
    enabled?: boolean;
    remark?: string | null;
  }): Promise<CodeRule> {
    const bizType = dto.bizType?.trim().toUpperCase();
    if (!bizType || !/^[A-Z][A-Z0-9_]{1,39}$/.test(bizType)) {
      throw new BadRequestException(
        'bizType 必须为大写字母开头、仅含大写字母/数字/下划线，长度 2~40'
      );
    }
    const prefix = dto.prefix?.trim();
    if (!prefix || !/^[A-Z0-9]{1,16}$/.test(prefix)) {
      throw new BadRequestException('prefix 必须为 1~16 位大写字母或数字');
    }
    if (
      dto.allowReuse === true &&
      SystemConfigService.NO_REUSE_BIZ_TYPES.includes(bizType)
    ) {
      throw new BadRequestException(
        `${bizType} 为财务类单据，编号禁止重用（审计红线），不允许开启 allowReuse`
      );
    }
    const datePattern = dto.datePattern ?? 'YYYYMM';
    const resetPolicy = dto.resetPolicy ?? 'monthly';
    if (!['YYYYMM', 'YYYY', 'NONE'].includes(datePattern)) {
      throw new BadRequestException('datePattern 仅支持 YYYYMM / YYYY / NONE');
    }
    if (!['never', 'yearly', 'monthly'].includes(resetPolicy)) {
      throw new BadRequestException('resetPolicy 仅支持 never / yearly / monthly');
    }
    if (datePattern === 'NONE' && resetPolicy !== 'never') {
      throw new BadRequestException(
        '日期段为 NONE 时无法按年/月重置流水，resetPolicy 必须为 never'
      );
    }
    const seqLength = dto.seqLength ?? 4;
    if (!Number.isInteger(seqLength) || seqLength < 3 || seqLength > 10) {
      throw new BadRequestException('seqLength 必须为 3~10 的整数');
    }
    // 前缀唯一性：两个业务类型同前缀会导致编号空间重叠
    const clash = await this.db
      .select({ bizType: sysCodeRule.bizType })
      .from(sysCodeRule)
      .where(eq(sysCodeRule.prefix, prefix))
      .limit(2);
    if (clash.length > 0 && clash.some((row) => row.bizType !== bizType)) {
      throw new ConflictException(
        `前缀 ${prefix} 已被业务类型 ${clash.map((row) => row.bizType).join('、')} 使用`
      );
    }
    const existing = await this.db
      .select({ bizType: sysCodeRule.bizType })
      .from(sysCodeRule)
      .where(eq(sysCodeRule.bizType, bizType))
      .limit(1);
    const values = {
      bizType,
      bizName: dto.bizName?.trim() || bizType,
      prefix,
      datePattern,
      seqLength,
      resetPolicy,
      allowReuse:
        dto.allowReuse === true &&
        !SystemConfigService.NO_REUSE_BIZ_TYPES.includes(bizType)
          ? 1
          : 0,
      enabled: dto.enabled === false ? 0 : 1,
      remark: dto.remark ?? null,
      updatedAt: new Date(),
    };
    if (existing.length > 0) {
      await this.db.update(sysCodeRule).set(values).where(eq(sysCodeRule.bizType, bizType));
    } else {
      await this.db.insert(sysCodeRule).values(values);
    }
    this.logger.log(`编号规则已更新 ${bizType} → ${prefix} (${datePattern}/${seqLength})`);
    return this.toCodeRule(values);
  }

  /* ========== B-07 数据保留策略 ========== */

  async listRetentionPolicies(): Promise<
    Array<{
      dataType: string;
      displayName: string;
      retainDays: number;
      action: 'none' | 'archive' | 'delete';
      enabled: boolean;
      lastRunAt: string | null;
      lastRunCount: number | null;
      remark: string | null;
    }>
  > {
    const rows = await this.db
      .select()
      .from(sysDataRetentionPolicy)
      .orderBy(asc(sysDataRetentionPolicy.dataType));
    return rows.map((row) => ({
      dataType: row.dataType,
      displayName: row.displayName,
      retainDays: Number(row.retainDays ?? 730),
      action: (row.action ?? 'archive') as 'none' | 'archive' | 'delete',
      enabled: Number(row.enabled ?? 1) === 1,
      lastRunAt: row.lastRunAt ? row.lastRunAt.toISOString() : null,
      lastRunCount: row.lastRunCount == null ? null : Number(row.lastRunCount),
      remark: row.remark ?? null,
    }));
  }

  async updateRetentionPolicy(
    dataType: string,
    dto: { retainDays?: number; action?: 'none' | 'archive' | 'delete'; enabled?: boolean; remark?: string | null }
  ): Promise<{ ok: true }> {
    const rows = await this.db
      .select({ id: sysDataRetentionPolicy.id })
      .from(sysDataRetentionPolicy)
      .where(eq(sysDataRetentionPolicy.dataType, dataType))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException(`保留策略 ${dataType} 不存在`);
    if (dto.retainDays != null) {
      if (!Number.isInteger(dto.retainDays) || dto.retainDays < 1 || dto.retainDays > 36_500) {
        throw new BadRequestException('retainDays 必须为 1~36500 的整数');
      }
    }
    if (dto.action && !['none', 'archive', 'delete'].includes(dto.action)) {
      throw new BadRequestException('action 仅支持 none / archive / delete');
    }
    // 审计类数据不允许"直接删除"（NFR-S8 要求审计可追溯）
    if (
      dto.action === 'delete' &&
      ['audit_log', 'login_audit'].includes(dataType)
    ) {
      throw new BadRequestException(
        `${dataType} 属于审计类数据，只允许 archive（归档），不允许 delete`
      );
    }
    await this.db
      .update(sysDataRetentionPolicy)
      .set({
        ...(dto.retainDays != null ? { retainDays: dto.retainDays } : {}),
        ...(dto.action ? { action: dto.action } : {}),
        ...(dto.enabled != null ? { enabled: dto.enabled ? 1 : 0 } : {}),
        ...(dto.remark !== undefined ? { remark: dto.remark } : {}),
        updatedAt: new Date(),
      })
      .where(eq(sysDataRetentionPolicy.id, rows[0].id));
    return { ok: true };
  }
}
