import { BiMetricsService } from './bi-metrics.service';
import type { BiMetric } from '@shared/api.interface';

/**
 * D-12 指标中心的口径与结构断言。
 *
 * 这里不连数据库（那属于集成测试的职责），而是把**指标治理规则**固化下来：
 * 如果以后有人新增指标却忘了写口径说明、或者把下钻链接指向不存在的页面，
 * 测试会立刻失败。指标中心最容易腐化的地方正是这两点。
 */
describe('D-12 BI 指标注册表', () => {
  const metrics = BiMetricsService.METRICS;

  it('至少提供 10 个经营指标', () => {
    expect(metrics.length).toBeGreaterThanOrEqual(10);
  });

  it('指标 key 唯一（重复 key 会让订阅与下钻错位）', () => {
    const keys = metrics.map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('每个指标都有可读中文口径说明（不能只有名称）', () => {
    for (const metric of metrics) {
      expect(metric.formula.length).toBeGreaterThan(10);
      // 口径必须是中文描述，而不是英文标识符
      expect(/[\u4e00-\u9fff]/.test(metric.formula)).toBe(true);
    }
  });

  it('每个指标都有单位', () => {
    for (const metric of metrics) {
      expect(metric.unit.length).toBeGreaterThan(0);
    }
  });

  it('下钻链接只指向仓库中真实存在的前端路由', () => {
    // 与 client/src/app.tsx 的路由表保持一致；新增页面时同步更新此白名单
    const knownRoutes = new Set([
      '/revenue',
      '/costs',
      '/finance',
      '/projects',
      '/bi/metrics',
    ]);
    for (const metric of metrics) {
      if (metric.drillUrl === null) continue;
      expect(knownRoutes.has(metric.drillUrl)).toBe(true);
    }
  });

  it('覆盖需求书 D-12 要求的核心口径（毛利/回款/周转/超预算）', () => {
    const keys = new Set(metrics.map((item) => item.key));
    for (const required of [
      'revenue',
      'cost',
      'gross_profit',
      'gross_margin',
      'receipt_rate',
      'ar_turnover_days',
      'over_budget_projects',
      'unpaid_ap',
    ]) {
      expect(keys.has(required)).toBe(true);
    }
  });

  it('毛利率与应收周转天数的口径里写明了除零处理（否则页面会出现 NaN）', () => {
    const margin = metrics.find((item) => item.key === 'gross_margin');
    const turnover = metrics.find((item) => item.key === 'ar_turnover_days');
    expect(margin?.formula).toContain('0');
    expect(turnover?.formula).toContain('0');
  });
});

describe('D-12 指标返回结构', () => {
  it('BiMetric 字段齐备（key/name/value/unit/formula/drillUrl/previousValue）', () => {
    // 类型层面的保护：若 shared 契约删字段，这里会编译失败
    const sample: BiMetric = {
      key: 'revenue',
      name: '营业收入',
      value: 0,
      unit: '元',
      formula: '口径说明',
      drillUrl: '/revenue',
      previousValue: null,
    };
    expect(Object.keys(sample).sort()).toEqual([
      'drillUrl',
      'formula',
      'key',
      'name',
      'previousValue',
      'unit',
      'value',
    ]);
  });
});
