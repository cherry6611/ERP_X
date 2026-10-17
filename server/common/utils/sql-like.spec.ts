/**
 * `sql-like` 的规格：`LIKE`/`ILIKE` 通配符转义（安全相关）。
 *
 * ## 为什么这个模块必须有 spec
 *
 * 它被 6 个模块用于模糊搜索（contracts / directory / hr-core / bank-account /
 * master-data / voucher），而**在此之前零覆盖**。写错的后果不是报错，是**静默放开**：
 *
 * | 写错的地方 | 后果 |
 * |---|---|
 * | 没转义 `%` | 传 `keyword='%'` → 模式 `%%%` → **匹配全表** |
 * | 没转义 `_` | 传 `_` → 匹配任意单字符 → **逐字符探测枚举** |
 * | `likeContains('')` 返回 `%%` 而非 `null` | 空搜索条件变成"匹配全表"——**正是原缺陷的形状** |
 * | 转义顺序错（先 `%` 后 `\`） | `\%` 被二次转义成 `\\%`，语义从"字面百分号"变成"字面反斜杠 + 通配符" |
 *
 * 前三条的报错方式是"数据被列出来"，第四条是"搜不到本该搜到的东西"——
 * 两者都不会抛异常，只能靠断言。
 *
 * ## 分两层验
 *
 * 1. **纯函数层**（多数断言）：转义结果逐字符确定，能完全覆盖。
 * 2. **SQL 层**（`ilikeEscaped`，用 pglite 真库）：因为
 *    `ESCAPE` 的转义符**必须走参数绑定**，写成字面量 `ESCAPE '\\'` 会被
 *    PostgreSQL 解析成"两个字符的反斜杠"→ `invalid escape string`。
 *    这条只在真实引擎上才暴露，纯单测测不出来（原实现注释称"pglite 实测复现"）。
 */
import { sql } from 'drizzle-orm';
import {
  LIKE_ESCAPE_CHAR,
  LIKE_KEYWORD_MAX_LENGTH,
  escapeLikePattern,
  ilikeEscaped,
  likeContains,
  likeStartsWith,
  normalizeLikeKeyword,
} from './sql-like';
import { createHarness, queryRows, type Harness } from '../../test/integration/pglite-harness';

describe('常量', () => {
  it('转义符是单个反斜杠', () => {
    expect(LIKE_ESCAPE_CHAR).toBe('\\');
    expect(LIKE_ESCAPE_CHAR).toHaveLength(1);
  });

  it('关键字上限 100（超长关键字让 `ILIKE %…%` 无法走索引、白耗 CPU）', () => {
    expect(LIKE_KEYWORD_MAX_LENGTH).toBe(100);
  });
});

describe('escapeLikePattern：通配符转义', () => {
  it('普通文本原样返回', () => {
    expect(escapeLikePattern('数据中台')).toBe('数据中台');
    expect(escapeLikePattern('CTR2026100001')).toBe('CTR2026100001');
  });

  it('⚠️ 转义 `%`（不转义会匹配全表）', () => {
    expect(escapeLikePattern('%')).toBe('\\%');
    expect(escapeLikePattern('100%')).toBe('100\\%');
    expect(escapeLikePattern('%%')).toBe('\\%\\%');
  });

  it('⚠️ 转义 `_`（不转义会被逐字符探测枚举）', () => {
    expect(escapeLikePattern('_')).toBe('\\_');
    expect(escapeLikePattern('a_b')).toBe('a\\_b');
  });

  it('转义反斜杠本身', () => {
    expect(escapeLikePattern('\\')).toBe('\\\\');
    expect(escapeLikePattern('a\\b')).toBe('a\\\\b');
  });

  it('⚠️ 转义顺序正确：先 `\\` 再 `%`/`_`', () => {
    /*
     * 若顺序反了（先转 % 再转 \），输入 `\%` 会：
     *   先 → `\\%`（把 % 转成 \%）
     *   再 → `\\\\%`（把每个 \ 各转成 \\，% 保持）
     * 语义变成"字面反斜杠 + 通配符"，而不是"字面百分号"。
     * 正确顺序下 `\%` → `\\\%`（字面反斜杠 + 字面百分号）。
     */
    expect(escapeLikePattern('\\%')).toBe('\\\\\\%');
    expect(escapeLikePattern('\\_')).toBe('\\\\\\_');
  });

  it('混合字符一次性转义', () => {
    expect(escapeLikePattern('a%b_c\\d')).toBe('a\\%b\\_c\\\\d');
  });

  it('空串返回空串（不构造通配符）', () => {
    expect(escapeLikePattern('')).toBe('');
  });

  it('Unicode / emoji 不受影响（只动 ASCII 三个元字符）', () => {
    expect(escapeLikePattern('😀测试%')).toBe('😀测试\\%');
  });

  it('幂等性检查：对已转义串再转义会再增加一层（这正是"只能转一次"的原因）', () => {
    const once = escapeLikePattern('50%');
    expect(once).toBe('50\\%');
    /* 再转一次 → 反斜杠也被转义，说明调用方**不得**重复转义 */
    expect(escapeLikePattern(once)).toBe('50\\\\\\%');
  });
});

describe('normalizeLikeKeyword：去空白 + 截断', () => {
  it('去首尾空白', () => {
    expect(normalizeLikeKeyword('  合同  ')).toBe('合同');
  });

  it('null / undefined → 空串', () => {
    expect(normalizeLikeKeyword(null)).toBe('');
    expect(normalizeLikeKeyword(undefined)).toBe('');
  });

  it('纯空白 → 空串（等价于"不构成搜索条件"）', () => {
    expect(normalizeLikeKeyword('   ')).toBe('');
    expect(normalizeLikeKeyword('\\t\\n ')).toBe('\\t\\n'); // 只去首尾，不删中间
  });

  it('截断到 100 字符', () => {
    const long = 'a'.repeat(150);
    expect(normalizeLikeKeyword(long)).toHaveLength(LIKE_KEYWORD_MAX_LENGTH);
    expect(normalizeLikeKeyword(long)).toBe('a'.repeat(100));
  });

  it('恰好 100 字符不截断', () => {
    expect(normalizeLikeKeyword('b'.repeat(100))).toHaveLength(100);
  });

  it('⚠️ 先截断后转义：满 100 个 `%` 会被转义成 200 字符的模式（不是 100）', () => {
    const pattern = likeContains('%'.repeat(150));
    expect(normalizeLikeKeyword('%'.repeat(150))).toHaveLength(100);
    /* 前后各一个 % 包裹 + 100 个已转义的 %（每个 2 字符） */
    expect(pattern).toBe(`%${'\\%'.repeat(100)}%`);
    expect(pattern).toHaveLength(202);
  });
});

describe('likeContains：包含匹配', () => {
  it('普通关键字 → `%关键字%`', () => {
    expect(likeContains('合同')).toBe('%合同%');
  });

  it('⚠️ 空 / null / 纯空白 → **null**（调用方据此跳过条件，而不是拿 `%%` 匹配全表）', () => {
    expect(likeContains('')).toBeNull();
    expect(likeContains('   ')).toBeNull();
    expect(likeContains(null)).toBeNull();
    expect(likeContains(undefined)).toBeNull();
  });

  it('⚠️ 通配符被转义而非保留', () => {
    expect(likeContains('%')).toBe('%\\%%');
    expect(likeContains('_')).toBe('%\\_%');
    /* 绝不能出现裸的 `%%%`（那会匹配全表） */
    expect(likeContains('%')).not.toBe('%%%');
  });

  it('去空白后再包裹', () => {
    expect(likeContains('  合同  ')).toBe('%合同%');
  });
});

describe('likeStartsWith：前缀匹配', () => {
  it('普通关键字 → `关键字%`', () => {
    expect(likeStartsWith('CTR')).toBe('CTR%');
  });

  it('空 → null', () => {
    expect(likeStartsWith('')).toBeNull();
    expect(likeStartsWith('  ')).toBeNull();
    expect(likeStartsWith(null)).toBeNull();
  });

  it('通配符被转义', () => {
    expect(likeStartsWith('a_')).toBe('a\\_%');
  });

  it('与 likeContains 的区别只在尾部星号', () => {
    expect(likeContains('x')).toBe('%x%');
    expect(likeStartsWith('x')).toBe('x%');
  });
});

describe('ilikeEscaped：SQL 层（pglite 真库）', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await createHarness();
  }, 180_000);

  afterAll(async () => {
    await h?.db?.close?.();
  });

  /** 建临时表并插入含通配符元字符的数据 */
  const setup = async () => {
    await h.db.exec(`
      CREATE TABLE IF NOT EXISTS tmp_like_probe (
        id serial PRIMARY KEY,
        name text NOT NULL
      );
      /*
       * ⚠️ 必须清空：本函数的每个用例都会调用（pglite 同一实例），
       * 若只 CREATE IF NOT EXISTS 而不清空，INSERT 会每个用例叠加一遍 ——
       * 我第一版就是这样，第 3 个用例起断言"命中 1 行"却得到 3 行。
       */
      TRUNCATE tmp_like_probe RESTART IDENTITY;
      INSERT INTO tmp_like_probe (name) VALUES
        ('100%达成'),
        ('100X达成'),
        ('a_b'),
        ('axb'),
        ('反斜杠\\样例'),
        ('普通文本');
    `);
  };

  const search = async (keyword: string) => {
    const pattern = likeContains(keyword);
    if (pattern === null) return [];
    /*
     * 用裸 SQL 还原 drizzle 的编译结果：把列换成表列名。
     * drizzle 的 `sql` 无法直接拼进 pglite 的 `query()`，所以这里
     * ① 先用 `ilikeEscaped` 拿到 SQL 对象（验证它可构造、不抛）
     * ② 再用等价的手写 SQL 验证 `ESCAPE` 的语义（模式与转义符都来自本模块）
     */
    const stmt = ilikeEscaped(sql.raw('name'), pattern);
    expect(stmt).toBeDefined();
    return queryRows<{ name: string }>(
      h.db,
      'SELECT name FROM tmp_like_probe WHERE name ILIKE $1 ESCAPE $2 ORDER BY id',
      [pattern, LIKE_ESCAPE_CHAR],
    );
  };

  it('⚠️ `%` 被当作字面量：搜 `%` 只命中真正含百分号的行，不匹配全表', async () => {
    await setup();
    const rows = await search('%');
    expect(rows.map((r) => r.name)).toEqual(['100%达成']);
  });

  it('⚠️ `_` 被当作字面量：搜 `a_b` 不会命中 `axb`', async () => {
    await setup();
    const rows = await search('a_b');
    expect(rows.map((r) => r.name)).toEqual(['a_b']);
  });

  it('反斜杠可被搜到（转义符自身也被转义）', async () => {
    await setup();
    const rows = await search('反斜杠\\');
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toContain('反斜杠');
  });

  it('普通文本正常命中', async () => {
    await setup();
    const rows = await search('普通');
    expect(rows.map((r) => r.name)).toEqual(['普通文本']);
  });

  it('空关键字不产生查询（返回空集，不返回全表）', async () => {
    await setup();
    const rows = await search('   ');
    expect(rows).toEqual([]);
  });

  it('⚠️ 若把转义符写成字面量 `ESCAPE \\\\` 会报 invalid escape string（这正是必须参数绑定的原因）', async () => {
    await setup();
    await expect(
      h.db.query("SELECT 1 FROM tmp_like_probe WHERE name ILIKE '%a%' ESCAPE '\\\\'"),
    ).rejects.toThrow(/invalid escape string/i);
  });
});
