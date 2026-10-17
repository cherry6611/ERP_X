import {
  EMPTY_DATASET_FORM,
  datasetSchema,
  toCreateDatasetDto,
  toDatasetFormValues,
  toUpdateDatasetDto,
  type DatasetFormData,
} from './dataset-form';
import type { DatasetItem } from '@shared/api.interface';

/**
 * 数据集表单映射的回归测试（PATCH 三态 + 清空不被丢弃）。
 *
 * 定位与 `dataset-patch.spec.ts`（服务端判据）配对：
 * 那两个文件合起来才完整覆盖一次"改关联合同"的往返 ——
 * 前端发得对不对、服务端收得对不对。
 */

const CONTRACT_A = '11111111-1111-4111-8111-111111111111';
const CONTRACT_B = '22222222-2222-4222-8222-222222222222';

function form(overrides: Partial<DatasetFormData> = {}): DatasetFormData {
  return { ...EMPTY_DATASET_FORM, name: '数据集', ...overrides };
}

function datasetItem(overrides: Partial<DatasetItem> = {}): DatasetItem {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    code: 'DS2026100001',
    name: '数据集',
    source: null,
    maskLevel: 'L1',
    contractId: null,
    contractName: null,
    status: 'active',
    remark: null,
    createdAt: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

describe('toUpdateDatasetDto：PATCH 三态', () => {
  it('选了合同 → 发出该 UUID', () => {
    const dto = toUpdateDatasetDto(form({ contractId: CONTRACT_A }));
    expect(dto.contractId).toBe(CONTRACT_A);
  });

  it('清空（选「不关联」）→ 发出**显式 null**，而不是缺键', () => {
    const dto = toUpdateDatasetDto(form({ contractId: '' }));
    expect(dto.contractId).toBeNull();
    /*
     * 关键断言：键必须真的存在。
     * `contractId: undefined` 会被 JSON.stringify 整键丢掉 → 服务端判为"未提供"
     * → 解除关联静默失效（这正是本模块头部注释描述的缺陷形态）。
     */
    expect(Object.keys(dto)).toContain('contractId');
    expect(JSON.parse(JSON.stringify(dto))).toHaveProperty('contractId', null);
  });

  it('换绑到另一个合同 → 目标 id 随之改变', () => {
    expect(toUpdateDatasetDto(form({ contractId: CONTRACT_A })).contractId).toBe(
      CONTRACT_A
    );
    expect(toUpdateDatasetDto(form({ contractId: CONTRACT_B })).contractId).toBe(
      CONTRACT_B
    );
  });

  it('source / remark 原样发出（含空串），清空不被丢弃', () => {
    const dto = toUpdateDatasetDto(form({ source: '', remark: '' }));
    expect(dto.source).toBe('');
    expect(dto.remark).toBe('');
    expect(Object.keys(dto)).toEqual(
      expect.arrayContaining(['source', 'remark'])
    );
  });

  it('name 必填字段照常发出', () => {
    const dto = toUpdateDatasetDto(form({ name: '新名字' }));
    expect(dto.name).toBe('新名字');
  });
});

describe('toCreateDatasetDto：新建没有清除语义', () => {
  it('空串一律折成 undefined（不传即不关联/不填写）', () => {
    const dto = toCreateDatasetDto(form({ source: '', maskLevel: '', remark: '' }));
    expect(dto.source).toBeUndefined();
    expect(dto.maskLevel).toBeUndefined();
    expect(dto.contractId).toBeUndefined();
    expect(dto.remark).toBeUndefined();
  });

  it('填了合同 → 发出该 UUID', () => {
    expect(toCreateDatasetDto(form({ contractId: CONTRACT_B })).contractId).toBe(
      CONTRACT_B
    );
  });

  it('新建与更新的 contractId 语义确实不同（空表单）', () => {
    const empty = form({ contractId: '' });
    // 新建：缺键（JSON 里没有该字段）
    expect(
      JSON.parse(JSON.stringify(toCreateDatasetDto(empty)))
    ).not.toHaveProperty('contractId');
    // 更新：显式 null（清除）
    expect(JSON.parse(JSON.stringify(toUpdateDatasetDto(empty)))).toHaveProperty(
      'contractId',
      null
    );
  });
});

describe('toDatasetFormValues：列表项 → 表单值', () => {
  it('null 关联合同归一成空串（对应下拉的「不关联」项）', () => {
    expect(toDatasetFormValues(datasetItem({ contractId: null })).contractId).toBe(
      ''
    );
  });

  it('null 的来源/备注归一成空串', () => {
    const values = toDatasetFormValues(
      datasetItem({ source: null, remark: null })
    );
    expect(values.source).toBe('');
    expect(values.remark).toBe('');
  });

  it('已有字段原样带入（编辑不丢值）', () => {
    const values = toDatasetFormValues(
      datasetItem({
        name: '客户主数据',
        source: 'CRM 导出',
        maskLevel: 'L3',
        contractId: CONTRACT_A,
        remark: '备注',
      })
    );
    expect(values).toEqual({
      name: '客户主数据',
      source: 'CRM 导出',
      maskLevel: 'L3',
      contractId: CONTRACT_A,
      remark: '备注',
    });
  });

  it('往返一致：列表项 → 表单 → 更新 DTO 不改变合同关联', () => {
    const item = datasetItem({ contractId: CONTRACT_A });
    const values = toDatasetFormValues(item);
    expect(toUpdateDatasetDto(values).contractId).toBe(CONTRACT_A);
  });

  it('往返一致：无关联的数据集保存后仍是"清除"而非"缺席"', () => {
    const item = datasetItem({ contractId: null });
    const dto = toUpdateDatasetDto(toDatasetFormValues(item));
    expect(dto.contractId).toBeNull();
  });
});

describe('datasetSchema', () => {
  it('名称必填（空串报可读中文）', () => {
    const result = datasetSchema.safeParse(form({ name: '' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('请填写数据集名称');
    }
  });

  it('其余字段允许空串（空串有语义，不是"未填"）', () => {
    const result = datasetSchema.safeParse(
      form({ source: '', maskLevel: '', contractId: '', remark: '' })
    );
    expect(result.success).toBe(true);
  });
});
