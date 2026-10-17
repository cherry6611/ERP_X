/**
 * `grant-form` 的规格：授权表单的跨字段日期校验。
 *
 * 为什么值得为这 5 行判据写测试：**日期顺序校验是最容易写成"永远通过"或
 * "永远失败"的那类代码**（少了空值前置判断 → 只填一个日期就报错；
 * 写成 `>` → 当天授权被误拒）。这些分支在页面上要选日期+提交才走得到，
 * 而这里的断言是零成本的。
 */
import { EMPTY_GRANT_FORM, grantSchema } from './grant-form';

const base = { ...EMPTY_GRANT_FORM, datasetId: 'ds-1' };

describe('grantSchema 日期顺序校验', () => {
  it('两日期都为空 → 只报"请选择"而**不报**顺序错误', () => {
    const r = grantSchema.safeParse(base);
    expect(r.success).toBe(false);
    const msgs = r.success ? [] : r.error.issues.map((i) => i.message);
    expect(msgs).toContain('请选择开始日期');
    expect(msgs).toContain('请选择结束日期');
    expect(msgs).not.toContain('结束日期不能早于开始日期');
  });

  it('只填开始日期 → 不报顺序错误（空值前置判断生效）', () => {
    const r = grantSchema.safeParse({ ...base, startDate: '2026-10-01' });
    const msgs = r.success ? [] : r.error.issues.map((i) => i.message);
    expect(msgs).not.toContain('结束日期不能早于开始日期');
  });

  it('只填结束日期 → 不报顺序错误', () => {
    const r = grantSchema.safeParse({ ...base, endDate: '2026-10-31' });
    const msgs = r.success ? [] : r.error.issues.map((i) => i.message);
    expect(msgs).not.toContain('结束日期不能早于开始日期');
  });

  it('结束 < 开始 → 报顺序错误且落到 endDate 字段', () => {
    const r = grantSchema.safeParse({
      ...base, startDate: '2026-10-31', endDate: '2026-10-01',
    });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.message === '结束日期不能早于开始日期');
      expect(issue).toBeDefined();
      expect(issue?.path).toEqual(['endDate']);
    }
  });

  it('结束 == 开始 → 合法（当天生效的授权必须放行）', () => {
    const r = grantSchema.safeParse({
      ...base, startDate: '2026-10-01', endDate: '2026-10-01',
    });
    expect(r.success).toBe(true);
  });

  it('结束 > 开始 → 合法', () => {
    const r = grantSchema.safeParse({
      ...base, startDate: '2026-10-01', endDate: '2026-10-31',
    });
    expect(r.success).toBe(true);
  });

  it('未选数据集 → 报"请选择数据集"', () => {
    const r = grantSchema.safeParse({ ...base, datasetId: '' });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.issues.map((i) => i.message)).toContain('请选择数据集');
    }
  });

  it('空表单初值全部是可绑定字符串（不能是 undefined，否则受控组件警告）', () => {
    for (const [key, value] of Object.entries(EMPTY_GRANT_FORM)) {
      expect(typeof value).toBe('string');
      expect(value).not.toBeUndefined();
      expect(key).toBeTruthy();
    }
  });
});
