import { oauthStateMatches } from './oauth-state';

describe('oauth state', () => {
  it('accepts an exact match', () => {
    expect(oauthStateMatches('abc', 'abc')).toBe(true);
  });

  it('rejects a missing or different state', () => {
    expect(oauthStateMatches(null, 'abc')).toBe(false);
    expect(oauthStateMatches('abc', 'abd')).toBe(false);
    expect(oauthStateMatches('abc', 'abcd')).toBe(false);
  });
});
