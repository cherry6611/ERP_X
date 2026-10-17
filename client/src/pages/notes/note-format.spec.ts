import { STATUS_TONE, TYPE_LABELS, money } from './note-format';
import { NOTE_STATUS_LABELS } from '@client/src/utils/biz-labels';
import type { NoteStatus, NoteType } from '@shared/api.interface';

/**
 * 票据页展示口径规格（§5.9 / F8）。
 *
 * ## 为什么这三样值得单测
 *
 * 它们原先都内联在 `NotesPage.tsx` 里，**改错在界面上看不出来**：
 *
 * · `money` 是这一页**所有金额的唯一出口**（票面、贴现息、到账额、备查簿金额）。
 *   少一位小数、丢千分位、把负数渲染错，页面照样渲染成功 —— 只是每个数字都
 *   长得"差不多对"。财务页的金额格式化出错等于账目不可读，必须逐值钉住。
 * · `STATUS_TONE` 与 `NOTE_STATUS_LABELS` 是**两张必须同步的表**：文案表缺键会显示
 *   英文码（`check:label-dict` 门禁已拦），底色表缺键则渲染出一个**没有底色的
 *   状态徽标**（浅灰字落在白底上，几乎看不见）—— 后者的门禁不存在，只能靠本规格。
 * · `TYPE_LABELS` 是"票面类型"列的取值来源，缺键时单元格直接空白。
 */

const ALL_STATUSES = [
  'received',
  'held',
  'endorsed',
  'discounted',
  'settled',
  'dishonored',
] as const;

const ALL_TYPES = ['bank', 'commercial'] as const;

/*
 * 编译期穷尽性守卫：契约（`shared/api.interface.ts`）新增状态值 / 类型值而这里的
 * 清单没跟上时，下面两行会**编译失败**（`Exclude<...>` 不再是 `never`）。
 * 没有它的话，清单少一项只会让断言"少覆盖一个值"，测试依旧全绿。
 */
type UnlistedStatus = Exclude<NoteStatus, (typeof ALL_STATUSES)[number]>;
type UnlistedType = Exclude<NoteType, (typeof ALL_TYPES)[number]>;
const _statusListExhaustive: UnlistedStatus extends never ? true : never = true;
const _typeListExhaustive: UnlistedType extends never ? true : never = true;

describe('票据金额格式化（money）', () => {
  it('固定两位小数 + 千分位（票据台账按票面原样列示，不带货币符号）', () => {
    expect(money(0)).toBe('0.00');
    expect(money(1000)).toBe('1,000.00');
    expect(money(1234567.891)).toBe('1,234,567.89');
    expect(money(12345678)).toBe('12,345,678.00');
  });

  it('负数保留负号（拒付/红冲场景）', () => {
    expect(money(-1234.5)).toBe('-1,234.50');
    expect(money(-0.5)).toBe('-0.50');
  });

  it('任何输入都是"千分位 + 恰好两位小数"，不会出现 1 位或 3 位小数', () => {
    const samples = [0, 0.5, 0.05, 1, 999.999, 1000, 100000000.005, -42];
    for (const value of samples) {
      expect(money(value)).toMatch(/^-?\d{1,3}(,\d{3})*\.\d{2}$/u);
    }
  });

  it('四舍五入到分（不是截断）', () => {
    expect(money(1.005)).toBe('1.01');
    expect(money(1.004)).toBe('1.00');
    /*
     * ⚠️ 已知平台行为（本次拆分未改动）：绝对值小于 1 分的负数四舍五入后
     * 输出 `-0.00`。本页所有金额来源（票面、贴现息、备查簿合计）都 `> 0`，
     * 故不可达；若将来出现负数金额入口，需要在这里补一个 `+0` 归一。
     */
    expect(money(-0.004)).toBe('-0.00');
  });
});

describe('票据状态底色（STATUS_TONE）', () => {
  it('契约里每个状态都有底色，不留空', () => {
    for (const status of ALL_STATUSES) {
      expect(STATUS_TONE[status]).toBeTruthy();
    }
  });

  it('底色表的键集合与文案表完全一致（两张表必须同步增删）', () => {
    expect(Object.keys(STATUS_TONE).sort()).toEqual(
      Object.keys(NOTE_STATUS_LABELS).sort(),
    );
  });

  it('键集合与契约状态枚举一致', () => {
    expect(Object.keys(STATUS_TONE).sort()).toEqual([...ALL_STATUSES].sort());
    expect(Object.keys(NOTE_STATUS_LABELS).sort()).toEqual(
      [...ALL_STATUSES].sort(),
    );
  });
});

describe('票据类型文案（TYPE_LABELS）', () => {
  it('银行承兑 / 商业承兑两个取值都有文案', () => {
    expect(TYPE_LABELS.bank).toBe('银行承兑');
    expect(TYPE_LABELS.commercial).toBe('商业承兑');
  });

  it('键集合与契约类型枚举一致', () => {
    expect(Object.keys(TYPE_LABELS).sort()).toEqual([...ALL_TYPES].sort());
  });
});
