const DELAYS_SEC = [60, 300, 1800, 7200, 21600];

export function nextRetryDelaySec(retryCount: number): number | null {
  if (retryCount >= DELAYS_SEC.length) return null;
  return DELAYS_SEC[retryCount];
}
