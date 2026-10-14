import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CRON_BY_TRIGGER } from '@server/platform/cron-map';
import {
  applyMigrationChain,
  createPglite,
  loadMigrations,
  queryRows,
} from '@server/test/integration/pglite-harness';

// 本文件位于 server/modules/admin/，故仓库根需上溯三级
const REPO_ROOT = resolve(__dirname, '../../..');
const SERVER_DIR = join(REPO_ROOT, 'server');

/**
 * C-10 收口：自动化任务登记一致性。
 *
 * ## 为什么要专门测这个
 *
 * `AutomationConfigService.isEnabled()` 在表里**查不到 key 时默认返回 true** ——
 * 因此一个 cron handler 即使从未登记到 `comp_automation_config`，
 * 也会照常执行，只是**行政页上看不到它**，业务方无法停用/启用。
 *
 * 后果不是"少个开关"这么轻：业务方以为某个提醒已停用，实际每天早上都在发；
 * 或想停却找不到开关。本次实施 C-10 时才发现除它之外的 14 个 handler
 * **全都没登记**（建表迁移只建结构、无种子），行政页长期只显示 1 条。
 *
 * 这个 spec 把"声明了 trigger 就必须登记"变成可执行约束，
 * 避免以后新增 handler 时再次静默漏登记。
 */
function scanTriggerKeys(): string[] {
  const keys = new Set<string>();
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.endsWith('.spec.ts')) continue;
      const content = readFileSync(full, 'utf8');
      for (const match of content.matchAll(/@BindTrigger\(\s*'([^']+)'\s*\)/g)) {
        keys.add(match[1]);
      }
    }
  };
  walk(SERVER_DIR);
  return [...keys].sort();
}

describe('C-10 自动化任务登记一致性', () => {
  const triggerKeys = scanTriggerKeys();

  it('扫描到全部 @BindTrigger 声明（防止扫描逻辑本身失效导致空断言）', () => {
    // 若扫描返回空数组，后面的断言会"全绿但什么都没检查" —— 先锁住下限
    expect(triggerKeys.length).toBeGreaterThanOrEqual(15);
    expect(triggerKeys).toContain('contract_expiry_remind');
    expect(triggerKeys).toContain('ar_due_reminder_daily');
  });

  it('每个 @BindTrigger 键都在 cron-map 中登记了执行周期', () => {
    const missing = triggerKeys.filter((key) => !(key in CRON_BY_TRIGGER));
    expect(missing).toEqual([]);
  });

  it('cron-map 中的每个键都有对应的 @BindTrigger（无死配置）', () => {
    const declared = new Set(triggerKeys);
    const orphans = Object.keys(CRON_BY_TRIGGER).filter(
      (key) => !declared.has(key)
    );
    expect(orphans).toEqual([]);
  });

  describe('comp_automation_config 种子覆盖', () => {
    let db: Awaited<ReturnType<typeof createPglite>>;

    beforeAll(async () => {
      db = await createPglite();
      await applyMigrationChain(db, loadMigrations());
    }, 120_000);

    afterAll(async () => {
      await db?.close();
    });

    it('迁移链中每个 trigger 都有登记行（否则行政页看不到该任务）', async () => {
      const rows = await queryRows<{ task_key: string }>(
        db,
        `SELECT task_key FROM comp_automation_config`
      );
      const registered = new Set(rows.map((row) => row.task_key));
      const missing = triggerKeys.filter((key) => !registered.has(key));
      expect(missing).toEqual([]);
    });

    it('登记行都有可读中文名称与说明（行政页要显示给业务方）', async () => {
      const problems: string[] = [];
      const rows = await queryRows<{
        task_key: string;
        task_name: string;
        description: string | null;
      }>(
        db,
        `SELECT task_key, task_name, description FROM comp_automation_config`
      );
      expect(rows.length).toBeGreaterThanOrEqual(triggerKeys.length);
      for (const row of rows) {
        if (!row.task_name || row.task_name.trim().length === 0) {
          problems.push(`${row.task_key}：task_name 为空`);
        }
        // 说明可以为空，但若有则不应是占位符（太短的多半是敷衍填写）
        if (row.description !== null && row.description.length <= 10) {
          problems.push(
            `${row.task_key}：description 过短（${row.description.length} 字），业务方看不懂这个任务是干什么的`
          );
        }
      }
      // 一次性断言全部问题：逐条断言会在第一个失败处停下，
      // 而这类登记遗漏往往是一批一起出现
      expect(problems).toEqual([]);
    });

    it('新增任务默认启用（与"未登记时默认 true"的既有行为一致，不改变运行时）', async () => {
      const rows = await queryRows<{ task_key: string; enabled: boolean }>(
        db,
        `SELECT task_key, enabled FROM comp_automation_config`
      );
      for (const row of rows) {
        expect(`${row.task_key}=${row.enabled}`).toBe(`${row.task_key}=true`);
      }
    });
  });
});
