import { inflateRawSync } from 'node:zlib';
import { round2 } from '@shared/number';

/** 从 OOXML ZIP 中读取单个条目 */
function readZipEntry(buf: Buffer, entryName: string): Buffer | null {
  let offset = 0;
  while (offset < buf.length - 30) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) {
      const next = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), offset + 1);
      if (next < 0) break;
      offset = next;
      continue;
    }
    const compression = buf.readUInt16LE(offset + 8);
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    const dataStart = offset + 30 + nameLen + extraLen;
    if (compSize === 0xffffffff || dataStart + compSize > buf.length) {
      offset = dataStart;
      continue;
    }
    const data = buf.subarray(dataStart, dataStart + compSize);
    if (name === entryName) {
      if (compression === 0) return Buffer.from(data);
      if (compression === 8) return inflateRawSync(data);
      return null;
    }
    offset = dataStart + compSize;
  }
  return null;
}

function listZipEntryNames(buf: Buffer): string[] {
  const names: string[] = [];
  let offset = 0;
  while (offset < buf.length - 30) {
    if (buf.readUInt32LE(offset) !== 0x04034b50) {
      const next = buf.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), offset + 1);
      if (next < 0) break;
      offset = next;
      continue;
    }
    const compSize = buf.readUInt32LE(offset + 18);
    const nameLen = buf.readUInt16LE(offset + 26);
    const extraLen = buf.readUInt16LE(offset + 28);
    const name = buf.subarray(offset + 30, offset + 30 + nameLen).toString('utf8');
    names.push(name);
    const dataStart = offset + 30 + nameLen + extraLen;
    if (compSize === 0xffffffff || dataStart + compSize > buf.length) break;
    offset = dataStart + compSize;
  }
  return names;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/g, (_, dec: string) =>
      String.fromCodePoint(Number.parseInt(dec, 10)),
    )
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

function stripXmlToText(xml: string): string {
  return decodeXmlEntities(
    xml
      .replace(/<\/w:p>/g, '\n')
      .replace(/<\/w:tr>/g, '\n')
      .replace(/<w:tab[^/]*\/>/g, '\t')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function extractTextFromDocxBuffer(buffer: Buffer): string | null {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) return null;
  const xmlBuf = readZipEntry(buffer, 'word/document.xml');
  if (!xmlBuf) return null;
  const text = stripXmlToText(xmlBuf.toString('utf8'));
  return text.length > 0 ? text : null;
}

function colLettersToIndex(col: string): number {
  let n = 0;
  for (let i = 0; i < col.length; i++) {
    const code = col.charCodeAt(i);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return Math.max(n - 1, 0);
}

function parseSharedStrings(xml: string): string[] {
  const result: string[] = [];
  const siRe = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m: RegExpExecArray | null;
  while ((m = siRe.exec(xml))) {
    const parts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) =>
      decodeXmlEntities(x[1]),
    );
    result.push(parts.join(''));
  }
  return result;
}

/** 解析仅含同行单元格乘积的公式，如 C2*E2*F2 → 用当前行已解析数值计算 */
function tryEvalSameRowProduct(formula: string, cells: string[]): string | null {
  const expr = formula.startsWith('=') ? formula.slice(1) : formula;
  if (!/^[A-Z]+\d+(?:\*[A-Z]+\d+)+$/.test(expr)) return null;
  const parts = expr.split('*');
  let product = 1;
  for (const part of parts) {
    const m = /^([A-Z]+)(\d+)$/.exec(part);
    if (!m) return null;
    const idx = colLettersToIndex(m[1]);
    const raw = cells[idx] ?? '';
    const num = Number(raw);
    if (!Number.isFinite(num)) return null;
    product *= num;
  }
  /*
   * 保留合理精度，避免浮点噪音。
   * ⚠️ 统一走共享 `round2`（原为内联 `Math.round(product * 100) / 100`）：
   * 报价单数值会与库里的行金额比对/回写，取整口径必须与其余模块同源。
   * 内联写法对负数（退货/冲减行的乘积）向 +∞ 取整，与 `round2` 的远离零取整
   * 相差 1 分，会让"文件里的数"与"库里的数"对不上。
   */
  return Number.isInteger(product) ? String(product) : String(round2(product));
}

function parseSheetRows(xml: string, shared: string[]): string[] {
  const rows: string[] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(xml))) {
    const rowXml = rowMatch[1];
    const cells: string[] = [];
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/g;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowXml))) {
      const attrs = cellMatch[1] ?? cellMatch[3] ?? '';
      const body = cellMatch[2] ?? '';
      const ref = /\br="([A-Z]+)(\d+)"/.exec(attrs);
      const colIdx = ref ? colLettersToIndex(ref[1]) : cells.length;
      while (cells.length < colIdx) cells.push('');

      const type = /\bt="([^"]+)"/.exec(attrs)?.[1] ?? '';
      let value = '';
      if (type === 'inlineStr') {
        const texts = [...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) =>
          decodeXmlEntities(x[1]),
        );
        value = texts.join('');
      } else if (type === 's') {
        const idx = Number(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        value = Number.isFinite(idx) ? (shared[idx] ?? '') : '';
      } else if (type === 'str' || type === 'b') {
        value = decodeXmlEntities(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (v != null && v !== '') {
          value = decodeXmlEntities(v);
        } else {
          const f = /<f[^>]*>([\s\S]*?)<\/f>/.exec(body)?.[1];
          if (f) value = `=${decodeXmlEntities(f)}`;
        }
      }
      cells[colIdx] = value;
    }
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].startsWith('=')) {
        const evaluated = tryEvalSameRowProduct(cells[i], cells);
        if (evaluated != null) cells[i] = evaluated;
      }
    }
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.some((c) => c.trim().length > 0)) {
      rows.push(cells.join('\t'));
    }
  }
  return rows;
}

/** 不依赖 exceljs：直接读 OOXML，兼容 inlineStr / 含绘图的 xlsx */
export function extractTextFromXlsxBuffer(buffer: Buffer): string | null {
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) return null;

  const sharedBuf = readZipEntry(buffer, 'xl/sharedStrings.xml');
  const shared = sharedBuf ? parseSharedStrings(sharedBuf.toString('utf8')) : [];

  const workbookBuf = readZipEntry(buffer, 'xl/workbook.xml');
  const sheetNames: string[] = [];
  if (workbookBuf) {
    const wb = workbookBuf.toString('utf8');
    for (const m of wb.matchAll(/<sheet\b[^>]*\bname="([^"]+)"[^>]*>/g)) {
      sheetNames.push(decodeXmlEntities(m[1]));
    }
  }

  const entryNames = listZipEntryNames(buffer);
  const sheetFiles = entryNames
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(n))
    .sort((a, b) => {
      const na = Number(/sheet(\d+)/i.exec(a)?.[1] ?? 0);
      const nb = Number(/sheet(\d+)/i.exec(b)?.[1] ?? 0);
      return na - nb;
    });

  const lines: string[] = [];
  sheetFiles.forEach((file, index) => {
    const sheetBuf = readZipEntry(buffer, file);
    if (!sheetBuf) return;
    const title = sheetNames[index] ?? `Sheet${index + 1}`;
    const rows = parseSheetRows(sheetBuf.toString('utf8'), shared);
    if (rows.length === 0) return;
    lines.push(`# ${title}`);
    lines.push(...rows);
  });

  const text = lines.join('\n').trim();
  return text.length > 0 ? text : null;
}

function looksLikeUtf8Text(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  let nul = 0;
  const sample = Math.min(buffer.length, 2048);
  for (let i = 0; i < sample; i++) {
    if (buffer[i] === 0) nul += 1;
  }
  return nul / sample < 0.01;
}

export type FileTextExtractResult =
  | { ok: true; text: string; kind: string }
  | { ok: false; reason: string };

/**
 * 从云空间下载的附件中提取可供 AI 解析的纯文本。
 * 支持：纯文本 / CSV / Word(.docx) / Excel(.xlsx)。PDF 等需先转飞书云文档。
 */
export async function extractQuotationTextFromFile(input: {
  buffer: Buffer;
  fileName: string;
  contentType: string;
}): Promise<FileTextExtractResult> {
  const name = (input.fileName || '').toLowerCase();
  const type = (input.contentType || '').toLowerCase();

  if (
    name.endsWith('.docx') ||
    type.includes('wordprocessingml') ||
    type.includes('application/vnd.openxmlformats-officedocument.wordprocessingml')
  ) {
    const text = extractTextFromDocxBuffer(input.buffer);
    if (text) return { ok: true, text, kind: 'docx' };
    return { ok: false, reason: '无法从 Word（.docx）中提取文本，请确认文件未损坏' };
  }

  if (
    name.endsWith('.xlsx') ||
    type.includes('spreadsheetml') ||
    type.includes('application/vnd.openxmlformats-officedocument.spreadsheetml')
  ) {
    const text = extractTextFromXlsxBuffer(input.buffer);
    if (text) return { ok: true, text, kind: 'xlsx' };
    return { ok: false, reason: '无法从 Excel（.xlsx）中提取文本，请确认文件未损坏' };
  }

  if (name.endsWith('.pdf') || type.includes('application/pdf')) {
    return {
      ok: false,
      reason:
        '暂不支持直接解析 PDF 附件。请在飞书中打开后「另存为/转换为云文档」，再粘贴 /docx/ 链接，或改用「多维表格导入」',
    };
  }

  if (
    name.endsWith('.doc') ||
    type.includes('application/msword') ||
    name.endsWith('.xls') ||
    type.includes('application/vnd.ms-excel')
  ) {
    return {
      ok: false,
      reason:
        '暂不支持旧版 Office（.doc/.xls）。请另存为 .docx/.xlsx，或在飞书转为云文档后粘贴 /docx/ 链接',
    };
  }

  if (
    name.endsWith('.txt') ||
    name.endsWith('.csv') ||
    name.endsWith('.md') ||
    type.startsWith('text/') ||
    type.includes('csv')
  ) {
    if (!looksLikeUtf8Text(input.buffer)) {
      return { ok: false, reason: '文本文件编码异常，请另存为 UTF-8 后再试' };
    }
    const text = input.buffer.toString('utf8').trim();
    if (!text) return { ok: false, reason: '文件内容为空' };
    return { ok: true, text, kind: 'text' };
  }

  // 未知类型：先尝试 xlsx / docx
  const asXlsx = extractTextFromXlsxBuffer(input.buffer);
  if (asXlsx) return { ok: true, text: asXlsx, kind: 'xlsx' };
  const asDocx = extractTextFromDocxBuffer(input.buffer);
  if (asDocx) return { ok: true, text: asDocx, kind: 'docx' };

  if (looksLikeUtf8Text(input.buffer)) {
    const text = input.buffer.toString('utf8').trim();
    if (text.length >= 20) return { ok: true, text, kind: 'text' };
  }

  return {
    ok: false,
    reason: `不支持的附件类型（${input.fileName || type || '未知'}）。请使用飞书云文档 /docx/ 链接，或上传 .docx/.xlsx/.txt/.csv`,
  };
}
