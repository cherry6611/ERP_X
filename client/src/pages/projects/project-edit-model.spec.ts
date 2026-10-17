import {
  buildProjectUpdateDto,
  submitProjectEdit,
  type ProjectEditFormValues,
} from './project-edit-model';

/**
 * 「编辑项目」提交模型规格。
 *
 * 核心断言只有一句：**清空必须体现在下发的 DTO 里**。
 * 原实现 `values.pm || undefined` 会让 `pm: ''` 变成"字段缺失"，
 * 服务端于是按 PATCH 语义跳过它 —— 界面报成功、库里没变。
 */
const base: ProjectEditFormValues = {
  pm: '[API_TEST] 张经理',
  budget: 180000,
  estimatedTotalCost: 123456,
  progress: 40,
  endDate: '2026-12-31',
  remark: '[API_TEST] 备注',
  wonQuotationId: 'b6d1f0a2-0000-4000-8000-000000000001',
};

describe('buildProjectUpdateDto', () => {
  it('清空项目经理：必须下发空串，不得变成"字段缺失"', () => {
    const dto = buildProjectUpdateDto({ ...base, pm: '' });
    expect('pm' in dto).toBe(true);
    expect(dto.pm).toBe('');
  });

  it('清空备注：必须下发空串，不得变成"字段缺失"', () => {
    const dto = buildProjectUpdateDto({ ...base, remark: '' });
    expect('remark' in dto).toBe(true);
    expect(dto.remark).toBe('');
  });

  it('清空预计总成本：下发 0（数字列没有 null 通道）', () => {
    const dto = buildProjectUpdateDto({ ...base, estimatedTotalCost: undefined });
    expect('estimatedTotalCost' in dto).toBe(true);
    expect(dto.estimatedTotalCost).toBe(0);
  });

  it('预算为 0 时同样下发 0，不得被 `|| undefined` 吃掉', () => {
    const dto = buildProjectUpdateDto({ ...base, budget: 0 });
    expect('budget' in dto).toBe(true);
    expect(dto.budget).toBe(0);
    expect(buildProjectUpdateDto({ ...base, progress: 0 }).progress).toBe(0);
  });

  it('非空值原样透传', () => {
    expect(buildProjectUpdateDto(base)).toEqual({
      pm: base.pm,
      budget: 180000,
      estimatedTotalCost: 123456,
      progress: 40,
      endDate: '2026-12-31',
      remark: base.remark,
      wonQuotationId: base.wonQuotationId,
    });
  });

  it('清空成交报价单：下发 null（服务端显式清除），不是字段缺失', () => {
    const dto = buildProjectUpdateDto({ ...base, wonQuotationId: '' });
    expect('wonQuotationId' in dto).toBe(true);
    expect(dto.wonQuotationId).toBeNull();
    expect(buildProjectUpdateDto({ ...base, wonQuotationId: undefined }).wonQuotationId).toBeNull();
  });

  it('已知限制：清空结束日期仍会缺字段（需 shared 契约放宽为 string|null，本次范围外）', () => {
    const dto = buildProjectUpdateDto({ ...base, endDate: undefined });
    expect(dto.endDate).toBeUndefined();
  });
});

describe('submitProjectEdit', () => {
  it('只调用 updateProject（绝不能走新建），并把实际下发的 DTO 交回调用方', async () => {
    const calls: Array<{ id: string; dto: unknown }> = [];
    const api = {
      updateProject: async (id: string, dto: unknown) => {
        calls.push({ id, dto });
        return {};
      },
    };
    const dto = await submitProjectEdit(api, 'p-1', { ...base, pm: '', remark: '' });
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('p-1');
    expect(dto.pm).toBe('');
    expect(dto.remark).toBe('');
    expect(calls[0].dto).toEqual(dto);
  });
});
