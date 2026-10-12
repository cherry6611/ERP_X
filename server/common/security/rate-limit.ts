import { HttpException, HttpStatus } from '@nestjs/common';

const buckets = new Map<string, number[]>();

/** 进程内滑动窗口限速。多实例各自计数，仍能挡住单实例上的滥用。 */
export function consumeRate(
  key: string,
  limit: number,
  windowMs: number
): void {
  const now: number = Date.now();
  const recent: number[] = (buckets.get(key) ?? []).filter(
    (ts: number) => now - ts < windowMs
  );
  if (recent.length >= limit) {
    throw new HttpException(
      '操作过于频繁，请稍后再试',
      HttpStatus.TOO_MANY_REQUESTS
    );
  }
  recent.push(now);
  buckets.set(key, recent);
}
