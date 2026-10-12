import { todayInShanghai } from './biz-date';

describe('todayInShanghai', () => {
  it('returns a Shanghai calendar date', () => {
    expect(todayInShanghai()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
