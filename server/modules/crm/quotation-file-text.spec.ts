import { deflateRawSync } from 'node:zlib';
import {
  extractQuotationTextFromFile,
  extractTextFromDocxBuffer,
  extractTextFromXlsxBuffer,
} from './quotation-file-text';

/** 构造最小合法 ZIP（stored），含单个文件入口 */
function zipStored(entryName: string, content: Buffer): Buffer {
  const name = Buffer.from(entryName, 'utf8');
  const local = Buffer.alloc(30 + name.length + content.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // stored
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(0, 14); // crc
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  name.copy(local, 30);
  content.copy(local, 30 + name.length);

  const central = Buffer.alloc(46 + name.length);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42);
  name.copy(central, 46);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length, 12);
  end.writeUInt32LE(local.length, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([local, central, end]);
}

describe('quotation-file-text', () => {
  it('extracts text from minimal docx zip', () => {
    const xml = Buffer.from(
      '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>报价明细A</w:t></w:r></w:p><w:p><w:r><w:t>数量1</w:t></w:r></w:p></w:body></w:document>',
      'utf8',
    );
    const buf = zipStored('word/document.xml', xml);
    const text = extractTextFromDocxBuffer(buf);
    expect(text).toContain('报价明细A');
    expect(text).toContain('数量1');
  });

  it('extracts deflated docx entry', () => {
    const xml = Buffer.from(
      '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>压缩条目</w:t></w:r></w:p></w:body></w:document>',
      'utf8',
    );
    const compressed = deflateRawSync(xml);
    const name = Buffer.from('word/document.xml', 'utf8');
    const local = Buffer.alloc(30 + name.length + compressed.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(xml.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    compressed.copy(local, 30 + name.length);
    const text = extractTextFromDocxBuffer(local);
    expect(text).toContain('压缩条目');
  });

  it('rejects pdf with clear reason', async () => {
    const result = await extractQuotationTextFromFile({
      buffer: Buffer.from('%PDF-1.4'),
      fileName: 'quote.pdf',
      contentType: 'application/pdf',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/PDF/);
  });

  it('reads utf8 text files', async () => {
    const result = await extractQuotationTextFromFile({
      buffer: Buffer.from('服务项\t数量\t单价\n实施\t1\t1000\n', 'utf8'),
      fileName: 'quote.csv',
      contentType: 'text/csv',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.text).toContain('实施');
  });

  it('extracts inlineStr xlsx without sharedStrings', () => {
    const sheet = Buffer.from(
      `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
        <row r="1"><c r="A1" t="inlineStr"><is><t>&#31867;&#21035;</t></is></c><c r="B1" t="inlineStr"><is><t>单价</t></is></c></row>
        <row r="2"><c r="A2" t="inlineStr"><is><t>项目PM</t></is></c><c r="B2" t="n"><v>500</v></c></row>
      </sheetData></worksheet>`,
      'utf8',
    );
    const workbook = Buffer.from(
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets><sheet name="报价" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'utf8',
    );
    // 简易多条目 ZIP（stored）
    function zipMany(entries: Array<{ name: string; content: Buffer }>): Buffer {
      const parts: Buffer[] = [];
      const centrals: Buffer[] = [];
      let offset = 0;
      for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8');
        const local = Buffer.alloc(30 + name.length + e.content.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 8);
        local.writeUInt32LE(e.content.length, 18);
        local.writeUInt32LE(e.content.length, 22);
        local.writeUInt16LE(name.length, 26);
        name.copy(local, 30);
        e.content.copy(local, 30 + name.length);
        parts.push(local);
        const central = Buffer.alloc(46 + name.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt32LE(e.content.length, 20);
        central.writeUInt32LE(e.content.length, 24);
        central.writeUInt16LE(name.length, 28);
        central.writeUInt32LE(offset, 42);
        name.copy(central, 46);
        centrals.push(central);
        offset += local.length;
      }
      const centralDir = Buffer.concat(centrals);
      const end = Buffer.alloc(22);
      end.writeUInt32LE(0x06054b50, 0);
      end.writeUInt16LE(entries.length, 8);
      end.writeUInt16LE(entries.length, 10);
      end.writeUInt32LE(centralDir.length, 12);
      end.writeUInt32LE(offset, 16);
      return Buffer.concat([...parts, centralDir, end]);
    }
    const buf = zipMany([
      { name: 'xl/workbook.xml', content: workbook },
      { name: 'xl/worksheets/sheet1.xml', content: sheet },
    ]);
    const text = extractTextFromXlsxBuffer(buf);
    expect(text).toContain('类别');
    expect(text).toContain('项目PM');
    expect(text).toContain('500');
  });
});
