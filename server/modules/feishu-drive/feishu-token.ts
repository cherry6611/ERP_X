let tokenInvalidator: (() => void) | null = null;

export function registerFeishuTokenInvalidator(fn: () => void): void {
  tokenInvalidator = fn;
}

export function invalidateFeishuToken(): void {
  tokenInvalidator?.();
}
