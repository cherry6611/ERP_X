import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, asc, eq, sql } from 'drizzle-orm';
import { sysDict, sysParam } from '@server/database/schema';
import { TAX_RATE_DICTIONARY } from '@shared/tax';
import { unwrapRows } from '@server/common/utils/rows';

/**
 * B-03：系统字典与参数读取服务。
 *
 * 设计要点（对齐需求书的迁移策略）：
 * 1. **缓存 + epoch**：整表 60s 内存缓存，配合 `epoch` 做失效；
 *    参照 `AutomationConfigService` 的模式，多实例场景下由
 *    `sys_dict._updated_at` 的最大值变化触发重载；
 * 2. **fallback**：字典缺失时回落到调用方传入的默认值，
 *    保证"库没种子数据"时页面不会空白（这是 B-03 明确要求的）；
 * 3. 读接口不抛错，写接口在 `SystemConfigService` 中严格校验。
 */

const CACHE_TTL_MS = 60_000;

export interface DictItem {
  dictType: string;
  dictKey: string;
  dictLabel: string;
  extra: string | null;
  sortNo: number;
  enabled: boolean;
  builtin: boolean;
  remark: string | null;
}

export interface ParamItem {
  paramKey: string;
  paramValue: string;
  valueType: 'string' | 'number' | 'boolean' | 'json';
  paramGroup: string;
  description: string | null;
  editable: boolean;
}

@Injectable()
export class DictService {
  private readonly logger = new Logger(DictService.name);
  private dictCache: { at: number; epoch: string; data: DictItem[] } | null = null;
  private paramCache: { at: number; epoch: string; data: ParamItem[] } | null = null;

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase
  ) {}

  /** 清空缓存（写接口调用后必须失效，否则多实例读到旧值） */
  invalidate(): void {
    this.dictCache = null;
    this.paramCache = null;
  }

  private async dictEpoch(): Promise<string> {
    try {
      const rows = await this.db.execute(sql`
        SELECT coalesce(max(_updated_at)::text, '') || ':' || count(*)::text AS epoch
        FROM sys_dict
      `);
      return unwrapRows<{ epoch: string }>(rows)[0]?.epoch ?? '';
    } catch (error) {
      // 表不存在（尚未迁移）时返回空 epoch，读接口走 fallback
      this.logger.warn(
        `sys_dict epoch 读取失败，字典回退到默认值：${error instanceof Error ? error.message : String(error)}`
      );
      return '';
    }
  }

  private async loadDicts(): Promise<DictItem[]> {
    if (this.dictCache && Date.now() - this.dictCache.at < CACHE_TTL_MS) {
      const epoch = await this.dictEpoch();
      if (epoch === this.dictCache.epoch) return this.dictCache.data;
    }
    const epoch = await this.dictEpoch();
    if (epoch === '') {
      this.dictCache = { at: Date.now(), epoch: '', data: [] };
      return [];
    }
    const rows = await this.db
      .select({
        dictType: sysDict.dictType,
        dictKey: sysDict.dictKey,
        dictLabel: sysDict.dictLabel,
        extra: sysDict.extra,
        sortNo: sysDict.sortNo,
        enabled: sysDict.enabled,
        builtin: sysDict.builtin,
        remark: sysDict.remark,
      })
      .from(sysDict)
      .orderBy(asc(sysDict.dictType), asc(sysDict.sortNo), asc(sysDict.dictKey));
    const data: DictItem[] = rows.map((row) => ({
      dictType: row.dictType,
      dictKey: row.dictKey,
      dictLabel: row.dictLabel,
      extra: row.extra ?? null,
      sortNo: Number(row.sortNo ?? 0),
      enabled: Number(row.enabled ?? 1) === 1,
      builtin: Number(row.builtin ?? 0) === 1,
      remark: row.remark ?? null,
    }));
    this.dictCache = { at: Date.now(), epoch, data };
    return data;
  }

  /** 全部字典（按类型分组），供前端一次性拉取 */
  async listAll(grouped = true): Promise<
    Record<string, DictItem[]> | DictItem[]
  > {
    const items = await this.loadDicts();
    if (!grouped) return items;
    const result: Record<string, DictItem[]> = {};
    for (const item of items) {
      result[item.dictType] = [...(result[item.dictType] ?? []), item];
    }
    return result;
  }

  /** 单一字典类型（只返回启用项） */
  async listType(dictType: string): Promise<DictItem[]> {
    const items = await this.loadDicts();
    return items.filter((item) => item.dictType === dictType && item.enabled);
  }

  /**
   * 取值 → 标签映射。`fallback` 用于字典尚未种子化时的兜底，
   * 例如 `TAX_RATE_LABELS`（当前税率档位硬编码在 shared/tax.ts）。
   */
  async labelMap(
    dictType: string,
    fallback: Record<string, string> = {}
  ): Promise<Record<string, string>> {
    const items = await this.listType(dictType);
    if (items.length === 0) return fallback;
    const map: Record<string, string> = { ...fallback };
    for (const item of items) map[item.dictKey] = item.dictLabel;
    return map;
  }

  /** 税率档位（B-08 要求"税率字典来源可扩展"，同时保持 shared/tax.ts 为 fallback） */
  async taxRates(): Promise<number[]> {
    const items = await this.listType('tax_rate');
    if (items.length === 0) return [...TAX_RATE_DICTIONARY];
    const rates = items
      .map((item) => Number(item.dictKey))
      .filter((rate) => Number.isFinite(rate));
    return rates.length > 0 ? rates : [...TAX_RATE_DICTIONARY];
  }

  /* ========== 参数 ========== */

  private async paramEpoch(): Promise<string> {
    try {
      const rows = await this.db.execute(sql`
        SELECT coalesce(max(_updated_at)::text, '') || ':' || count(*)::text AS epoch
        FROM sys_param
      `);
      return unwrapRows<{ epoch: string }>(rows)[0]?.epoch ?? '';
    } catch {
      return '';
    }
  }

  private async loadParams(): Promise<ParamItem[]> {
    if (this.paramCache && Date.now() - this.paramCache.at < CACHE_TTL_MS) {
      const epoch = await this.paramEpoch();
      if (epoch === this.paramCache.epoch) return this.paramCache.data;
    }
    const epoch = await this.paramEpoch();
    if (epoch === '') {
      this.paramCache = { at: Date.now(), epoch: '', data: [] };
      return [];
    }
    const rows = await this.db
      .select({
        paramKey: sysParam.paramKey,
        paramValue: sysParam.paramValue,
        valueType: sysParam.valueType,
        paramGroup: sysParam.paramGroup,
        description: sysParam.description,
        editable: sysParam.editable,
      })
      .from(sysParam)
      .orderBy(asc(sysParam.paramGroup), asc(sysParam.paramKey));
    const data: ParamItem[] = rows.map((row) => ({
      paramKey: row.paramKey,
      paramValue: row.paramValue,
      valueType: (row.valueType ?? 'string') as ParamItem['valueType'],
      paramGroup: row.paramGroup ?? 'general',
      description: row.description ?? null,
      editable: Number(row.editable ?? 1) === 1,
    }));
    this.paramCache = { at: Date.now(), epoch, data };
    return data;
  }

  async listParams(): Promise<ParamItem[]> {
    return this.loadParams();
  }

  async getParam(key: string): Promise<ParamItem | null> {
    const params = await this.loadParams();
    return params.find((item) => item.paramKey === key) ?? null;
  }

  /** 字符串参数（缺失时返回 fallback） */
  async stringParam(key: string, fallback: string): Promise<string> {
    const param = await this.getParam(key);
    return param?.paramValue ?? fallback;
  }

  /** 数字参数（非法值回落 fallback，避免脏数据导致计算崩溃） */
  async numberParam(key: string, fallback: number): Promise<number> {
    const param = await this.getParam(key);
    if (!param) return fallback;
    const value = Number(param.paramValue);
    return Number.isFinite(value) ? value : fallback;
  }

  async booleanParam(key: string, fallback: boolean): Promise<boolean> {
    const param = await this.getParam(key);
    if (!param) return fallback;
    return param.paramValue === '1' || param.paramValue.toLowerCase() === 'true';
  }

  async jsonParam<T>(key: string, fallback: T): Promise<T> {
    const param = await this.getParam(key);
    if (!param) return fallback;
    try {
      return JSON.parse(param.paramValue) as T;
    } catch {
      this.logger.warn(`参数 ${key} 的 JSON 值非法，回落默认值`);
      return fallback;
    }
  }

  /** B-04：从参数读取登录锁定策略（缺失时用代码默认值） */
  async lockoutPolicy(): Promise<{ maxAttempts: number; lockMinutes: number }> {
    return {
      maxAttempts: await this.numberParam('security.login_max_attempts', 5),
      lockMinutes: await this.numberParam('security.lock_minutes', 15),
    };
  }

  /** B-04：密码策略（含强制更换周期） */
  async passwordPolicy(): Promise<{ maxAgeDays: number }> {
    return {
      maxAgeDays: await this.numberParam('finance.password_max_age_days', 90),
    };
  }

  /** B-04：强制 MFA 的角色清单 */
  async mfaForcedRoles(): Promise<string[]> {
    return this.jsonParam<string[]>('security.mfa_forced_roles', [
      'admin',
      'user_admin',
      'finance_viewer',
    ]);
  }

  /** B-06：附件大小上限（MB） */
  async attachmentMaxSizeMb(): Promise<number> {
    return this.numberParam('attachment.max_size_mb', 20);
  }

  /** B-06：病毒扫描提供方 */
  async scanProvider(): Promise<string> {
    return this.stringParam('attachment.scan_provider', 'none');
  }

  /** B-08：编号是否允许重用（财务类红线，默认禁止） */
  async allowVoidReuse(): Promise<boolean> {
    return this.booleanParam('number.allow_void_reuse', false);
  }

  /** B-03：报价毛利下限（审批阈值） */
  async quotationMinGrossMargin(): Promise<number> {
    return this.numberParam('approval.quotation_min_gross_margin', 20);
  }

  /** B-03：预算超支告警比例 */
  async budgetOverrunWarnPct(): Promise<number> {
    return this.numberParam('approval.budget_overrun_warn_pct', 10);
  }

  /** 是否存在某字典项（写接口校验用） */
  async dictItemExists(dictType: string, dictKey: string): Promise<boolean> {
    const rows = await this.db
      .select({ id: sysDict.id })
      .from(sysDict)
      .where(and(eq(sysDict.dictType, dictType), eq(sysDict.dictKey, dictKey)))
      .limit(1);
    return rows.length > 0;
  }
}
