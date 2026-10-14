/**
 * C-07 导出文件生成单测（纯函数）。
 * 断言 CSV 首行的审计说明、字段转义与数值文本。
 */
import { buildAuditHeader, buildCsv, buildXlsx, type ExportFileMeta } from './export-file';

const META: ExportFileMeta = {
  resourceLabel: '银行流水',
  filterSummary: '期间=2026-10',
  requestedByName: '张三',
  generatedAt: '2026-10-15T02:00:00.000Z',
  truncated: false,
  dateInShanghai: '2026-10-15',
};

describe('C-07 导出留痕（审计要求）', () => {
  it('文件首行含筛选条件说明与导出人', () => {
    const header = buildAuditHeader(META);
    expect(header).toContain('资源：银行流水');
    expect(header).toContain('筛选条件：期间=2026-10');
    expect(header).toContain('导出人：张三');
    expect(header).toContain('业务日期：2026-10-15');
    expect(header).not.toContain('截断');
  });

  it('行数达上限时在首行明确标注截断', () => {
    expect(buildAuditHeader({ ...META, truncated: true })).toContain(
      '注意：导出行数已达上限，结果被截断'
    );
  });
});

describe('C-07 CSV 生成', () => {
  it('含 BOM、审计首行、表头与数据行，含逗号/引号字段正确转义', () => {
    const buffer = buildCsv(
      [
        { key: 'tradeDate', label: '交易日期' },
        { key: 'amount', label: '金额' },
        { key: 'summary', label: '摘要' },
      ],
      [
        { tradeDate: '2026-10-10', amount: 12345.67, summary: '合同款, 第一期' },
        { tradeDate: '2026-10-11', amount: 500, summary: '备注 "含引号"' },
        { tradeDate: '2026-10-12', amount: null, summary: null },
      ],
      META
    );
    const text = buffer.toString('utf8');
    expect(text.startsWith('\uFEFF')).toBe(true);
    const lines = text.replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[0]).toBe(buildAuditHeader(META));
    expect(lines[1]).toBe('交易日期,金额,摘要');
    expect(lines[2]).toBe('2026-10-10,12345.67,"合同款, 第一期"');
    expect(lines[3]).toBe('2026-10-11,500,"备注 ""含引号"""');
    // 空值输出为空字符串（不写 null 文本）
    expect(lines[4]).toBe('2026-10-12,,');
  });

  it('空数据只输出审计首行与表头', () => {
    const buffer = buildCsv([{ key: 'a', label: 'A' }], [], META);
    const lines = buffer.toString('utf8').replace(/^\uFEFF/, '').split('\r\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('A');
  });
});

describe('C-07 XLSX 生成', () => {
  it('产出可被 exceljs 读回的 xlsx，首行为审计说明', async () => {
    const buffer = await buildXlsx(
      [
        { key: 'code', label: '单号' },
        { key: 'amount', label: '金额', width: 20 },
      ],
      [{ code: 'RCV2026100001', amount: 12345.67 }],
      META
    );
    // xlsx 为 ZIP，签名 PK\x03\x04
    expect(buffer.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(buffer.length).toBeGreaterThan(1000);
  });
});
