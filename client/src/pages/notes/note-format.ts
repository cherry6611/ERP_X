/**
 * 票据页的展示口径（§5.9 / F8）。
 *
 * ## 为什么从 `NotesPage.tsx` 搬到这里
 *
 * 三块内容都是**零 React 依赖的纯声明 / 纯函数**：状态底色、类型文案、金额格式化。
 * 它们原先占住页面主文件开头 26 行 —— 打开 `NotesPage.tsx` 先看到一叠声明才看到
 * 组件。搬走后立刻变成**可单测**的（`note-format.spec.ts`）。
 *
 * 其中 `money` 是这一页**所有金额的唯一出口**：它少一位小数、丢了千分位、
 * 或把负数渲染成 `-0.00`，页面上都不会报错，只是每个数字都长得"差不多对"，
 * 肉眼极难发现 —— 这类函数必须能被逐值断言。
 *
 * ## `money` 为什么不直接用 `utils/format.ts` 的 `formatMoney`
 *
 * 两者**不是同一个口径**：`formatMoney` 带货币符号（`style: 'currency'` →
 * `¥1,000.00`），而票据台账按票面原样列示（`1,000.00`）。统一过去会改动页面上
 * 每一个金额的文案，属于**可见变更**，故这里只搬家、不改口径。
 */
import type { NoteStatus, NoteType } from '@shared/api.interface';
import type * as notesApi from '@client/src/api/notes';

/** 状态底色。与 `utils/biz-labels.ts` 的 `NOTE_STATUS_LABELS` 配套使用 */
export const STATUS_TONE: Record<NoteStatus, string> = {
  received: 'bg-slate-100 text-slate-700',
  held: 'bg-sky-100 text-sky-700',
  endorsed: 'bg-violet-100 text-violet-700',
  discounted: 'bg-amber-100 text-amber-800',
  settled: 'bg-emerald-100 text-emerald-700',
  dishonored: 'bg-rose-100 text-rose-700',
};

/**
 * 票据类型文案。
 *
 * ⚠️ 与后端 `NOTE_TYPE_LABELS`（`server/common/tax/note-rules.ts`）**有意不同**：
 * 后端文案带"汇票"二字（银行承兑汇票），本页表格列窄，用短版。
 */
export const TYPE_LABELS: Record<NoteType, string> = {
  bank: '银行承兑',
  commercial: '商业承兑',
};

/** 金额：千分位 + 固定两位小数。票据页所有金额的唯一出口 */
export function money(value: number): string {
  return value.toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * `GET /api/notes/dictionaries` 的返回类型。
 *
 * 从 API 签名**派生**而不是手抄一份形状：字典改了字段，这里自动跟随。
 * 手抄的形状会在字典扩展时静默漂移（tsc 不报错，只是新字段用不上）。
 */
export type NoteDictionaries = Awaited<
  ReturnType<typeof notesApi.getNoteDictionaries>
>;
