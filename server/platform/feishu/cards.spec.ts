import { approvalCard } from './cards';

describe('approval card', () => {
  it('keeps an official feishu link as a button', () => {
    const card = approvalCard('审批', '请查看 https://example.feishu.cn/docx/abc');
    const elements = card.elements as Array<{ tag: string }>;
    expect(elements.some((item) => item.tag === 'action')).toBe(true);
  });

  it('drops a non-feishu link', () => {
    const card = approvalCard('审批', '请查看 https://evil.example/phish');
    const elements = card.elements as Array<{ tag: string }>;
    expect(elements.some((item) => item.tag === 'action')).toBe(false);
    expect(JSON.stringify(card)).not.toContain('evil.example');
  });
});
