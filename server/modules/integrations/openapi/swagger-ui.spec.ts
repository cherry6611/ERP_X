/**
 * C-12 Swagger UI 访问保护单测：默认不挂载，启用时必须登录（Basic）。
 */
import { buildSwaggerHtml, isSwaggerAuthorized, parseBasicAuth, safeCompare } from './swagger-ui';

function basic(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

describe('C-12 Swagger UI 访问保护', () => {
  it('未启用时一律拒绝（默认不暴露）', () => {
    expect(
      isSwaggerAuthorized({
        enabled: false,
        expectedUser: 'ops',
        expectedPassword: 'secret',
        header: basic('ops', 'secret'),
      })
    ).toBe(false);
  });

  it('启用但未配置凭据时拒绝（避免裸暴露）', () => {
    expect(
      isSwaggerAuthorized({
        enabled: true,
        expectedUser: '',
        expectedPassword: '',
        header: basic('', ''),
      })
    ).toBe(false);
    expect(
      isSwaggerAuthorized({
        enabled: true,
        expectedUser: 'ops',
        expectedPassword: '',
        header: basic('ops', ''),
      })
    ).toBe(false);
  });

  it('凭据正确才放行；错误密码/用户名拒绝', () => {
    const base = { enabled: true, expectedUser: 'ops', expectedPassword: 'secret' };
    expect(isSwaggerAuthorized({ ...base, header: basic('ops', 'secret') })).toBe(true);
    expect(isSwaggerAuthorized({ ...base, header: basic('ops', 'wrong') })).toBe(false);
    expect(isSwaggerAuthorized({ ...base, header: basic('other', 'secret') })).toBe(false);
    expect(isSwaggerAuthorized({ ...base, header: undefined })).toBe(false);
    expect(isSwaggerAuthorized({ ...base, header: 'Bearer token' })).toBe(false);
  });

  it('Basic 头解析：非法格式返回 null', () => {
    expect(parseBasicAuth(basic('a', 'b:c'))).toEqual({ user: 'a', password: 'b:c' });
    expect(parseBasicAuth('Basic ')).toBeNull();
    expect(parseBasicAuth('Basic ' + Buffer.from('nocolon').toString('base64'))).toBeNull();
    expect(parseBasicAuth(undefined)).toBeNull();
  });

  it('safeCompare 长度不同也返回 false（不抛异常）', () => {
    expect(safeCompare('abc', 'abc')).toBe(true);
    expect(safeCompare('abc', 'abcd')).toBe(false);
    expect(safeCompare('', '')).toBe(true);
  });

  it('UI 页面的 spec 地址与页面同源（避免指向公网示例）', () => {
    const html = buildSwaggerHtml('/api-docs/openapi.json');
    expect(html).toContain('"/api-docs/openapi.json"');
    expect(html).toContain('/api-docs/assets/swagger-ui-bundle.js');
    expect(html).not.toContain('petstore.swagger.io');
  });
});
