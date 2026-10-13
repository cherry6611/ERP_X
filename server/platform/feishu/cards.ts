import { isAllowedFeishuUrl } from '@server/common/security/feishu-url';

export function approvalCard(title: string, content: string): Record<string, unknown> {
  const urls = content.match(/https:\/\/[^\s；]+/g) ?? [];
  const buttons = urls.filter((url) => isAllowedFeishuUrl(url)).slice(0, 3).map((url) => ({
    tag: 'button',
    text: { tag: 'plain_text', content: '打开' },
    type: 'primary',
    url,
  }));
  const text = content.replace(/https?:\/\/\S+/g, '').trim();
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: 'plain_text', content: title.slice(0, 80) } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: text || title } },
      ...(buttons.length > 0 ? [{ tag: 'action', actions: buttons }] : []),
    ],
  };
}
