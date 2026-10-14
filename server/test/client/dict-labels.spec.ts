import {
  applyDictionarySnapshot,
  dictionaryEpoch,
  dictionaryKeys,
  hasDictionarySnapshot,
  labelFor,
  resetDictionarySnapshot,
  subscribeDictionary,
  withDictionaryFallback,
} from '@client/src/utils/dict-labels';

/**
 * B-05 字典标签层单测。
 *
 * 这一层的风险在于**静默退化**：如果 `withDictionaryFallback` 写错，
 * 界面会显示原始英文 key（如 `following`）而不会报错 ——
 * 没人会在 CI 里发现，直到业务方截图来问。因此这里把
 * "字典优先 / 兜底生效 / 绝不返回空串" 三件事分别钉死。
 */
describe('B-05 字典快照', () => {
  afterEach(() => {
    resetDictionarySnapshot();
  });

  it('初始状态未加载快照', () => {
    resetDictionarySnapshot();
    expect(hasDictionarySnapshot()).toBe(false);
    expect(dictionaryKeys('lead_status')).toEqual([]);
  });

  it('装载后 hasDictionarySnapshot 为 true，epoch 自增（供 useSyncExternalStore）', () => {
    const before = dictionaryEpoch();
    applyDictionarySnapshot({
      dictionary: { lead_status: [{ key: 'new', label: '新建', extra: null }] },
      taxRates: [6],
    });
    expect(hasDictionarySnapshot()).toBe(true);
    expect(dictionaryEpoch()).toBeGreaterThan(before);
  });

  it('订阅者在装载与重置时被通知', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeDictionary(listener);
    applyDictionarySnapshot({ dictionary: {}, taxRates: [] });
    expect(listener).toHaveBeenCalledTimes(1);
    resetDictionarySnapshot();
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    resetDictionarySnapshot();
    // 退订后不再通知
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('dictionary 为 undefined 时不抛错，视为空快照', () => {
    applyDictionarySnapshot({ dictionary: undefined as never, taxRates: [] });
    expect(hasDictionarySnapshot()).toBe(true);
    expect(labelFor('lead_status', 'new', '新建')).toBe('新建');
  });

  it('dictionaryKeys 返回已装载的键', () => {
    applyDictionarySnapshot({
      dictionary: {
        lead_status: [
          { key: 'new', label: '新建', extra: null },
          { key: 'lost', label: '已流失', extra: null },
        ],
      },
      taxRates: [],
    });
    expect(dictionaryKeys('lead_status')).toEqual(['new', 'lost']);
  });
});

describe('B-05 labelFor', () => {
  afterEach(() => resetDictionarySnapshot());

  it('字典有该项 → 用字典文案（业务方改文案即时生效）', () => {
    applyDictionarySnapshot({
      dictionary: {
        ar_status: [{ key: 'open', label: '待收款', extra: null }],
      },
      taxRates: [],
    });
    // 兜底是"待回款"，字典是"待收款" → 取字典
    expect(labelFor('ar_status', 'open', '待回款')).toBe('待收款');
  });

  it('字典缺该项 → 用兜底（界面显示不变）', () => {
    applyDictionarySnapshot({
      dictionary: { ar_status: [{ key: 'open', label: '待收款', extra: null }] },
      taxRates: [],
    });
    expect(labelFor('ar_status', 'settled', '已结清')).toBe('已结清');
  });

  it('快照未加载 → 用兜底', () => {
    resetDictionarySnapshot();
    expect(labelFor('ar_status', 'open', '待回款')).toBe('待回款');
  });

  it('字典与兜底都没有 → 返回原值（绝不返回空串）', () => {
    resetDictionarySnapshot();
    // 返回空串会让界面显示空白，使用者以为数据缺失；
    // 返回原值至少能看出是什么状态
    expect(labelFor('unknown_type', 'some_value')).toBe('some_value');
  });

  it('空值与 null/undefined 返回空串（不是 "null" 字符串）', () => {
    applyDictionarySnapshot({ dictionary: {}, taxRates: [] });
    expect(labelFor('ar_status', null)).toBe('');
    expect(labelFor('ar_status', undefined)).toBe('');
    expect(labelFor('ar_status', '')).toBe('');
  });

  it('兜底为空串时继续回落到原值（空串不算有效兜底）', () => {
    resetDictionarySnapshot();
    expect(labelFor('ar_status', 'open', '')).toBe('open');
  });
});

describe('B-05 withDictionaryFallback', () => {
  afterEach(() => resetDictionarySnapshot());

  it('字典未加载时行为与普通对象完全一致（调用点无需改）', () => {
    resetDictionarySnapshot();
    const labels = withDictionaryFallback('lead_status', {
      new: '新建',
      following: '跟进中',
    });
    expect(labels.new).toBe('新建');
    expect(labels.following).toBe('跟进中');
    expect(labels.notExist).toBeUndefined();
  });

  it('字典加载后字典优先，未覆盖的键仍走兜底', () => {
    const labels = withDictionaryFallback('lead_status', {
      new: '新建',
      following: '跟进中',
    });
    applyDictionarySnapshot({
      dictionary: {
        lead_status: [{ key: 'following', label: '持续跟进', extra: null }],
      },
      taxRates: [],
    });
    expect(labels.following).toBe('持续跟进');
    expect(labels.new).toBe('新建');
  });

  it('不破坏原对象（Proxy 不修改 target）', () => {
    const original = { new: '新建' };
    const labels = withDictionaryFallback('lead_status', original);
    applyDictionarySnapshot({
      dictionary: { lead_status: [{ key: 'new', label: '新线索', extra: null }] },
      taxRates: [],
    });
    expect(labels.new).toBe('新线索');
    // 原对象未被改写 —— 这点很重要：否则测试之间会互相污染
    expect(original.new).toBe('新建');
  });

  it('Object.keys 返回兜底键（**不并入字典独有键**）', () => {
    const labels = withDictionaryFallback('lead_status', { new: '新建' });
    applyDictionarySnapshot({
      dictionary: {
        lead_status: [
          { key: 'new', label: '新建', extra: null },
          { key: 'dictionary_only', label: '字典独有', extra: null },
        ],
      },
      taxRates: [],
    });
    // 为什么刻意不并入字典独有键：Object.keys 常被用于渲染下拉选项，
    // 突然多出后端字典里的键会改变界面行为（超出 B-05 的范围）。
    // 需要完整列表时用 dictionaryKeys()。
    expect(Object.keys(labels)).toEqual(['new']);
    expect(dictionaryKeys('lead_status')).toContain('dictionary_only');
  });

  it('展开运算不抛错（Proxy 的 ownKeys 与 getOwnPropertyDescriptor 必须一致）', () => {
    const labels = withDictionaryFallback('lead_status', { new: '新建' });
    applyDictionarySnapshot({
      dictionary: { lead_status: [{ key: 'new', label: '新线索', extra: null }] },
      taxRates: [],
    });
    // 若 ownKeys 报告了 getOwnPropertyDescriptor 不认识的键，
    // Object.keys / 展开会抛 TypeError
    expect(() => ({ ...labels })).not.toThrow();
    expect({ ...labels }).toEqual({ new: '新线索' });
  });

  it('in 运算符能识别字典独有键（供"是否已知状态"判断）', () => {
    const labels = withDictionaryFallback('lead_status', {});
    applyDictionarySnapshot({
      dictionary: {
        lead_status: [{ key: 'dictionary_only', label: '字典独有', extra: null }],
      },
      taxRates: [],
    });
    expect('dictionary_only' in labels).toBe(true);
    expect('nope' in labels).toBe(false);
  });

  it('非字符串属性访问（如 Symbol）走原对象，不抛错', () => {
    const labels = withDictionaryFallback('lead_status', { new: '新建' });
    applyDictionarySnapshot({ dictionary: {}, taxRates: [] });
    expect(() => (labels as Record<symbol, unknown>)[Symbol.iterator]).not.toThrow();
  });
});
