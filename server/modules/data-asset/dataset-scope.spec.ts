import { datasetInScope } from './dataset-scope';

describe('数据集可见范围', () => {
  it('不受限的用户看得到未关联合同的数据集', () => {
    expect(datasetInScope(null, { unrestricted: true })).toBe(true);
  });

  it('收窄后只看得到自己合同上的数据集', () => {
    const scope = { unrestricted: false as const, contractIds: ['c1'] };
    expect(datasetInScope('c1', scope)).toBe(true);
    expect(datasetInScope('c2', scope)).toBe(false);
    expect(datasetInScope(null, scope)).toBe(false);
  });
});
