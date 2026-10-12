import React, { useRef, useState } from 'react';
import { UploadCloud } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@client/src/components/ui/button';
import { uploadFile } from '@client/src/api/feishu-drive';
import { logger } from '@client/src/platform/logger';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      const commaIndex = result.indexOf(',');
      resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

interface DriveUploadButtonProps {
  folderToken: string;
  onUploaded: () => void;
}

const DriveUploadButton: React.FC<DriveUploadButtonProps> = ({
  folderToken,
  onUploaded,
}) => {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const file = files[0];
    if (file.size > MAX_UPLOAD_BYTES) {
      toast.error('文件超过 10MB 限制，请在飞书云空间客户端直接上传');
      return;
    }
    setUploading(true);
    try {
      const base64Content = await readAsBase64(file);
      const created = await uploadFile(folderToken, file.name, base64Content, file.size);
      toast.success(`已上传「${created.name}」`);
      onUploaded();
    } catch (error) {
      logger.error('上传文件失败', error);
      toast.error('上传文件失败，请重试');
    } finally {
      setUploading(false);
      if (inputRef.current) {
        inputRef.current.value = '';
      }
    }
  };

  return (
    <>
      <Button
        variant="outline"
        disabled={uploading}
        onClick={() => inputRef.current?.click()}
      >
        <UploadCloud className="mr-2 h-4 w-4" aria-hidden />
        {uploading ? '上传中...' : '上传文件'}
      </Button>
      <input
        ref={inputRef}
        type="file"
        className="hidden"
        aria-label="选择要上传的文件"
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
          void handleFiles(e.target.files);
        }}
      />
    </>
  );
};

export default DriveUploadButton;
