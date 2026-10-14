type ConfirmFn = (
  description: string,
  options?: { title?: string; confirmLabel?: string }
) => Promise<boolean>;

let impl: ConfirmFn = (description) =>
  Promise.resolve(window.confirm(description));

/** ConfirmProvider 注册后，全站 confirmDanger / useConfirm 走 AlertDialog */
export function setConfirmImpl(fn: ConfirmFn): void {
  impl = fn;
}

export function requestConfirm(
  description: string,
  options?: { title?: string; confirmLabel?: string }
): Promise<boolean> {
  return impl(description, options);
}
