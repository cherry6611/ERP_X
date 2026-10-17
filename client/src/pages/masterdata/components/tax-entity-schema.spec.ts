/**
 * `tax-entity-schema` 的规格：纳税主体表单的税率档位校验。
 *
 * 这组断言的价值在于**把监管口径钉住**：一般纳税人与小规模的可选税率档位不同，
 * 改错档位表（例如把 1% 放进一般纳税人）在界面上完全看不出来，
 * 只会在报税时暴露。断言直接引用 `shared/tax.ts` 的 `ALLOWED_RATES`，
 * 所以档位表若被改动，这里的用例会**跟着失败**而不是一起漂移。
 */
import { ALLOWED_RATES } from '@shared/tax';
import { EMPTY_TAX_ENTITY_FORM, taxEntitySchema } from './tax-entity-schema';

const base = { code: 'TE01', name: '测试主体' };

const parse = (over: Record<string, unknown>) =>
  taxEntitySchema.safeParse({ ...base, taxpayerType: 'general', defaultOutputRate: 6, defaultInputRate: 6, ...over });

const messages = (r: ReturnType<typeof parse>) =>
  r.success ? [] : r.error.issues.map((i) => i.message);

describe('taxEntitySchema', () => {
  it('一般纳税人 + 6%/6% → 通过', () => {
    expect(parse({}).success).toBe(true);
  });

  it('小规模 + 1%/1% → 通过', () => {
    expect(parse({ taxpayerType: 'small', defaultOutputRate: 1, defaultInputRate: 1 }).success).toBe(true);
  });

  it('⚠️ 一般纳税人 + 1% → 拒绝（1% 只属于小规模档位）', () => {
    const r = parse({ taxpayerType: 'general', defaultOutputRate: 1, defaultInputRate: 1 });
    expect(r.success).toBe(false);
    expect(messages(r)).toContain('销项税率不在允许范围内');
  });

  it('⚠️ 小规模 + 13% → 拒绝（13% 只属于一般纳税人档位）', () => {
    const r = parse({ taxpayerType: 'small', defaultOutputRate: 13, defaultInputRate: 13 });
    expect(r.success).toBe(false);
    expect(messages(r)).toContain('销项税率不在允许范围内');
  });

  it('⚠️ 进项税率同样受校验（漏掉这一支就能随便填）', () => {
    const r = parse({ defaultOutputRate: 6, defaultInputRate: 99 });
    expect(r.success).toBe(false);
    expect(messages(r)).toContain('进项税率不在允许范围内');
  });

  it('销项合法、进项非法 → 只报进项那条（两条分支互不干扰）', () => {
    const r = parse({ defaultOutputRate: 6, defaultInputRate: 99 });
    expect(messages(r)).not.toContain('销项税率不在允许范围内');
    expect(messages(r)).toContain('进项税率不在允许范围内');
  });

  it('税率错误的 path 必须指向对应字段（否则错误显示不到输入框旁）', () => {
    const r = parse({ defaultInputRate: 99 });
    expect(r.success).toBe(false);
    if (!r.success) {
      const issue = r.error.issues.find((i) => i.message === '进项税率不在允许范围内');
      expect(issue?.path).toEqual(['defaultInputRate']);
    }
  });

  it('编码/名称只有空白 → 按必填拒绝（trim 后判空）', () => {
    expect(messages(parse({ code: '   ' }))).toContain('编码不能为空');
    expect(messages(parse({ name: '   ' }))).toContain('名称不能为空');
  });

  it('纳税人类型非法 → 按枚举拒绝', () => {
    expect(messages(parse({ taxpayerType: 'x' }))).toContain('请选择纳税人类型');
  });

  it('档位表本身：general 与 small 的可选档位不同（这条一旦不成立，上面的用例就失去意义）', () => {
    expect(ALLOWED_RATES.general).not.toEqual(ALLOWED_RATES.small);
    expect(ALLOWED_RATES.small).toContain(1);
    expect(ALLOWED_RATES.general).not.toContain(1);
  });

  it('空表单初值：三态字段 citSmallMicro 必须是 null（未确认 ≠ 不享受）', () => {
    expect(EMPTY_TAX_ENTITY_FORM.citSmallMicro).toBeNull();
    expect(EMPTY_TAX_ENTITY_FORM.taxpayerType).toBe('general');
    expect(EMPTY_TAX_ENTITY_FORM.vatFilingCycle).toBe('');
    expect(EMPTY_TAX_ENTITY_FORM.urbanMaintRate).toBe('');
    for (const [k, v] of Object.entries(EMPTY_TAX_ENTITY_FORM)) {
      expect(v).not.toBeUndefined();
      expect(k).toBeTruthy();
    }
  });
});
