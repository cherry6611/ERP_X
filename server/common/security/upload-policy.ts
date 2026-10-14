import { BadRequestException } from '@nestjs/common';

/**
 * B-06 ①：上传内容安全（扩展名白名单 + 魔数校验）。
 *
 * 背景（需求书 §2.2 B-06）：原实现只校验扩展名与大小，
 * 把 `.exe` 改名为 `.png` 即可入库并被他人下载（`upload-policy.ts:6-23`）。
 * 这里补上**内容魔数**校验：读文件头与扩展名期望的类型比对，不一致直接拒绝。
 *
 * 设计取舍：
 * - 不引入 `file-type` 依赖（会新增传递依赖且需异步读流）；
 *   常见办公/图片格式的魔数是固定的，用一张表比 10 行代码更可审计；
 * - 对"魔数不固定"的格式（txt/csv/svg 等基于文本的），改为**反向校验**：
 *   必须是合法文本、不得包含可执行文件特征（如 `MZ` 头、`\x7fELF`）。
 */

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_LOCAL_UPLOAD_BYTES = 20 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'svg',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'txt',
  'csv',
  'zip',
]);

/**
 * 扩展名 → 允许的魔数前缀（十六进制，不区分大小写）。
 * 一个扩展名允许多个候选（例如 doc/xls/ppt 都是 OLE2 复合文档，
 * docx/xlsx/pptx 都是 ZIP 容器）。
 */
const MAGIC_BY_EXTENSION: Record<string, string[][]> = {
  pdf: [['25504446']],
  png: [['89504e470d0a1a0a']],
  jpg: [['ffd8ff']],
  jpeg: [['ffd8ff']],
  gif: [['474946383761'], ['474946383961']],
  webp: [['52494646']], // RIFF....WEBP，前 4 字节足够区分
  zip: [['504b0304'], ['504b0506'], ['504b0708']],
  docx: [['504b0304'], ['504b0506'], ['504b0708']],
  xlsx: [['504b0304'], ['504b0506'], ['504b0708']],
  pptx: [['504b0304'], ['504b0506'], ['504b0708']],
  doc: [['d0cf11e0a1b11ae1']],
  xls: [['d0cf11e0a1b11ae1']],
  ppt: [['d0cf11e0a1b11ae1']],
  // svg / txt / csv 为文本格式，见 assertTextLikeContent
};

/** 可执行文件/脚本特征（即使改名也要拦） */
const FORBIDDEN_MAGIC = [
  '4d5a', // MZ：Windows PE/EXE/DLL
  '7f454c46', // ELF
  'cafebabe', // Java class / Mach-O fat
  'feedface',
  'feedfacf',
  'cefaedfe',
  'cffaedfe',
  '213c617263683e', // !<arch>：静态库
];

export function assertAllowedExtension(fileName: string): string {
  const ext: string = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    throw new BadRequestException(
      '不支持的文件类型，仅允许 pdf/图片/Office/txt/csv/zip'
    );
  }
  return ext;
}

export interface MagicCheckResult {
  /** 实际内容的十六进制前缀（最多 16 字节） */
  magicHex: string;
  /** 检测结论：ok / text */
  kind: 'binary' | 'text';
}

/**
 * B-06 ①：魔数校验。扩展名与内容不一致时抛 400（并给出可读中文原因）。
 */
export function assertMagicMatchesExtension(
  fileName: string,
  buffer: Buffer
): MagicCheckResult {
  const ext = assertAllowedExtension(fileName);
  if (buffer.length < 4) {
    throw new BadRequestException('文件内容过短，无法识别真实类型');
  }
  const magicHex = buffer.subarray(0, 16).toString('hex').toLowerCase();
  for (const forbidden of FORBIDDEN_MAGIC) {
    if (magicHex.startsWith(forbidden)) {
      throw new BadRequestException(
        `检测到可执行文件特征（${forbidden}），已拒绝上传；请勿将程序文件改名为文档后缀`
      );
    }
  }
  const candidates = MAGIC_BY_EXTENSION[ext];
  if (!candidates) {
    // 文本类格式（svg/txt/csv）：必须能按 UTF-8 解析且不含 NUL 字节
    assertTextLikeContent(ext, buffer);
    return { magicHex, kind: 'text' };
  }
  const matched = candidates.some((candidate) =>
    candidate.some((prefix) => magicHex.startsWith(prefix))
  );
  if (!matched) {
    const readable = buffer.subarray(0, 8).toString('hex');
    throw new BadRequestException(
      `文件内容与扩展名 .${ext} 不符（实际文件头 ${readable}），已拒绝上传；请确认文件未损坏或被改名`
    );
  }
  return { magicHex, kind: 'binary' };
}

/** 文本类格式校验：必须是可解码文本且不含 NUL 与常见脚本宿主特征 */
function assertTextLikeContent(ext: string, buffer: Buffer): void {
  const head = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (head.includes(0)) {
    throw new BadRequestException(
      `文件内容包含二进制数据，与扩展名 .${ext} 不符，已拒绝上传`
    );
  }
  const text = head.toString('utf8');
  if (text.includes('\uFFFD')) {
    throw new BadRequestException(
      `文件不是合法的 UTF-8 文本，与扩展名 .${ext} 不符，已拒绝上传`
    );
  }
  if (ext === 'svg') {
    // SVG 可内嵌脚本；仅允许纯图形描述，禁止 <script>/on* 事件/外部实体
    const lower = text.toLowerCase();
    if (
      lower.includes('<script') ||
      /\son[a-z]+\s*=/.test(lower) ||
      lower.includes('javascript:') ||
      lower.includes('<!entity')
    ) {
      throw new BadRequestException(
        'SVG 中包含脚本或事件处理器，出于安全考虑已拒绝上传'
      );
    }
  }
}

/** 本地 multipart 上传校验（扩展名 + 大小 + 魔数） */
export function assertLocalUploadFile(file: {
  originalname: string;
  size: number;
  buffer: Buffer;
}): MagicCheckResult {
  assertAllowedExtension(file.originalname);
  if (!Number.isFinite(file.size) || file.size < 1) {
    throw new BadRequestException('文件大小无效');
  }
  if (file.size > MAX_LOCAL_UPLOAD_BYTES || file.buffer.length > MAX_LOCAL_UPLOAD_BYTES) {
    throw new BadRequestException('文件超过 20MB 限制');
  }
  if (file.buffer.length === 0) {
    throw new BadRequestException('文件内容为空');
  }
  return assertMagicMatchesExtension(file.originalname, file.buffer);
}

export function assertUploadPayload(
  fileName: string,
  base64Content: string,
  declaredSize: number
): { buffer: Buffer; magic: MagicCheckResult } {
  assertAllowedExtension(fileName);
  if (!Number.isFinite(declaredSize) || declaredSize < 1) {
    throw new BadRequestException('文件大小无效');
  }
  if (declaredSize > MAX_UPLOAD_BYTES) {
    throw new BadRequestException('文件超过 10MB 限制');
  }
  const estimated: number = Math.floor((base64Content.length * 3) / 4);
  if (estimated > MAX_UPLOAD_BYTES) {
    throw new BadRequestException('文件超过 10MB 限制');
  }
  const buffer: Buffer = Buffer.from(base64Content, 'base64');
  if (buffer.length === 0) {
    throw new BadRequestException('文件内容为空');
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new BadRequestException('文件超过 10MB 限制');
  }
  if (buffer.length !== declaredSize) {
    throw new BadRequestException('文件大小与内容不一致');
  }
  const magic = assertMagicMatchesExtension(fileName, buffer);
  return { buffer, magic };
}

/**
 * B-06 ②：可插拔病毒扫描（`FILE_SCAN_PROVIDER = none | clamav | http`）。
 *
 * 默认 `none`，但**必须把结论写进 comp_stored_file.scan_status 并在 UI 提示**，
 * 不允许静默当作"已扫描"。这样上线后接入真实扫描器只需改参数，不改代码。
 */
export interface ScanVerdict {
  status: 'skipped' | 'clean' | 'infected' | 'unsupported' | 'failed';
  detail: string;
}

export async function scanUploadedFile(
  buffer: Buffer,
  fileName: string
): Promise<ScanVerdict> {
  const provider = (process.env.FILE_SCAN_PROVIDER ?? 'none').toLowerCase();
  if (provider === 'none') {
    return {
      status: 'skipped',
      detail: '未配置病毒扫描（FILE_SCAN_PROVIDER=none）；已做扩展名与魔数校验',
    };
  }
  if (provider === 'clamav') {
    // 未安装 clamav 客户端时明确标记 failed（而不是 clean），避免假阴性
    return {
      status: 'unsupported',
      detail:
        'clamav 提供方已配置但本部署未安装扫描守护进程；请在部署层接入后启用',
    };
  }
  if (provider === 'http') {
    const endpoint = (process.env.FILE_SCAN_URL ?? '').trim();
    if (!endpoint) {
      return {
        status: 'failed',
        detail: 'FILE_SCAN_PROVIDER=http 但未配置 FILE_SCAN_URL',
      };
    }
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-File-Name': encodeURIComponent(fileName),
          ...(process.env.FILE_SCAN_TOKEN
            ? { Authorization: `Bearer ${process.env.FILE_SCAN_TOKEN}` }
            : {}),
        },
        body: new Uint8Array(buffer),
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        return { status: 'failed', detail: `扫描服务返回 ${resp.status}` };
      }
      const body = (await resp.json()) as { clean?: boolean; detail?: string };
      return body.clean === false
        ? { status: 'infected', detail: body.detail ?? '扫描服务判定为恶意文件' }
        : { status: 'clean', detail: body.detail ?? '扫描通过' };
    } catch (error) {
      return {
        status: 'failed',
        detail: `扫描服务调用失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  return { status: 'failed', detail: `未知的扫描提供方：${provider}` };
}
