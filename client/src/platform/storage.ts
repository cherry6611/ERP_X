export function getDefaultBucketId(): string {
  return 'local';
}

export async function getDataloom() {
  return {
    storage: {
      from(_bucket: string) {
        return {
          async remove(_paths: string[]) {
            return { data: null, error: null };
          },
          async uploadFile(file: File) {
            const body = new FormData();
            body.append('file', file);
            const resp = await fetch('/api/files/upload', {
              method: 'POST',
              body,
              credentials: 'include',
            });
            if (!resp.ok) {
              return { data: null, error: new Error('上传失败') };
            }
            const json = (await resp.json()) as {
              data: { id: string; file_path: string; bucket_id: string; download_url: string };
            };
            return { data: json.data, error: null };
          },
        };
      },
    },
  };
}
