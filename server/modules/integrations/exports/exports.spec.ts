/**
 * C-07 异步导出：筛选参数校验与资源注册表单测（纯逻辑）。
 */
import { BadRequestException } from '@nestjs/common';
import {
  EXPORT_RESOURCES,
  describeFilters,
  getExportResource,
  validateFilters,
} from './export-resources';

describe('C-07 筛选说明', () => {
  it('无筛选时写明"全量导出"', () => {
    expect(describeFilters(EXPORT_RESOURCES.bank_statement, {})).toBe(
      '无筛选条件（全量导出）'
    );
  });

  it('有筛选时按登记顺序拼接中文说明', () => {
    expect(
      describeFilters(EXPORT_RESOURCES.bank_statement, {
        period: '2026-10',
        matchStatus: 'unmatched',
      })
    ).toBe('期间=2026-10；匹配状态=unmatched');
  });
});

describe('C-07 筛选参数校验', () => {
  it('未登记的键被忽略（防止构造任意查询）', () => {
    const filters = validateFilters(EXPORT_RESOURCES.bank_statement, {
      period: '2026-10',
      注入: 'x',
      page: 999,
    });
    expect(filters).toEqual({ period: '2026-10' });
  });

  it('空字符串视为未提供', () => {
    expect(
      validateFilters(EXPORT_RESOURCES.bank_statement, { period: '   ' })
    ).toEqual({});
  });

  it('枚举取值非法时 400（可读中文原因）', () => {
    try {
      validateFilters(EXPORT_RESOURCES.bank_statement, { matchStatus: 'unknown' });
      throw new Error('应当抛出 BadRequestException');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toContain('匹配状态');
    }
  });

  it('必填筛选缺失时 400（调节表必须给期间）', () => {
    try {
      validateFilters(EXPORT_RESOURCES.bank_reconciliation, {});
      throw new Error('应当抛出 BadRequestException');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toContain('期间');
    }
  });

  it('未登记的资源类型 400 并提示可选值', () => {
    try {
      getExportResource('unknown_resource');
      throw new Error('应当抛出 BadRequestException');
    } catch (error) {
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toContain('bank_statement');
    }
  });
});

describe('C-07 资源注册表', () => {
  it('四种资源均有列定义、取数函数与行数上限', () => {
    const types = Object.keys(EXPORT_RESOURCES).sort();
    expect(types).toEqual([
      'bank_account',
      'bank_reconciliation',
      'bank_statement',
      'bank_statement_unmatched',
    ]);
    for (const type of types) {
      const descriptor = getExportResource(type);
      expect(descriptor.columns.length).toBeGreaterThan(0);
      expect(typeof descriptor.load).toBe('function');
      expect(descriptor.maxRows).toBeGreaterThan(0);
      expect(descriptor.label.length).toBeGreaterThan(0);
    }
  });

  it('调节表导出包含恒等式断言与未达账项分区', () => {
    const labels = EXPORT_RESOURCES.bank_reconciliation.columns.map((item) => item.key);
    expect(labels).toContain('section');
    expect(labels).toContain('item');
    expect(labels).toContain('amount');
  });
});
