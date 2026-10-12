import { isAllowedFeishuUrl, stripDisallowedUrls } from './feishu-url';

describe('feishu url allowlist', () => {
  it('allows https feishu hosts', () => {
    expect(isAllowedFeishuUrl('https://example.feishu.cn/docx/abc')).toBe(true);
    expect(isAllowedFeishuUrl('https://feishu.cn/drive/folder/x')).toBe(true);
  });

  it('rejects other schemes and hosts', () => {
    expect(isAllowedFeishuUrl('http://example.feishu.cn/a')).toBe(false);
    expect(isAllowedFeishuUrl('https://evil.feishu.cn.attacker.com/a')).toBe(false);
    expect(isAllowedFeishuUrl('javascript:alert(1)')).toBe(false);
  });

  it('strips disallowed urls from notification text', () => {
    const text = stripDisallowedUrls(
      '请看 https://phish.example/a 和 https://a.feishu.cn/docx/1'
    );
    expect(text).toContain('[链接已移除]');
    expect(text).toContain('https://a.feishu.cn/docx/1');
  });
});
