import { BadRequestException } from '@nestjs/common';
import {
  assertAllowedExtension,
  assertLocalUploadFile,
  assertMagicMatchesExtension,
  assertUploadPayload,
  scanUploadedFile,
} from './upload-policy';

/** 构造带指定文件头的 buffer */
function withMagic(magicHex: string, tail = 'content'): Buffer {
  return Buffer.concat([
    Buffer.from(magicHex, 'hex'),
    Buffer.from(tail, 'utf8'),
  ]);
}

const PNG = '89504e470d0a1a0a';
const JPEG = 'ffd8ffe000104a464946';
const PDF = '255044462d312e37';
const ZIP = '504b0304';
const OLE2 = 'd0cf11e0a1b11ae1';

describe('upload policy：扩展名白名单', () => {
  it('接受白名单扩展名', () => {
    expect(assertAllowedExtension('a.pdf')).toBe('pdf');
    expect(assertAllowedExtension('a.PNG')).toBe('png');
  });

  it('拒绝白名单外的扩展名', () => {
    expect(() => assertAllowedExtension('note.exe')).toThrow(BadRequestException);
    expect(() => assertAllowedExtension('note')).toThrow(BadRequestException);
  });
});

describe('B-06 魔数校验', () => {
  it('扩展名与内容一致时通过，并回传文件头', () => {
    const result = assertMagicMatchesExtension('a.png', withMagic(PNG));
    expect(result.kind).toBe('binary');
    expect(result.magicHex.startsWith(PNG)).toBe(true);
    expect(() => assertMagicMatchesExtension('a.jpg', withMagic(JPEG))).not.toThrow();
    expect(() => assertMagicMatchesExtension('a.pdf', withMagic(PDF))).not.toThrow();
    expect(() => assertMagicMatchesExtension('a.docx', withMagic(ZIP))).not.toThrow();
    expect(() => assertMagicMatchesExtension('a.doc', withMagic(OLE2))).not.toThrow();
  });

  it('把 exe 改名为 png 时被拒（MZ 头命中可执行特征）', () => {
    const exe = withMagic('4d5a90000300000004000000');
    expect(() => assertMagicMatchesExtension('payload.png', exe)).toThrow(
      /可执行文件特征/
    );
  });

  it('把 ELF/Java class 改名同样被拒', () => {
    expect(() =>
      assertMagicMatchesExtension('a.png', withMagic('7f454c4602010100'))
    ).toThrow(/可执行文件特征/);
    expect(() =>
      assertMagicMatchesExtension('a.jpg', withMagic('cafebabe00000034'))
    ).toThrow(/可执行文件特征/);
  });

  it('内容与扩展名不符（pdf 存 png）被拒且原因可读', () => {
    expect(() => assertMagicMatchesExtension('a.png', withMagic(PDF))).toThrow(
      /文件内容与扩展名 \.png 不符/
    );
  });

  it('内容过短被拒', () => {
    expect(() => assertMagicMatchesExtension('a.png', Buffer.from([0x89]))).toThrow(
      /过短/
    );
  });

  it('文本类格式（txt/csv）按 UTF-8 校验，含 NUL 被拒', () => {
    expect(() =>
      assertMagicMatchesExtension('a.txt', Buffer.from('正常的中文内容', 'utf8'))
    ).not.toThrow();
    const withNul = Buffer.concat([Buffer.from('abc'), Buffer.from([0]), Buffer.from('def')]);
    expect(() => assertMagicMatchesExtension('a.csv', withNul)).toThrow(/二进制数据/);
  });

  it('SVG 内嵌脚本/事件处理器被拒（XSS 面收敛）', () => {
    const safe = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
    expect(() => assertMagicMatchesExtension('a.svg', safe)).not.toThrow();
    const scripted = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    );
    expect(() => assertMagicMatchesExtension('a.svg', scripted)).toThrow(/脚本/);
    const onload = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="x()"/>');
    expect(() => assertMagicMatchesExtension('a.svg', onload)).toThrow(/脚本/);
  });
});

describe('B-06 上传入参校验（assertUploadPayload / assertLocalUploadFile）', () => {
  it('接受文件头匹配的 payload 并返回 buffer 与魔数结论', () => {
    const raw = withMagic(PNG);
    const result = assertUploadPayload('note.png', raw.toString('base64'), raw.length);
    expect(result.buffer.equals(raw)).toBe(true);
    expect(result.magic.kind).toBe('binary');
  });

  it('拒绝白名单外扩展名', () => {
    const raw = withMagic(PNG);
    expect(() =>
      assertUploadPayload('note.exe', raw.toString('base64'), raw.length)
    ).toThrow(BadRequestException);
  });

  it('拒绝声明大小与实际字节不一致', () => {
    const raw = withMagic(PNG);
    expect(() =>
      assertUploadPayload('note.png', raw.toString('base64'), raw.length + 1)
    ).toThrow(/文件大小与内容不一致/);
  });

  it('拒绝内容为空', () => {
    expect(() => assertUploadPayload('note.png', '', 1)).toThrow(BadRequestException);
  });

  it('assertLocalUploadFile 返回魔数结论并拒绝伪装文件', () => {
    const ok = withMagic(JPEG);
    expect(
      assertLocalUploadFile({ originalname: 'a.jpg', size: ok.length, buffer: ok })
        .kind
    ).toBe('binary');
    const fake = withMagic(PDF);
    expect(() =>
      assertLocalUploadFile({ originalname: 'a.jpg', size: fake.length, buffer: fake })
    ).toThrow(/不符/);
  });
});

describe('B-06 可插拔病毒扫描', () => {
  const original = process.env.FILE_SCAN_PROVIDER;
  afterEach(() => {
    if (original === undefined) delete process.env.FILE_SCAN_PROVIDER;
    else process.env.FILE_SCAN_PROVIDER = original;
  });

  it('未配置时返回 skipped（而不是假装 clean）', async () => {
    delete process.env.FILE_SCAN_PROVIDER;
    const verdict = await scanUploadedFile(Buffer.from('x'), 'a.txt');
    expect(verdict.status).toBe('skipped');
    expect(verdict.detail).toContain('未配置病毒扫描');
  });

  it('配置 clamav 但未接入时返回 unsupported（不静默放行）', async () => {
    process.env.FILE_SCAN_PROVIDER = 'clamav';
    const verdict = await scanUploadedFile(Buffer.from('x'), 'a.txt');
    expect(verdict.status).toBe('unsupported');
  });

  it('配置 http 但缺 URL 时返回 failed', async () => {
    process.env.FILE_SCAN_PROVIDER = 'http';
    delete process.env.FILE_SCAN_URL;
    const verdict = await scanUploadedFile(Buffer.from('x'), 'a.txt');
    expect(verdict.status).toBe('failed');
    expect(verdict.detail).toContain('FILE_SCAN_URL');
  });

  it('未知提供方返回 failed 并带上提供方名', async () => {
    process.env.FILE_SCAN_PROVIDER = 'something-else';
    const verdict = await scanUploadedFile(Buffer.from('x'), 'a.txt');
    expect(verdict.status).toBe('failed');
    expect(verdict.detail).toContain('something-else');
  });
});
