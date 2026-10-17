import type { PostgresJsDatabase } from '@server/platform';
import { LedgersService } from './ledgers.service';

/**
 * 回归锁：`and()` 里的条件**不得**用 `sql\`\`` 表示"该条件不适用"。
 *
 * ## 为什么必须有这份测试
 *
 * `drizzle` 的 `sql\`\`` 会渲染成**空字符串**，而 `and()` 把它当成一个真实条件拼进
 * WHERE，于是产出 `... and v.period = $1 and v.status = 'posted' and )` ——
 * **SQL 语法错误**，PostgreSQL 直接报错。
 *
 * 实测事故：`GET /api/finance/year-end/preview`（年末结转预览）返回 **500**，
 * 因为它调用 `ledgers.trialBalance(period)` 时**不传** `taxEntityId`，
 * 而 `trialBalance` 当时写的正是 `taxEntityId ? sql\`...\` : sql\`\``。
 * 浏览器走查第 20 页命中该 500。
 *
 * 正确写法是 `undefined`（drizzle 会忽略）。
 *
 * 这份测试用**桩 db 捕获生成的 SQL 文本**，因此不需要真实数据库、秒级完成，
 * 且能直接断言"SQL 里没有悬空 AND"。同类缺陷（任何 `and()` 里 conditional 的
 * `sql\`\``）都会被这条模式抓住。
 */

/**
 * 把 drizzle 的 `SQL` 对象渲染成**可断言的条件文本**。
 *
 * 注意：`SQL` 实例上**没有** `toSQL()`（实测 `typeof cond.toSQL === 'undefined'`，
 * 它由更外层的 query builder 调用），因此这里直接走它的 `queryChunks`。
 * 列引用渲染为空串没关系 —— 本测试要断的是"有没有悬空 AND"，
 * 而不是列名（列名由 drizzle 负责，另有 `column-reference-audit` 覆盖）。
 */
function renderCondition(node: unknown): string {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(renderCondition).join('');
  if (typeof node === 'object') {
    const obj = node as { value?: unknown; queryChunks?: unknown[] };
    if (Array.isArray(obj.queryChunks)) {
      return obj.queryChunks.map(renderCondition).join('');
    }
    if ('value' in obj) return String(obj.value);
    return '';
  }
  return String(node);
}

/** 捕获 `where()` 传入的 SQL 条件并返回其渲染文本 */
function makeCapturingDb(): { db: PostgresJsDatabase; render: () => string } {
  let captured: unknown;
  const chain = {
    select: () => chain,
    from: () => chain,
    innerJoin: () => chain,
    where: (condition: unknown) => {
      captured = condition;
      // 让调用方拿到可索引的结果数组
      return Promise.resolve([{ debit: '0', credit: '0' }]);
    },
  };
  const db = chain as unknown as PostgresJsDatabase;
  return {
    db,
    render: () => {
      if (captured === undefined) throw new Error('未捕获到 SQL 条件');
      return renderCondition(captured);
    },
  };
}

describe('LedgersService.trialBalance —— and() 中不得出现空 SQL 条件', () => {
  it('不传纳税主体：生成的 WHERE 不含悬空 AND / 空条件', async () => {
    const { db, render } = makeCapturingDb();
    const service = new LedgersService(db);

    await service.trialBalance('2026-10');

    const text = render();
    expect(text).not.toMatch(/and\s*\)/i);
    expect(text).toContain('posted');
  });

  it('传纳税主体：条件被真正拼进 WHERE（修复不能把该分支弄丢）', async () => {
    const { db, render } = makeCapturingDb();
    const service = new LedgersService(db);

    await service.trialBalance('2026-10', 'e0000000-0000-4000-8000-000000000001');

    const text = render();
    expect(text).not.toMatch(/and\s*\)/i);
    expect(text).toContain('::uuid');
    expect(text).toContain('posted');
  });
});
