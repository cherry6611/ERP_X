import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * B14（§7.2）：审计日志的 `statusBefore` **不得再硬编码为 null**。
 *
 * ## 被钉死的缺陷
 *
 * 原实现写死 `statusBefore: null`，于是审计日志只能回答"改成了什么状态"，
 * 答不了"从什么状态改过来的"。合规审计要重建的是一条**状态迁移轨迹**
 * （draft → submitted → approved），只有终点没有起点，这条链就是断的。
 *
 * ## 为什么用"源码断言"而不是行为测试
 *
 * 拦截器依赖 Nest 的 `ExecutionContext` / `CallHandler` / RxJS 管道。
 * 为它起一套 Nest 测试容器来断言"某一列不再是 null"，
 * 成本远高于收益，而且**测不到最容易出错的那一点** ——
 * 真正的风险是"有人后来把它改回 null"（因为那是更省事的写法）。
 *
 * 因此这里做两件事：
 *   ① 直接断言源码里不再出现 `statusBefore: null`；
 *   ② 断言推断表存在且覆盖了本仓的核心状态机动作名 ——
 *      覆盖表被删空时测试会红，而不是静默退回"全部 null"。
 *
 * 这是**回归锁**，不是行为验证；行为部分由真实请求在运行期产生。
 */
const INTERCEPTOR = join(
  __dirname,
  '..',
  '..',
  '..',
  'server',
  'modules',
  'audit',
  'audit.interceptor.ts',
);

describe('B14 审计日志 statusBefore 推断', () => {
  const source = readFileSync(INTERCEPTOR, 'utf8');

  it('拦截器源码里不得再出现硬编码的 statusBefore: null', () => {
    // 允许注释里提到它（说明历史），但不允许出现在实际赋值里
    const assignments = source
      .split(/\r?\n/u)
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .filter((line) => /statusBefore\s*:\s*null/u.test(line));
    expect(assignments).toEqual([]);
  });

  it('存在状态推断表，且覆盖本仓核心状态机动作', () => {
    // 这些动作名来自 AGENTS.md 描述的状态机与各 service 的 `action` 枚举
    const required = [
      'submit',
      'approve',
      'reject',
      'void',
      'close',
      'complete',
      'confirm',
      'post',
    ];
    const missing = required.filter(
      (action) => !new RegExp(`^\\s*${action}:\\s*\\[`, 'mu').test(source),
    );
    expect(missing).toEqual([]);
  });

  it('推断表用的是"合法前置状态数组"，而不是把 after 当 before', () => {
    // 反例防线：如果有人在推断表里写 `submit: ['submitted']`，
    // 那就是把"目标状态"当成了"前置状态" —— 审计轨迹会变成
    // "submitted → submitted"，看起来有值、实际是错的，比 null 更难发现。
    expect(source).toMatch(/submit:\s*\[\s*'draft'/u);
    expect(source).toMatch(/confirm:\s*\[\s*'submitted'/u);
    // 明确不允许自反（前置 = 后置）的写法出现在核心动作上
    expect(source).not.toMatch(/submit:\s*\[\s*'submitted'/u);
    expect(source).not.toMatch(/approve:\s*\[\s*'approved'/u);
  });
});
