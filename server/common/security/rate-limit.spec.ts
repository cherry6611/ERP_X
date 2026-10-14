import { HttpException } from '@nestjs/common';
import { consumeRate, resetRateLimitBuckets } from './rate-limit';

describe('consumeRate', () => {
  beforeEach(() => {
    resetRateLimitBuckets();
  });

  it('allows requests under the limit', async () => {
    await expect(consumeRate('k1', 3, 60_000)).resolves.toBeUndefined();
    await expect(consumeRate('k1', 3, 60_000)).resolves.toBeUndefined();
    await expect(consumeRate('k1', 3, 60_000)).resolves.toBeUndefined();
  });

  it('blocks when the sliding window is exceeded', async () => {
    await consumeRate('k2', 2, 60_000);
    await consumeRate('k2', 2, 60_000);
    await expect(consumeRate('k2', 2, 60_000)).rejects.toBeInstanceOf(
      HttpException,
    );
  });

  it('drops empty buckets instead of retaining keys forever', async () => {
    jest.useFakeTimers();
    const now = Date.now();
    jest.setSystemTime(now);
    await consumeRate('ephemeral', 5, 1000);
    jest.setSystemTime(now + 2000);
    await expect(consumeRate('ephemeral', 5, 1000)).resolves.toBeUndefined();
    jest.useRealTimers();
  });
});
