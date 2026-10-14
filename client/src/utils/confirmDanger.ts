import { requestConfirm } from '@client/src/components/confirm-bridge';

/**
 * 危险操作二次确认。
 * 有 ConfirmProvider 时走 AlertDialog；否则回退 window.confirm。
 */
export function confirmDanger(
  message: string,
  options?: { title?: string; confirmLabel?: string }
): Promise<boolean> {
  return requestConfirm(message, options);
}
