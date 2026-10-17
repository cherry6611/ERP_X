/**
 * `resolver-error-classification` 的规格。
 *
 * 这组断言防的是两类"静默"缺陷（见模块文件头）：
 *   · **漏报**：真实 DB 故障被当成"schema 未就绪"静默掉 → 整批凭证无主体落库，
 *     而日志里看不出发生过故障；
 *   · **误报**：把"schema 未就绪"当真实故障 → 每次调用刷 error，淹没真故障。
 *
 * 以及一个极易写错的实现细节：**SQLSTATE 藏在 cause 链里**，
 * 只读第一层 `error.code` 会永远取不到。
 */
import {
  SILENT_SCHEMA_SQLSTATES,
  extractPgCode,
  isSilentSchemaDegrade,
} from './resolver-error-classification';

/** 造一个第 n 层带 code 的异常链 */
const chainOf = (depth: number, code: string): unknown => {
  let node: { cause?: unknown; code?: string } = { code };
  for (let i = 0; i < depth; i += 1) node = { cause: node };
  return node;
};

describe('extractPgCode 沿 cause 链取码', () => {
  it('第一层就有 code', () => {
    expect(extractPgCode({ code: '42P01' })).toBe('42P01');
  });

  it('⚠️ code 在 cause 上（drizzle 包一层 DrizzleQueryError 的真实形态）', () => {
    expect(extractPgCode({ name: 'DrizzleQueryError', cause: { code: '42P01' } })).toBe('42P01');
  });

  it('⚠️ code 在多层 cause 深处', () => {
    expect(extractPgCode(chainOf(3, '42703'))).toBe('42703');
  });

  it('⚠️ 只认 SQLSTATE 形状：长/短的其它 code 一律返回 null', () => {
    /* 这些若被当成 SQLSTATE，分类就会走错分支 */
    expect(extractPgCode({ code: 'ECONNREFUSED' })).toBeNull();
    expect(extractPgCode({ code: '404' })).toBeNull();
    expect(extractPgCode({ code: '42P' })).toBeNull();
    expect(extractPgCode({ code: '42p01' })).toBeNull(); // 小写不合法
    expect(extractPgCode({ code: 42_001 })).toBeNull(); // 数字不是 string
  });

  it('取不到 / 非对象 / null / undefined → null（不抛）', () => {
    expect(extractPgCode(null)).toBeNull();
    expect(extractPgCode(undefined)).toBeNull();
    expect(extractPgCode('boom')).toBeNull();
    expect(extractPgCode(42)).toBeNull();
    expect(extractPgCode({})).toBeNull();
  });

  it('⚠️ 循环 cause 链不死循环（深度上限 5）', () => {
    const a: { cause?: unknown; code?: string } = {};
    const b: { cause?: unknown } = { cause: a };
    a.cause = b; // 互相引用
    expect(extractPgCode(a)).toBeNull();
  });

  it('第一层就是合法 SQLSTATE 时，不再往 cause 深处找（取最近的）', () => {
    expect(extractPgCode({ code: '23505', cause: { code: '42P01' } })).toBe('23505');
  });
});

describe('isSilentSchemaDegrade 分类', () => {
  it('42P01（表不存在）与 42703（列不存在）可静默', () => {
    expect(isSilentSchemaDegrade({ code: '42P01' })).toBe(true);
    expect(isSilentSchemaDegrade({ code: '42703' })).toBe(true);
    expect(SILENT_SCHEMA_SQLSTATES).toEqual(['42P01', '42703']);
  });

  it('⚠️ 真实故障**不可**静默（否则整批凭证无主体落库而无人知）', () => {
    for (const code of ['08006', '28P01', '57014', '42601', '23505', '40001']) {
      expect(isSilentSchemaDegrade({ code })).toBe(false);
    }
  });

  it('⚠️ 取不到 code 时**不可**静默（fail-loud 而不是 fail-silent）', () => {
    expect(isSilentSchemaDegrade(new Error('socket hang up'))).toBe(false);
    expect(isSilentSchemaDegrade(null)).toBe(false);
    expect(isSilentSchemaDegrade({ code: 'ECONNREFUSED' })).toBe(false);
  });

  it('嵌在 cause 链里的 42P01 也能被识别为可静默', () => {
    expect(isSilentSchemaDegrade(chainOf(2, '42P01'))).toBe(true);
  });

  it('嵌在 cause 链里的真实故障码不可静默', () => {
    expect(isSilentSchemaDegrade(chainOf(2, '08006'))).toBe(false);
  });
});
