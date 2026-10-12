import { allowsRequest } from './guards';

describe('allowsRequest', () => {
  it('lets public routes through', () => {
    expect(allowsRequest({ isPublic: true, needLogin: true })).toBe('ok');
  });

  it('requires a user when login is marked', () => {
    expect(allowsRequest({ isPublic: false, needLogin: true })).toBe('unauthorized');
  });

  it('forbids a user missing the role', () => {
    expect(
      allowsRequest({
        isPublic: false,
        needLogin: true,
        userId: 'u',
        requiredRoles: ['admin'],
        userRoles: ['hr_manager'],
      }),
    ).toBe('forbidden');
  });

  it('allows a matching role', () => {
    expect(
      allowsRequest({
        isPublic: false,
        needLogin: true,
        userId: 'u',
        requiredRoles: ['admin', 'finance_viewer'],
        userRoles: ['finance_viewer'],
      }),
    ).toBe('ok');
  });
});
