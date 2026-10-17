/**
 * `report-check` 的规格：报表自查项的"差异"与"结论"必须同源。
 *
 * 这组断言防的是**报表自己打自己的脸**：
 * `difference` 显示"差异 ¥0.00"但 `passed=false`（使用者以为系统坏了），
 * 或者反过来 `difference` 非零却 `passed=true`（**把真实的不平当成了平** —— 更严重）。
 */
import { buildReportCheck, findInconsistentChecks, sameAmount } from './report-check';
import type { ReportCheck } from '@shared/api.interface';

describe('sameAmount（金额判等口径）', () => {
  it('相等金额判等', () => {
    expect(sameAmount(100, 100)).toBe(true);
    expect(sameAmount(0, 0)).toBe(true);
  });

  it('⚠️ 浮点累加噪声不算差异（0.1+0.2 vs 0.3）', () => {
    expect(0.1 + 0.2 === 0.3).toBe(false); // 原生 === 会被噪声骗到
    expect(sameAmount(0.1 + 0.2, 0.3)).toBe(true);
  });

  it('差 1 分判不等', () => {
    expect(sameAmount(100, 100.01)).toBe(false);
    expect(sameAmount(100.01, 100)).toBe(false);
  });

  it('负数方向同样可靠（红冲场景）', () => {
    expect(sameAmount(-100, -100)).toBe(true);
    expect(sameAmount(-100.01, -100)).toBe(false);
  });
});

describe('buildReportCheck：passed 由 difference 推导', () => {
  it('两侧相等 → difference 0、passed true', () => {
    const c = buildReportCheck({ code: 'x', label: '资产 = 负债 + 权益', left: 1000, right: 1000 });
    expect(c.difference).toBe(0);
    expect(c.passed).toBe(true);
  });

  it('两侧不等 → difference 是带符号差额、passed false', () => {
    const c = buildReportCheck({ code: 'x', label: '资产 = 负债 + 权益', left: 1000, right: 950.5 });
    expect(c.difference).toBe(49.5);
    expect(c.passed).toBe(false);
  });

  it('⚠️ 差额在一个"分"以内（舍入噪声）→ 判通过且 difference 为 0', () => {
    /* 这是报表最常见的场景：两侧各自累加后差 1e-12 */
    const c = buildReportCheck({
      code: 'x',
      label: '资产 = 负债 + 权益',
      left: 1000 + 1e-12,
      right: 1000,
    });
    expect(c.difference).toBe(0);
    expect(c.passed).toBe(true);
  });

  it('⚠️ 差 1 分就判不通过（不做"容差放行"）', () => {
    const c = buildReportCheck({ code: 'x', label: '资产 = 负债 + 权益', left: 1000.01, right: 1000 });
    expect(c.difference).toBe(0.01);
    expect(c.passed).toBe(false);
  });

  it('金额保留 2 位（left/right/difference 都过 round2）', () => {
    const c = buildReportCheck({ code: 'x', label: 'l', left: 1000.005, right: 999.9949 });
    expect(c.left).toBe(1000.01);
    expect(c.right).toBe(999.99);
    expect(c.difference).toBe(0.02);
  });

  it('负数差额（右侧更大）也正确', () => {
    const c = buildReportCheck({ code: 'x', label: 'l', left: 900, right: 1000 });
    expect(c.difference).toBe(-100);
    expect(c.passed).toBe(false);
  });

  it('字段完整（code / label / left / right / difference / passed 都在）', () => {
    const c = buildReportCheck({ code: 'balance_sheet_equation', label: '资产总计 = 负债和所有者权益总计', left: 1, right: 1 });
    for (const k of ['code', 'label', 'left', 'right', 'difference', 'passed'] as const) {
      expect(c[k]).not.toBeUndefined();
    }
    expect(c.code).toBe('balance_sheet_equation');
  });
});

describe('findInconsistentChecks：自洽性自检', () => {
  it('正常构造出的自查项全部自洽', () => {
    const checks = [
      buildReportCheck({ code: 'a', label: 'l', left: 100, right: 100 }),
      buildReportCheck({ code: 'b', label: 'l', left: 100, right: 99 }),
      buildReportCheck({ code: 'c', label: 'l', left: -5, right: -5 }),
    ];
    expect(findInconsistentChecks(checks)).toEqual([]);
  });

  it('⚠️ 抓出"差异 0 却判不通过"（使用者会以为系统坏了）', () => {
    const bogus: ReportCheck = {
      code: 'x', label: 'l', left: 100, right: 100, difference: 0, passed: false,
    };
    expect(findInconsistentChecks([bogus])).toHaveLength(1);
  });

  it('⚠️ 抓出"差异非零却判通过"（把真实的不平当成了平 —— 更严重）', () => {
    const bogus: ReportCheck = {
      code: 'x', label: 'l', left: 100, right: 90, difference: 10, passed: true,
    };
    expect(findInconsistentChecks([bogus])).toHaveLength(1);
  });

  it('difference 缺失按 0 处理（老接口兼容）', () => {
    const legacy = { code: 'x', label: 'l', left: 1, right: 1, passed: true } as ReportCheck;
    expect(findInconsistentChecks([legacy])).toEqual([]);
  });
});
