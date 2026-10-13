import { nextRetryDelaySec } from './retry';

describe('sync retry', () => {
  it('backs off and stops after five attempts', () => {
    expect(nextRetryDelaySec(0)).toBe(60);
    expect(nextRetryDelaySec(1)).toBe(300);
    expect(nextRetryDelaySec(4)).toBe(21600);
    expect(nextRetryDelaySec(5)).toBeNull();
  });
});
