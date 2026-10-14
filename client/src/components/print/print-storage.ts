import type { PrintDocumentKind, PrintOffset, PrintPreference } from '@shared/api.interface';

/**
 * C-06 套打偏移持久化。
 *
 * 沿用仓库既有约定（`Layout.tsx` 的 `erp-sidebar-collapsed`、`SettingsPage` 的
 * `erp-density`）：单个 `erp-*` 前缀键 + `window.localStorage` 裸读写，
 * 不引入新的 storage 抽象层。
 *
 * 键：`erp-print-pref:{kind}` → `{"topMm":0,"leftMm":0,"overlay":false}`
 */
const KEY_PREFIX = 'erp-print-pref:';

/** 套打偏移允许范围（mm）：超出 A4 可打印区域的值一定是误填 */
export const PRINT_OFFSET_LIMIT_MM = 50;

export const DEFAULT_PRINT_OFFSET: PrintOffset = {
  topMm: 0,
  leftMm: 0,
  overlay: false,
};

function keyOf(kind: PrintDocumentKind): string {
  return `${KEY_PREFIX}${kind}`;
}

/** 把任意输入收敛成合法偏移量，避免脏 localStorage 把内容挤出纸张 */
export function normalizePrintOffset(input: Partial<PrintOffset> | null | undefined): PrintOffset {
  const clamp = (value: unknown): number => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    const bounded = Math.min(PRINT_OFFSET_LIMIT_MM, Math.max(-PRINT_OFFSET_LIMIT_MM, numeric));
    // 保留一位小数，与输入框 step=0.5 的手感一致
    return Math.round(bounded * 10) / 10;
  };
  return {
    topMm: clamp(input?.topMm),
    leftMm: clamp(input?.leftMm),
    overlay: Boolean(input?.overlay),
  };
}

/**
 * 读取某单据类型的打印偏好。
 * localStorage 不可用（隐私模式/配额满）或内容损坏时静默回落默认值——
 * 打印设置读不出来不该阻塞打印本身。
 */
export function readPrintPreference(kind: PrintDocumentKind): PrintPreference {
  const fallback: PrintPreference = { kind, offset: DEFAULT_PRINT_OFFSET };
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(keyOf(kind));
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;
    const candidate = parsed as Partial<PrintOffset>;
    return { kind, offset: normalizePrintOffset(candidate) };
  } catch {
    return fallback;
  }
}

/**
 * 写入某单据类型的打印偏好。
 * @returns 写入是否成功（失败时调用方提示"设置无法保存"，但不阻塞本次打印）
 */
export function writePrintPreference(preference: PrintPreference): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(
      keyOf(preference.kind),
      JSON.stringify(normalizePrintOffset(preference.offset)),
    );
    return true;
  } catch {
    return false;
  }
}
