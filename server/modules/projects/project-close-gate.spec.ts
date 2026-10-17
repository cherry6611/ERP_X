import {
  CLOSE_SUMMARY_REQUIRED_MESSAGE,
  hasCloseSummary,
  normalizeCloseSummary,
} from './project-close-gate';

/**
 * 结项摘要判据规格。
 *
 * 缺陷的表征是"库里 `close_summary = '   '`"——界面上完全看不出来
 * （详情页确实显示了一段内容，只是它是空白），结项报告也照发。
 * 因此把每一种"看起来填了、其实没填"的输入都钉在这里。
 */
describe('normalizeCloseSummary', () => {
  it('正常摘要原样返回', () => {
    expect(normalizeCloseSummary('[API_TEST] 结项摘要')).toBe('[API_TEST] 结项摘要');
  });

  it('前后空白被去掉（落库值不带首尾空格）', () => {
    expect(normalizeCloseSummary('  验收通过  ')).toBe('验收通过');
  });

  it('null / undefined / 空串一律视为未填写', () => {
    expect(normalizeCloseSummary(null)).toBeNull();
    expect(normalizeCloseSummary(undefined)).toBeNull();
    expect(normalizeCloseSummary('')).toBeNull();
  });

  it('纯空白视为未填写（修复点：原判据只查真值，`\'   \'` 会被放行）', () => {
    expect(normalizeCloseSummary('   ')).toBeNull();
    expect(normalizeCloseSummary('\t\n\r')).toBeNull();
    expect(normalizeCloseSummary('\u3000\u3000')).toBeNull(); // 全角空格
  });
});

describe('hasCloseSummary', () => {
  it('闸门判据与归一化一致', () => {
    expect(hasCloseSummary('[API_TEST] 摘要')).toBe(true);
    expect(hasCloseSummary('   ')).toBe(false);
    expect(hasCloseSummary('')).toBe(false);
    expect(hasCloseSummary(null)).toBe(false);
    expect(hasCloseSummary(undefined)).toBe(false);
  });

  it('文案是可直接展示的中文，且不随调用点漂移', () => {
    expect(CLOSE_SUMMARY_REQUIRED_MESSAGE).toBe('结项须填写结项摘要');
  });
});
