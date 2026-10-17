import { axiosForBackend } from '@client/src/platform/request';
import type {
  CodeRuleItem,
  DictionaryItem,
  DictionaryOptionsResult,
  RetentionPolicyItem,
  SystemParamItem,
  UpdateRetentionDto,
  UpsertCodeRuleDto,
  UpsertDictionaryDto,
} from '@shared/api.interface';

/**
 * B-03 / B-07 / B-08 系统配置接口。
 *
 * 契约来源：`shared/api.interface.ts`（契约唯一权威）。
 * 本模块**不声明任何本地类型**（API-2 / NFR-M4：check-contract.mjs 会拒绝
 * client/src/api 下的 interface / type / 内联对象类型）。
 */

export async function listDictionary(dictType?: string): Promise<DictionaryItem[]> {
  const resp = await axiosForBackend.get<DictionaryItem[]>('/api/system/dictionary', {
    params: dictType ? { dictType } : undefined,
  });
  return resp.data;
}

export async function upsertDictionary(dto: UpsertDictionaryDto): Promise<DictionaryItem> {
  const resp = await axiosForBackend.post<DictionaryItem>('/api/system/dictionary', dto);
  return resp.data;
}

export async function deleteDictionary(
  dictType: string,
  dictKey: string,
): Promise<{ ok: true }> {
  const resp = await axiosForBackend.post<{ ok: true }>(
    `/api/system/dictionary/${encodeURIComponent(dictType)}/${encodeURIComponent(dictKey)}/delete`,
  );
  return resp.data;
}

export async function listParams(): Promise<SystemParamItem[]> {
  const resp = await axiosForBackend.get<SystemParamItem[]>('/api/system/params');
  return resp.data;
}

export async function updateParam(
  paramKey: string,
  paramValue: string,
): Promise<SystemParamItem> {
  const resp = await axiosForBackend.post<SystemParamItem>(
    `/api/system/params/${encodeURIComponent(paramKey)}`,
    { paramValue },
  );
  return resp.data;
}

export async function listCodeRules(): Promise<CodeRuleItem[]> {
  const resp = await axiosForBackend.get<CodeRuleItem[]>('/api/system/code-rules');
  return resp.data;
}

export async function listRetentionPolicies(): Promise<RetentionPolicyItem[]> {
  const resp = await axiosForBackend.get<RetentionPolicyItem[]>(
    '/api/system/retention-policies',
  );
  return resp.data;
}

export async function updateRetentionPolicy(
  dataType: string,
  dto: UpdateRetentionDto,
): Promise<{ ok: true }> {
  const resp = await axiosForBackend.post<{ ok: true }>(
    `/api/system/retention-policies/${encodeURIComponent(dataType)}`,
    dto,
  );
  return resp.data;
}

/**
 * 前端字典快照（登录即可读；只返回启用项，不含 remark 等内部字段）。
 *
 * B-05：这是"字典作为标签唯一来源"的取数入口 —— `biz-labels` 同步读取
 * 这份快照，避免每个调用点都变成异步。
 */
export async function getDictionaryOptions(
  types?: string[],
): Promise<DictionaryOptionsResult> {
  const resp = await axiosForBackend.get<DictionaryOptionsResult>(
    '/api/system/dictionary/options',
    { params: types && types.length > 0 ? { types: types.join(',') } : undefined },
  );
  return resp.data;
}