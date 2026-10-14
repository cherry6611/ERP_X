/**
 * B-05：前端字典快照（`sys_dict` 作为标签唯一来源）。
 *
 * ## 为什么需要一个模块级快照而不是 Context
 *
 * 标签的调用点遍布各处，其中不少在**非组件上下文**里（表格列定义、导出、
 * 打印模板、状态映射函数）。如果标签只能从 React Context 取，这些地方就
 * 拿不到，只能继续硬编码 —— 这正是 B-05 要消除的问题。
 *
 * 因此这里用**模块级同步快照**：
 * - `loadDictionarySnapshot()` 在登录后拉一次（`DictionarySnapshotProvider` 里调用）；
 * - `labelFor()` 是**同步**函数，任何地方都能调；
 * - 快照未加载或字典缺项时**回落到调用方传入的兜底值**（即原来的硬编码常量）。
 *
 * ## 兜底不是"两套数据源"，而是显示降级
 *
 * 关键区分：字典是**唯一权威**，兜底常量只在"字典还没有这一项"时生效
 * （例如新装系统尚未执行种子的瞬间、或网络失败）。`labelFor` 的返回值不区分
 * 两者对使用者而言没差别，但 `dictionarySource()` 会如实报告当前状态，
 * 便于在设置页提示"字典未加载"。
 */

import type { DictionaryOptionsResult } from '@shared/api.interface';

interface SnapshotEntry {
  key: string;
  label: string;
  extra: string | null;
}

let snapshot: Record<string, SnapshotEntry[]> | null = null;
let snapshotEpoch = 0;
const listeners = new Set<() => void>();

/** 是否已加载字典快照（设置页可用于提示） */
export function hasDictionarySnapshot(): boolean {
  return snapshot !== null;
}

/** 快照版本号（每次加载自增，供 `useSyncExternalStore` 判断变化） */
export function dictionaryEpoch(): number {
  return snapshotEpoch;
}

/** 订阅快照变化（供 `useSyncExternalStore` 使用） */
export function subscribeDictionary(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 装载字典快照。
 *
 * 失败时**保留旧快照**而不是清空：网络抖动不应该让全站标签退化成英文 key。
 * 若从未加载成功过，则保持 `null`（`labelFor` 走兜底）。
 */
export function applyDictionarySnapshot(result: DictionaryOptionsResult): void {
  const next: Record<string, SnapshotEntry[]> = {};
  for (const [dictType, items] of Object.entries(result.dictionary ?? {})) {
    next[dictType] = (items ?? []).map((item) => ({
      key: item.key,
      label: item.label,
      extra: item.extra,
    }));
  }
  snapshot = next;
  snapshotEpoch += 1;
  for (const listener of listeners) listener();
}

/** 仅测试用：重置快照 */
export function resetDictionarySnapshot(): void {
  snapshot = null;
  snapshotEpoch += 1;
  for (const listener of listeners) listener();
}

/**
 * 同步取标签。
 *
 * @param dictType 字典类型（如 `lead_status`）
 * @param value    字典键（如 `following`）
 * @param fallback 字典缺此项时的兜底（即原先的硬编码常量）
 *
 * 返回值优先级：字典 > 兜底 > 原值本身。
 * 最后一级很重要：**绝不能返回空串** —— 界面会显示成空白，
 * 让人以为数据缺失，而实际上只是标签没配。返回原值至少能看出是什么状态。
 */
export function labelFor(
  dictType: string,
  value: string | null | undefined,
  fallback?: string,
): string {
  if (value === null || value === undefined || value === '') return '';
  const entry = snapshot?.[dictType]?.find((item) => item.key === value);
  if (entry) return entry.label;
  if (fallback !== undefined && fallback !== '') return fallback;
  return value;
}

/**
 * 把一整组硬编码常量按字典覆盖。
 *
 * 用途：`biz-labels.ts` 里的 `Record<string, string>` 常量可以原样传进来，
 * 得到一个"字典优先、常量兜底"的版本。这样调用点完全不用改
 * （仍然是 `LABELS[value]`），但字典一旦配置就自动生效。
 *
 * 实现方式：返回一个 Proxy，读取时先查字典再查原对象。
 * 为什么用 Proxy 而不是在加载时改写原对象：字典是异步到达的，
 * 改写原对象要么需要遍历所有导出常量（易漏），要么需要可变模块状态（更难测）。
 * Proxy 让"字典优先"这件事在**读取那一刻**决定，天然正确。
 */
export function withDictionaryFallback(
  dictType: string,
  fallback: Record<string, string>,
): Record<string, string> {
  return new Proxy(fallback, {
    get(target, property, receiver) {
      if (typeof property !== 'string') {
        return Reflect.get(target, property, receiver);
      }
      const entry = snapshot?.[dictType]?.find((item) => item.key === property);
      if (entry) return entry.label;
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      if (
        typeof property === 'string' &&
        snapshot?.[dictType]?.some((item) => item.key === property)
      ) {
        return true;
      }
      return Reflect.has(target, property);
    },
    /**
     * `ownKeys` **只返回兜底对象的键**，刻意不并入字典独有键。
     *
     * 原因是 Proxy 的不变量：`ownKeys` 报告的每个键（非 configurable 时）都必须在
     * `getOwnPropertyDescriptor` 里存在，否则 `Object.keys` / 展开运算会抛
     * `TypeError`。而字典独有键在兜底对象上并不存在，"报告它"就得在
     * `getOwnPropertyDescriptor` 里凭空造一个 —— 那会让 `Object.keys` 的返回
     * 随字典内容变化，进而改变界面行为（下拉选项突然多出后端字典里的键），
     * 这超出 B-05 的范围。
     *
     * 所以这里选择**保守一致**：
     * - `labels[key]` 读取 → 字典优先（B-05 的目标，已达成）；
     * - `key in labels` → 能识别字典独有键（供"是否已知状态"判断）；
     * - `Object.keys` → 只有兜底键（行为稳定）。
     *
     * 需要"某个字典类型的完整键列表"时用 `dictionaryKeys()`，语义清晰无歧义。
     */
    ownKeys(target) {
      return Reflect.ownKeys(target);
    },
  });
}

/** 某字典类型的全部取值（字典优先；字典为空时返回空数组，调用方自行兜底） */
export function dictionaryKeys(dictType: string): string[] {
  return (snapshot?.[dictType] ?? []).map((item) => item.key);
}
