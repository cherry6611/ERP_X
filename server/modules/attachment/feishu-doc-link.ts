/**
 * 飞书云文档链接解析（可扩展）。
 * path 段 → 开放平台 doc_type 映射，新增类型只需追加条目。
 */

export interface FeishuDocPathRef {
  /** 开放平台 metas API 的 doc_type */
  docType: string;
  token: string;
  /** URL 路径段，如 docx / sheets */
  pathKind: string;
}

/** URL 路径关键字 → 飞书 drive meta doc_type */
const PATH_TO_DOC_TYPE: Array<{ path: string; docType: string }> = [
  { path: 'docx', docType: 'docx' },
  { path: 'docs', docType: 'doc' },
  { path: 'doc', docType: 'doc' },
  { path: 'sheets', docType: 'sheet' },
  { path: 'sheet', docType: 'sheet' },
  { path: 'base', docType: 'bitable' },
  { path: 'bitable', docType: 'bitable' },
  { path: 'wiki', docType: 'wiki' },
  { path: 'file', docType: 'file' },
  { path: 'mindnotes', docType: 'mindnote' },
  { path: 'mindnote', docType: 'mindnote' },
  { path: 'slides', docType: 'slides' },
  { path: 'presentation', docType: 'slides' },
];

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,}$/;

export const FEISHU_DOC_TYPE_LABELS: Record<string, string> = {
  docx: '新版文档',
  doc: '旧版文档',
  sheet: '电子表格',
  bitable: '多维表格',
  wiki: '知识库',
  file: '云空间文件',
  mindnote: '思维笔记',
  slides: '幻灯片',
};

export function parseFeishuDocUrl(raw: string): FeishuDocPathRef {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error('链接格式无效，请粘贴完整的 https:// 飞书链接');
  }
  if (url.protocol !== 'https:') {
    throw new Error('飞书链接必须使用 https://');
  }
  const host = url.hostname.toLowerCase();
  const isFeishu =
    host === 'feishu.cn' ||
    host === 'larksuite.com' ||
    host === 'larkoffice.com' ||
    host.endsWith('.feishu.cn') ||
    host.endsWith('.larksuite.com') ||
    host.endsWith('.larkoffice.com');
  if (!isFeishu) {
    throw new Error('仅支持飞书 / Lark 域名的云文档链接');
  }

  const segments = url.pathname.split('/').filter(Boolean);
  for (let i = 0; i < segments.length - 1; i += 1) {
    const pathKey = segments[i].toLowerCase();
    const mapped = PATH_TO_DOC_TYPE.find((m) => m.path === pathKey);
    if (!mapped) continue;
    const token = segments[i + 1]?.split(/[?#]/)[0] ?? '';
    if (!TOKEN_PATTERN.test(token)) {
      throw new Error(`未能从链接中识别有效的 ${mapped.docType} token`);
    }
    return {
      docType: mapped.docType,
      token,
      pathKind: pathKey,
    };
  }

  throw new Error(
    '无法识别飞书文档类型。请确认链接包含 /docx/、/sheets/、/wiki/、/base/、/file/、/mindnotes/、/slides/ 等路径',
  );
}

export function feishuDocTypeLabel(docType: string): string {
  return FEISHU_DOC_TYPE_LABELS[docType] ?? docType;
}
