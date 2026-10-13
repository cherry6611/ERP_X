import { BadRequestException } from '@nestjs/common';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_LOCAL_UPLOAD_BYTES = 20 * 1024 * 1024;

const ALLOWED_EXTENSIONS = new Set([
  'pdf',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
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

export function assertAllowedExtension(fileName: string): string {
  const ext: string = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (!ext || !ALLOWED_EXTENSIONS.has(ext)) {
    throw new BadRequestException(
      '不支持的文件类型，仅允许 pdf/图片/Office/txt/csv/zip'
    );
  }
  return ext;
}

/** 本地 multipart 上传校验（扩展名 + 大小） */
export function assertLocalUploadFile(file: {
  originalname: string;
  size: number;
  buffer: Buffer;
}): void {
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
}

export function assertUploadPayload(
  fileName: string,
  base64Content: string,
  declaredSize: number
): Buffer {
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
  return buffer;
}
