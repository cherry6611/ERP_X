'use client';
import { getDataloom } from '@client/src/platform/storage';
import { getDefaultBucketId } from '@client/src/platform/storage';

export interface UploadFileData {
  id: string;
  filePath: string;
  bucketId: string;
  url: string;
}

export async function uploadFile(file: File): Promise<UploadFileData> {
  const dataloom = await getDataloom();
  const bucket = dataloom.storage.from(getDefaultBucketId());

  const result = await bucket.uploadFile(file);

  if (result.error) {
    throw result.error;
  }

  return {
    id: result.data.id,
    filePath: result.data.file_path,
    bucketId: result.data.bucket_id,
    url: result.data.download_url,
  };
}
