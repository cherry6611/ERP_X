/** Thin wrapper around window.confirm for destructive actions. */
export function confirmDanger(message: string): Promise<boolean> {
  return Promise.resolve(window.confirm(message));
}
