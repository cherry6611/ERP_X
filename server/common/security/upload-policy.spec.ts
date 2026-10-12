import { BadRequestException } from '@nestjs/common';
import { assertUploadPayload } from './upload-policy';

describe('upload policy', () => {
  it('accepts a matching png payload', () => {
    const raw = Buffer.from('hello');
    const buffer = assertUploadPayload('note.png', raw.toString('base64'), raw.length);
    expect(buffer.equals(raw)).toBe(true);
  });

  it('rejects an extension outside the allowlist', () => {
    const raw = Buffer.from('hello');
    expect(() =>
      assertUploadPayload('note.exe', raw.toString('base64'), raw.length)
    ).toThrow(BadRequestException);
  });

  it('rejects a declared size that does not match the bytes', () => {
    const raw = Buffer.from('hello');
    expect(() =>
      assertUploadPayload('note.png', raw.toString('base64'), raw.length + 1)
    ).toThrow(BadRequestException);
  });
});
