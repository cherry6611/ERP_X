/**
 * `tax-entity-form.ts` 的回归锁。
 *
 * 这里钉死的是**两个在界面上完全看不出来的缺陷**（详见模块文件头的机理说明）：
 *
 * ① 编辑纳税主体时带上 `code` → 服务端 `forbidNonWhitelisted` 把整次保存打成
 *    `400 code: property code should not exist`。实测：编辑弹窗里改任何字段都存不进去。
 * ② 城建税率填 `7%` → `Number('7%')` 是 `NaN` → `JSON.stringify` 把它变成 `null`
 *    → 服务端把 `null` 当"显式清空" → **已配置的城建税率被静默抹掉**，
 *    而界面提示"保存成功"。`7%` 恰好是界面提示引导用户写的形态。
 *
 * 两条都**不报错、不崩、typecheck/lint 全绿**，只有断言能拦。
 */
import { ALLOWED_RATES } from '@shared/tax';
import {
  allowedRatesFor,
  buildTaxEntityCreatePayload,
  buildTaxEntityUpdatePayload,
  parseUrbanMaintRate,
  type TaxEntityFormState,
} from './tax-entity-form';

const form = (over: Partial<TaxEntityFormState> = {}): TaxEntityFormState => ({
  code: 'TE001',
  name: '晟笙数据科技',
  uscc: '',
  taxpayerType: 'general',
  defaultOutputRate: 6,
  defaultInputRate: 6,
  vatFilingCycle: '',
  urbanMaintRate: '',
  vatExemptionEnabled: true,
  citSmallMicro: null,
  invoiceTitle: '',
  invoiceAddress: '',
  invoicePhone: '',
  invoiceBank: '',
  invoiceAccount: '',
  remark: '',
  ...over,
});

const core = {
  code: 'TE001',
  name: '晟笙数据科技',
  taxpayerType: 'general' as const,
  defaultOutputRate: 6,
  defaultInputRate: 6,
};

describe('parseUrbanMaintRate —— 城建税率必须先解析再提交', () => {
  it('留空 = 未配置（合法，返回 null），不是错误', () => {
    expect(parseUrbanMaintRate('')).toEqual({ ok: true, value: null });
    expect(parseUrbanMaintRate('   ')).toEqual({ ok: true, value: null });
  });

  it.each([
    ['7', 7],
    ['5', 5],
    ['1', 1],
    [' 7 ', 7],
    ['7.00', 7],
  ])('合法输入 %p → %p', (raw, value) => {
    expect(parseUrbanMaintRate(raw)).toEqual({ ok: true, value });
  });

  it.each([
    ['7%', '带百分号'],
    ['7％', '全角百分号'],
    ['0.07', '写成了小数'],
    ['3', '不在 1/5/7 档位内'],
    ['abc', '非数字'],
    ['7;;', '垃圾字符'],
    ['-7', '负数'],
  ])('非法输入 %p（%s）必须被拒绝 —— 否则会静默清空已配置值', (raw) => {
    const parsed = parseUrbanMaintRate(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.message).toMatch(/城建税率/);
  });

  it('绝不返回 NaN：ok 为真时 value 一定是 null 或有限数', () => {
    for (const raw of ['', '7', '7%', 'abc', 'NaN', 'Infinity', '1e3']) {
      const parsed = parseUrbanMaintRate(raw);
      if (parsed.ok) {
        expect(parsed.value === null || Number.isFinite(parsed.value)).toBe(true);
      }
    }
  });
});

describe('buildTaxEntity*Payload —— 编辑路径不得带 code', () => {
  const args = (over: Partial<TaxEntityFormState> = {}) => ({
    form: form(over),
    core,
    urbanMaintRate: 7 as number | null,
  });

  it('新建：带 code', () => {
    expect(buildTaxEntityCreatePayload(args()).code).toBe('TE001');
  });

  it('编辑：**不带 code**（带了会被 400 code: property code should not exist 整单拒绝）', () => {
    const payload = buildTaxEntityUpdatePayload(args());
    expect('code' in payload).toBe(false);
    // 除 code 外其它字段仍必须齐全 —— 否则会从"整单 400"退化成"静默丢字段"
    expect(payload.name).toBe('晟笙数据科技');
    expect(payload.taxpayerType).toBe('general');
    expect(payload.urbanMaintRate).toBe(7);
  });

  it('空串在契约里一律是 null（不能让 "" 落库）', () => {
    const payload = buildTaxEntityUpdatePayload(
      args({ uscc: '   ', remark: '', invoiceBank: '' }),
    );
    expect(payload.uscc).toBeNull();
    expect(payload.remark).toBeNull();
    expect(payload.invoiceBank).toBeNull();
    expect(payload.vatFilingCycle).toBeNull();
  });

  it('城建税率未配置时为 null（而不是 NaN / 0）', () => {
    const payload = buildTaxEntityUpdatePayload({
      ...args(),
      urbanMaintRate: null,
    });
    expect(payload.urbanMaintRate).toBeNull();
  });

  it('三态字段按原样透传：小微 null（未确认）不能被折叠成 false', () => {
    expect(
      buildTaxEntityUpdatePayload(args({ citSmallMicro: null })).citSmallMicro,
    ).toBeNull();
    expect(
      buildTaxEntityUpdatePayload(args({ citSmallMicro: true })).citSmallMicro,
    ).toBe(true);
  });

  it('申报周期原样透传 monthly / quarterly / null', () => {
    for (const cycle of ['monthly', 'quarterly', ''] as const) {
      const payload = buildTaxEntityUpdatePayload(args({ vatFilingCycle: cycle }));
      expect(payload.vatFilingCycle).toBe(cycle === '' ? null : cycle);
    }
  });
});

describe('allowedRatesFor —— 与后端 ALLOWED_RATES 同源', () => {
  it('一般纳税人 / 小规模各自返回 shared 中的档位', () => {
    expect(allowedRatesFor('general')).toBe(ALLOWED_RATES.general);
    expect(allowedRatesFor('small')).toBe(ALLOWED_RATES.small);
    // 5% 是两侧都有的交集档位（前端下拉的可用性判据）
    expect(ALLOWED_RATES.general).toContain(5);
    expect(ALLOWED_RATES.small).toContain(5);
  });
});
