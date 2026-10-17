import {
  AUDIT_CSV_COLUMNS,
  escapeCsvCell,
  formatAuditTime,
  toAuditCsv,
} from './audit-csv';
import type { AuditLog } from '@shared/api.interface';

function log(overrides: Partial<AuditLog> = {}): AuditLog {
  return {
    id: 'id-1',
    actor: 'anonymous',
    action: 'create',
    objectType: 'auth',
    objectId: null,
    objectCode: null,
    statusBefore: null,
    statusAfter: null,
    detail: null,
    createdAt: '2026-10-17T02:30:00.000Z',
    ...overrides,
  };
}

describe('audit-csv：单元格转义', () => {
  it('null / undefined → 空串', () => {
    expect(escapeCsvCell(null)).toBe('');
    expect(escapeCsvCell(undefined)).toBe('');
  });

  it('含逗号 / 引号 / 换行的值整体加引号，内部引号翻倍', () => {
    expect(escapeCsvCell('a,b')).toBe('"a,b"');
    expect(escapeCsvCell('say "hi"')).toBe('"say ""hi"""');
    expect(escapeCsvCell('line1\nline2')).toBe('"line1\nline2"');
  });

  it('普通值不加引号', () => {
    expect(escapeCsvCell('create')).toBe('create');
    expect(escapeCsvCell(123)).toBe('123');
  });

  it('⚠️ 公式注入：以 = + - @ 开头的值前置单引号（OWASP CSV Injection）', () => {
    expect(escapeCsvCell('=1+1')).toBe("'=1+1");
    expect(escapeCsvCell('+A1')).toBe("'+A1");
    expect(escapeCsvCell('-2')).toBe("'-2");
    expect(escapeCsvCell('@SUM(A1)')).toBe("'@SUM(A1)");
  });

  it('公式注入 + 逗号时，单引号在引号内部', () => {
    expect(escapeCsvCell('=HYPERLINK("http://x","y")')).toBe(
      '"\'=HYPERLINK(""http://x"",""y"")"'
    );
  });
});

describe('audit-csv：时间口径 = 业务时区 Asia/Shanghai', () => {
  it('UTC 深夜的时间戳要落到业务时区的次日（与界面同口径）', () => {
    // 2026-10-16T19:15:00Z → 上海 2026-10-17 03:15:00
    expect(formatAuditTime('2026-10-16T19:15:00.000Z')).toBe('2026-10-17 03:15:00');
  });

  it('UTC 白天 → 上海同日 +8 小时', () => {
    expect(formatAuditTime('2026-10-17T02:30:00.000Z')).toBe('2026-10-17 10:30:00');
  });

  it('非法时间串 → 空串（不抛异常，不让一行导出整体失败）', () => {
    expect(formatAuditTime('not-a-date')).toBe('');
  });

  it('格式固定为 YYYY-MM-DD HH:mm:ss（可机器解析）', () => {
    expect(formatAuditTime('2026-01-02T03:04:05.000Z')).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/
    );
  });
});

describe('audit-csv：整表导出', () => {
  it('表头顺序 = AUDIT_CSV_COLUMNS，且带 UTF-8 BOM（Excel 中文不乱码）', () => {
    const csv = toAuditCsv([]);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const header = csv.replace('\uFEFF', '').trim();
    expect(header).toBe(AUDIT_CSV_COLUMNS.map((c) => c.title).join(','));
  });

  it('每行 7 列，含 JSON detail 时列数不错位', () => {
    const csv = toAuditCsv([
      log({
        detail: '{"method":"POST","path":"/api/auth/login","body":{"a":1,"b":2}}',
        objectCode: 'CUS2026100001',
        statusBefore: 'draft',
        statusAfter: 'active',
      }),
    ]);
    const lines = csv.replace('\uFEFF', '').trim().split('\r\n');
    expect(lines).toHaveLength(2);
    // 末列（detail）被整体引号包裹：内部逗号不参与分列、内部引号已翻倍
    expect(lines[1].endsWith('}}"')).toBe(true);
    expect(lines[1]).toContain('""method""');
    expect(lines[1].startsWith('2026-10-17 10:30:00,anonymous,create,auth,')).toBe(true);
  });

  it('一条记录一行（detail 含换行时被引号包住，不裂成多行）', () => {
    const csv = toAuditCsv([log({ detail: 'a\nb' })]);
    const body = csv.replace('\uFEFF', '');
    expect(body.split('\r\n').filter((l) => l.length > 0)).toHaveLength(2);
  });

  it('导出为空集时只有表头一行', () => {
    const csv = toAuditCsv([]);
    expect(csv.replace('\uFEFF', '').split('\r\n').filter(Boolean)).toHaveLength(1);
  });
});
