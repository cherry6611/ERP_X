/**
 * `contract-form-model` 的规格：**新建与编辑的金额下限不同**这条规则。
 *
 * 这条规则值得单独钉住，因为它的反例是"功能坏掉但看起来正常"：
 * 若编辑沿用新建 schema，库里那些 0 元合同（报价单转合同、接口直建产生，
 * `erp_contract.amount` 默认值就是 0）打开弹窗后会立即显示
 * 「合同金额必须大于 0」的红字并**挡住提交** —— 使用者会以为是自己填错了，
 * 实际上是校验把合法存量数据当成了非法输入。
 */
import {
  contractSchema,
  editContractSchema,
  editFormDefaults,
  CREATE_FORM_DEFAULTS,
} from './contract-form-model';
import type { Contract } from '@shared/api.interface';

/** 满足必填的最小合法输入 */
const base = {
  name: '某合同',
  customerId: 'cust-1',
  billingModel: 'project',
  owner: '',
  paymentTerms: '',
  remark: '',
};

/** 造一份最小可用的合同行（只填断言会用到的字段） */
const contractRow = (over: Partial<Contract> = {}) =>
  ({
    id: 'c-1',
    code: 'CTR1',
    name: '某合同',
    customerId: 'cust-1',
    billingModel: 'project',
    amount: 0,
    taxRate: 6,
    taxEntityId: null,
    signDate: null,
    startDate: null,
    endDate: null,
    owner: null,
    paymentTerms: null,
    remark: null,
    ...over,
  }) as unknown as Contract;

describe('contractSchema（新建）', () => {
  it('金额 1 → 通过', () => {
    expect(contractSchema.safeParse({ ...base, amount: 1, taxRate: 6 }).success).toBe(true);
  });

  it('⚠️ 金额 0 → 拒绝（新建 0 元合同没有业务含义）', () => {
    const r = contractSchema.safeParse({ ...base, amount: 0, taxRate: 6 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message)).toContain('合同金额必须大于 0');
    }
  });

  it('税率必须是 VAT_RATES 里的档位', () => {
    expect(contractSchema.safeParse({ ...base, amount: 100, taxRate: 6 }).success).toBe(true);
    expect(contractSchema.safeParse({ ...base, amount: 100, taxRate: 7 }).success).toBe(false);
  });

  it('金额是字符串数字时按 coerce 转换（表单输入框给的是字符串）', () => {
    const r = contractSchema.safeParse({ ...base, amount: '1234.56', taxRate: '6' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.amount).toBe(1234.56);
  });
});

describe('editContractSchema（编辑）', () => {
  it('⚠️ 金额 0 → **通过**（这才是修好的那条：0 元合同是合法存量数据）', () => {
    const r = editContractSchema.safeParse({ ...base, amount: 0, taxRate: 6 });
    expect(r.success).toBe(true);
  });

  it('金额为负 → 拒绝', () => {
    const r = editContractSchema.safeParse({ ...base, amount: -1, taxRate: 6 });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message)).toContain('合同金额不能为负数');
    }
  });

  it('除金额下限外，其余校验与新建一致（名称必填 / 客户必选 / 税率白名单）', () => {
    expect(editContractSchema.safeParse({ ...base, name: '', amount: 100, taxRate: 6 }).success).toBe(false);
    expect(editContractSchema.safeParse({ ...base, customerId: '', amount: 100, taxRate: 6 }).success).toBe(false);
    expect(editContractSchema.safeParse({ ...base, amount: 100, taxRate: 7 }).success).toBe(false);
  });
});

describe('editFormDefaults（null → 控件语义）', () => {
  it('文本类字段 null → 空串（受控组件不能拿到 undefined）', () => {
    const d = editFormDefaults(contractRow({ owner: null, paymentTerms: null, remark: null, taxEntityId: null }));
    expect(d.owner).toBe('');
    expect(d.paymentTerms).toBe('');
    expect(d.remark).toBe('');
    expect(d.taxEntityId).toBe('');
  });

  it('日期类字段 null → undefined（DateField 用 undefined 表示"未选"）', () => {
    const d = editFormDefaults(contractRow({ signDate: null, startDate: null, endDate: null }));
    expect(d.signDate).toBeUndefined();
    expect(d.startDate).toBeUndefined();
    expect(d.endDate).toBeUndefined();
  });

  it('有值字段原样带出', () => {
    const d = editFormDefaults(contractRow({ owner: '张三', signDate: '2026-10-01', amount: 500, taxRate: 13 }));
    expect(d.owner).toBe('张三');
    expect(d.signDate).toBe('2026-10-01');
    expect(d.amount).toBe(500);
    expect(d.taxRate).toBe(13);
  });

  it('0 元合同能构造出可编辑的初值（端到端还原那个缺陷场景）', () => {
    const d = editFormDefaults(contractRow({ amount: 0 }));
    expect(d.amount).toBe(0);
    const r = editContractSchema.safeParse({ ...d, name: '改名后的合同' });
    expect(r.success).toBe(true);
  });
});

describe('CREATE_FORM_DEFAULTS', () => {
  it('默认税率 6%、默认计费模式 project，且不含日期（新建时不预填日期）', () => {
    expect(CREATE_FORM_DEFAULTS.taxRate).toBe(6);
    expect(CREATE_FORM_DEFAULTS.billingModel).toBe('project');
    expect(CREATE_FORM_DEFAULTS).not.toHaveProperty('signDate');
  });

  it('默认值本身通不过校验（金额 0 < 1），这是预期的：空表单就该提示未填', () => {
    const r = contractSchema.safeParse({ ...CREATE_FORM_DEFAULTS });
    expect(r.success).toBe(false);
  });
});
