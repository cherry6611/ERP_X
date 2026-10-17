/**
 * 「调拨必须有目标」的回归断言。
 *
 * 缺陷背景：弹窗提供「调拨」但没有任何目标部门/项目的输入，服务端
 * `createChange` 必然以 400 拒绝 —— 选项是死的。修复后由本模块统一判据。
 */
import {
  buildAssetChangeDto,
  requiresTransferTarget,
  transferTargetError,
} from './asset-change-rules';

describe('资产变更：调拨目标校验', () => {
  it('只有 transfer 需要目标，领用/报废不需要', () => {
    expect(requiresTransferTarget('transfer')).toBe(true);
    expect(requiresTransferTarget('receive')).toBe(false);
    expect(requiresTransferTarget('scrap')).toBe(false);
    expect(requiresTransferTarget('')).toBe(false);
  });

  it('调拨未填目标部门与项目 → 给出与服务端同口径的错误文案', () => {
    expect(transferTargetError('transfer')).toBe('调拨必须至少指定目标部门或目标项目');
    expect(transferTargetError('transfer', '', '')).toBe(
      '调拨必须至少指定目标部门或目标项目'
    );
    expect(transferTargetError('transfer', null, null)).toBe(
      '调拨必须至少指定目标部门或目标项目'
    );
  });

  it('调拨填了目标部门或目标项目之一即放行', () => {
    expect(transferTargetError('transfer', 'dept-1', '')).toBeNull();
    expect(transferTargetError('transfer', '', 'proj-1')).toBeNull();
    expect(transferTargetError('transfer', 'dept-1', 'proj-1')).toBeNull();
  });

  it('非调拨类型即使没填目标也不报错', () => {
    expect(transferTargetError('receive', '', '')).toBeNull();
    expect(transferTargetError('scrap', null, null)).toBeNull();
  });
});

describe('资产变更：表单 → DTO', () => {
  it('空字符串目标转 undefined（否则 uuid 校验会拒掉空串）', () => {
    const dto = buildAssetChangeDto({
      assetId: 'a-1',
      changeType: 'receive',
      targetDepartmentId: '',
      targetProjectId: '',
      afterValue: '',
      remark: '',
    });
    expect(dto).toEqual({
      assetId: 'a-1',
      changeType: 'receive',
      targetDepartmentId: undefined,
      targetProjectId: undefined,
      afterValue: undefined,
      remark: undefined,
    });
  });

  it('调拨时透传目标部门/项目', () => {
    const dto = buildAssetChangeDto({
      assetId: 'a-1',
      changeType: 'transfer',
      targetDepartmentId: 'dept-1',
      targetProjectId: 'proj-1',
      afterValue: '调拨到研发部',
      remark: '备注',
    });
    expect(dto.targetDepartmentId).toBe('dept-1');
    expect(dto.targetProjectId).toBe('proj-1');
    expect(dto.afterValue).toBe('调拨到研发部');
    expect(dto.remark).toBe('备注');
  });
});
