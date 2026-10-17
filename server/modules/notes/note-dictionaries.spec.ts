import { NoteService } from './note.service';
import {
  NOTE_ACTIONS,
  NOTE_STATUSES,
  NOTE_TRANSITIONS,
  validateNoteAction,
} from '@server/common/tax/note-rules';

/**
 * 票据字典里的**动作前置状态**规格（本次缺陷修复的守卫）。
 *
 * ## 这个规格要拦的是什么
 *
 * 票据页的操作列只列"当前状态允许的动作"。原先前端自己写了一份过滤，
 * 只钉了 `endorse` / `discount`，其余落到 `return true` 兜底 ——
 * 于是**已背书 / 已贴现**的票据上出现一个「确认持有」按钮，
 * 而 `NOTE_TRANSITIONS.hold = ['received', 'held']`，点下去必然 400。
 *
 * 修法是让 `dictionaries()` 把 `allowedFrom` 一并下发，前端只做
 * `action.allowedFrom.includes(note.status)`。本规格钉住两件事：
 *
 *   ① `allowedFrom` 必须**逐条等于** `NOTE_TRANSITIONS[action]`
 *      （不是"看起来差不多"：顺序无关但集合必须相等）；
 *   ② 用它做的判定必须与权威校验函数 `validateNoteAction()` 在
 *      **全部 状态×动作 组合**上完全一致 —— 这正是前端按钮显隐所依赖的契约。
 *
 * `dictionaries()` 不碰数据库、不碰凭证服务（纯查表），故这里直接用空依赖构造：
 * 一旦将来它开始读库，本规格会立刻抛错而不是静默跳过。
 */
describe('票据字典 actions[].allowedFrom', () => {
  const service = new NoteService(null as never, null as never);
  const actions = service.dictionaries().actions;

  it('动作集合与契约一致（不重不漏）', () => {
    expect(actions.map((action) => action.value).sort()).toEqual(
      [...NOTE_ACTIONS].sort(),
    );
  });

  it('每个动作的 allowedFrom 与 NOTE_TRANSITIONS 元素级相等', () => {
    for (const action of actions) {
      expect({ action: action.value, allowedFrom: [...action.allowedFrom].sort() })
        .toEqual({
          action: action.value,
          allowedFrom: [...NOTE_TRANSITIONS[action.value]].sort(),
        });
    }
  });

  it('allowedFrom 里的状态都是合法枚举值，且不含终态', () => {
    for (const action of actions) {
      for (const status of action.allowedFrom) {
        expect(NOTE_STATUSES).toContain(status);
        expect(['settled', 'dishonored']).not.toContain(status);
      }
    }
  });

  it('用 allowedFrom 判定的结果与 validateNoteAction 在全部组合上一致（前端按钮显隐的依据）', () => {
    for (const status of NOTE_STATUSES) {
      for (const action of actions) {
        expect({
          status,
          action: action.value,
          allowed: action.allowedFrom.includes(status),
        }).toEqual({
          status,
          action: action.value,
          allowed: validateNoteAction(status, action.value).length === 0,
        });
      }
    }
  });

  it('已背书 / 已贴现的票据不再出现「确认持有」（原缺陷的回归断言）', () => {
    const hold = actions.find((action) => action.value === 'hold');
    expect(hold?.allowedFrom.includes('endorsed')).toBe(false);
    expect(hold?.allowedFrom.includes('discounted')).toBe(false);
    // 但到期收款与拒付必须保留（修复不能收得过窄）
    const settle = actions.find((action) => action.value === 'settle');
    const dishonor = actions.find((action) => action.value === 'dishonor');
    expect(settle?.allowedFrom.includes('endorsed')).toBe(true);
    expect(settle?.allowedFrom.includes('discounted')).toBe(true);
    expect(dishonor?.allowedFrom.includes('endorsed')).toBe(true);
    expect(dishonor?.allowedFrom.includes('discounted')).toBe(true);
  });

  it('allowedFrom 是副本：改写它不会污染 NOTE_TRANSITIONS', () => {
    const hold = actions.find((action) => action.value === 'hold');
    hold?.allowedFrom.push('endorsed');
    expect([...NOTE_TRANSITIONS.hold]).toEqual(['received', 'held']);
  });
});
