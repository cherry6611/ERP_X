import { projectClosedWriteBlockReason } from './project-close-gate';

/**
 * 「项目已结项 → 写动作冻结」的判据规格。
 *
 * ## 为什么要有这条
 *
 * `deliverable.service.ts` 早已把 `assertProjectNotClosed` 抽成共用方法，
 * 并在注释里写明原实现的病因：**"只有 create 有这道校验，其余写动作都能绕过"** ——
 * 于是结项后仍能改交付物状态、让已发出的结项报告与实际不一致。
 *
 * 而 `updateProject`（项目主档：项目经理 / 预算 / 进度 / 预计总成本 / 结束日期 /
 * 备注 / 成交报价）**就是被漏掉的那一处**。使用者看到的是
 * `CloseProjectSection` 承诺的「结项后项目进入只读归档状态」，
 * 实际却能继续改，且**没有任何提示**。
 *
 * 判据本身只有一行判断，仍然抽出来配规格的理由与仓库其他 guard 模块一致：
 * 这类"漏一处"的判据必须能被逐状态断言，否则下次新增写动作时还会漏。
 */
describe('projectClosedWriteBlockReason', () => {
  it('已结项 → 返回可读中文，并指出下一步是"反结项"', () => {
    const reason = projectClosedWriteBlockReason('closed');
    expect(reason).not.toBeNull();
    expect(reason).toContain('结项');
    expect(reason).toContain('反结项');
  });

  it('其余任何状态都放行（含 null / undefined / 未知值）', () => {
    for (const status of [
      'initiating',
      'executing',
      'delivering',
      'accepting',
      'cancelled',
      'reopened',
      null,
      undefined,
      '',
    ]) {
      expect(projectClosedWriteBlockReason(status as string | null)).toBeNull();
    }
  });

  it('大小写与空白不构成绕过（判据按精确值比较，不做模糊匹配）', () => {
    // 'CLOSED' 不是库里的合法值；只有精确的 'closed' 才冻结。
    // 这条断言的作用是钉住"不要为了让测试好写而改成 includes/toLowerCase"——
    // 模糊匹配会把 'not_closed' 这类未来值也拦住。
    expect(projectClosedWriteBlockReason('CLOSED')).toBeNull();
    expect(projectClosedWriteBlockReason(' closed ')).toBeNull();
    expect(projectClosedWriteBlockReason('closed')).not.toBeNull();
  });
});
