import type { Contract } from '@shared/api.interface';
import {
  buildContractUpdateDto,
  submitContractEdit,
  type ContractFormValues,
  type ContractWriteApi,
} from './contract-edit-model';

/**
 * 合同编辑提交模型规格（合同「编辑」入口落地同批）。
 *
 * ## 两条断言的分量
 *
 * ① **编辑必须走 `updateContract`、绝不走 `createContract`**：两个函数返回类型相同，
 *    写错了类型检查不会响，而后果是"点一次编辑多出一张合同"（且编号不复用，无法自愈）。
 *    这里用 spy 把它钉成事实。
 *
 * ② **只下发改动字段**：服务端对 `amount`/`customerId` 的守卫是「字段出现即拒」
 *    （非 draft 一律 400），不是"值变了才拒"。若编辑时把整份表单发上去，
 *    "改一个合同名称"也会被拒 400，提示还是"客户不可变更" —— 使用者无法理解。
 *
 * 下面 `makeContract()` 造的是**库中现值**，`makeValues()` 造的是**表单值**；
 * 两者默认完全相同（= 使用者什么都没改）。
 */
function makeContract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: 'ctr-1',
    code: 'CTR2026100001',
    name: '数据治理服务合同',
    customerId: 'cus-1',
    customerName: '示例客户',
    billingModel: 'project',
    amount: 100000,
    taxRate: 6,
    taxEntityId: 'ent-1',
    status: 'draft',
    signDate: '2026-10-01',
    startDate: '2026-10-01',
    endDate: '2027-09-30',
    owner: '张三',
    paymentTerms: '验收后 30 天',
    remark: '首年',
    createdAt: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeValues(overrides: Partial<ContractFormValues> = {}): ContractFormValues {
  const target = makeContract();
  return {
    name: target.name,
    customerId: target.customerId,
    billingModel: target.billingModel,
    amount: target.amount,
    taxRate: target.taxRate,
    taxEntityId: target.taxEntityId ?? '',
    signDate: target.signDate ?? '',
    startDate: target.startDate ?? '',
    endDate: target.endDate ?? '',
    owner: target.owner ?? '',
    paymentTerms: target.paymentTerms ?? '',
    remark: target.remark ?? '',
    ...overrides,
  };
}

describe('buildContractUpdateDto', () => {
  it('什么都没改 → 空 DTO（调用方据此不发请求）', () => {
    expect(buildContractUpdateDto(makeValues(), makeContract())).toEqual({});
  });

  it('只改名称 → 只下发 name，绝不带上 customerId/amount', () => {
    const dto = buildContractUpdateDto(
      makeValues({ name: '数据治理服务合同（2026 修订）' }),
      makeContract(),
    );
    expect(dto).toEqual({ name: '数据治理服务合同（2026 修订）' });
    expect('customerId' in dto).toBe(false);
    expect('amount' in dto).toBe(false);
  });

  it('改客户 + 计费模式 + 签订日期 → 三者都下发（本轮解锁的三个字段）', () => {
    const dto = buildContractUpdateDto(
      makeValues({
        customerId: 'cus-2',
        billingModel: 'quantity',
        signDate: '2026-11-11',
      }),
      makeContract(),
    );
    expect(dto).toEqual({
      customerId: 'cus-2',
      billingModel: 'quantity',
      signDate: '2026-11-11',
    });
  });

  it('日期由有值变空 → 下发 null（清空），而不是干脆不发', () => {
    const dto = buildContractUpdateDto(
      makeValues({ signDate: '', startDate: undefined, endDate: undefined }),
      makeContract(),
    );
    expect(dto).toEqual({ signDate: null, startDate: null, endDate: null });
  });

  it('库中本来就没有日期、表单也是空 → 不下发（空与 null 是同一状态）', () => {
    const dto = buildContractUpdateDto(
      makeValues({ signDate: '', startDate: '', endDate: '' }),
      makeContract({ signDate: null, startDate: null, endDate: null }),
    );
    expect(dto).toEqual({});
  });

  it('文本字段由有值变空 → 下发空串（服务端按空串落库）', () => {
    const dto = buildContractUpdateDto(makeValues({ owner: '' }), makeContract());
    expect(dto).toEqual({ owner: '' });
  });

  it('金额与税率改动才下发', () => {
    expect(buildContractUpdateDto(makeValues({ amount: 120000 }), makeContract())).toEqual({
      amount: 120000,
    });
    expect(buildContractUpdateDto(makeValues({ taxRate: 13 }), makeContract())).toEqual({
      taxRate: 13,
    });
  });

  it('纳税主体清空（回"系统默认"）不下发 —— 已知限制，与新建路径行为一致', () => {
    const dto = buildContractUpdateDto(makeValues({ taxEntityId: '' }), makeContract());
    expect(dto).toEqual({});
  });

  it('不下发 milestones（里程碑有独立写入路径）', () => {
    const dto = buildContractUpdateDto(makeValues({ name: '改名' }), makeContract());
    expect('milestones' in dto).toBe(false);
  });

  it('非 draft 合同改一个不受限字段（付款条款）时，不会误带受限字段', () => {
    const dto = buildContractUpdateDto(
      makeValues({ paymentTerms: '结清后 7 天' }),
      makeContract({ status: 'active' }),
    );
    expect(dto).toEqual({ paymentTerms: '结清后 7 天' });
  });
});

describe('submitContractEdit', () => {
  function makeApi() {
    const createContract = jest.fn();
    const updateContract = jest.fn().mockResolvedValue(makeContract({ name: '新名称' }));
    const api: ContractWriteApi = { createContract, updateContract };
    return { api, createContract, updateContract };
  }

  it('编辑提交走 updateContract(id, dto)，**绝不调用 createContract**', async () => {
    const { api, createContract, updateContract } = makeApi();
    const target = makeContract();
    const result = await submitContractEdit(api, target, makeValues({ billingModel: 'framework' }));

    expect(createContract).not.toHaveBeenCalled();
    expect(updateContract).toHaveBeenCalledTimes(1);
    expect(updateContract).toHaveBeenCalledWith(target.id, { billingModel: 'framework' });
    expect(result.status).toBe('updated');
    expect(result.contract.name).toBe('新名称');
  });

  it('没有任何改动 → 一个请求都不发（返回 unchanged）', async () => {
    const { api, createContract, updateContract } = makeApi();
    const target = makeContract();
    const result = await submitContractEdit(api, target, makeValues());

    expect(createContract).not.toHaveBeenCalled();
    expect(updateContract).not.toHaveBeenCalled();
    expect(result.status).toBe('unchanged');
    expect(result.contract).toBe(target);
  });

  it('updateContract 抛错时原样上抛（由调用方 toast 中文原因），不吞异常', async () => {
    const { api, updateContract } = makeApi();
    updateContract.mockRejectedValueOnce(new Error('合同已生效，客户不可变更'));
    await expect(
      submitContractEdit(api, makeContract({ status: 'active' }), makeValues({ customerId: 'cus-2' })),
    ).rejects.toThrow('合同已生效，客户不可变更');
  });
});
