import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  FeishuClientService,
  FEISHU_TENANT_DOMAIN,
} from './feishu-client.service';
import { DriveConfigService } from './drive-config.service';
import { assertUploadPayload } from '@server/common/security/upload-policy';
import type {
  DriveCreatedItem,
  DriveFolderChildrenResponse,
  DriveItem,
  DriveItemType,
} from '@shared/api.interface';

interface DriveRawFile {
  token: string;
  name: string;
  type: string;
  url?: string;
  size?: string | number | null;
  modified_time?: string | null;
}

interface DriveFilesData {
  files?: DriveRawFile[];
  has_more?: boolean;
  page_token?: string;
}

interface CreateFolderData {
  token: string;
  url: string;
}

interface CreateDocumentData {
  document: { document_id: string; title?: string };
}

const KNOWN_TYPES: DriveItemType[] = [
  'folder',
  'doc',
  'docx',
  'sheet',
  'bitable',
  'file',
  'slides',
  'mindnote',
  'shortcut',
];

function mapType(raw: string): DriveItemType {
  const known = KNOWN_TYPES.find((t: string) => t === raw);
  return known ?? 'other';
}

function fallbackUrl(token: string, type: DriveItemType): string {
  if (type === 'folder') return `${FEISHU_TENANT_DOMAIN}/drive/folder/${token}`;
  if (type === 'sheet') return `${FEISHU_TENANT_DOMAIN}/sheets/${token}`;
  if (type === 'bitable') return `${FEISHU_TENANT_DOMAIN}/base/${token}`;
  if (type === 'doc' || type === 'docx') {
    return `${FEISHU_TENANT_DOMAIN}/docx/${token}`;
  }
  if (type === 'slides') return `${FEISHU_TENANT_DOMAIN}/slides/${token}`;
  if (type === 'mindnote') return `${FEISHU_TENANT_DOMAIN}/mindnotes/${token}`;
  return `${FEISHU_TENANT_DOMAIN}/file/${token}`;
}

const MAX_PARENT_WALK = 8;

@Injectable()
export class DriveService {
  private readonly allowedFolders = new Set<string>();

  constructor(
    private readonly client: FeishuClientService,
    private readonly configService: DriveConfigService,
  ) {}

  async getRootFolderToken(): Promise<string> {
    const config = await this.configService.getConfig();
    return config.rootFolderToken;
  }

  async listChildren(
    folderToken: string,
    pageToken?: string,
  ): Promise<DriveFolderChildrenResponse> {
    await this.assertFolderAllowed(folderToken);
    const query: Record<string, string> = {
      folder_token: folderToken,
      page_size: '200',
    };
    if (pageToken) query.page_token = pageToken;
    const data = await this.client.request<DriveFilesData>(
      'GET',
      '/open-apis/drive/v1/files',
      { query },
    );
    const files: DriveRawFile[] = data.files ?? [];
    const items: DriveItem[] = files.map((file: DriveRawFile) => {
      const type = mapType(file.type);
      return {
        token: file.token,
        name: file.name,
        type,
        size:
          file.size === undefined || file.size === null || file.size === ''
            ? null
            : Number(file.size),
        modifiedTime: file.modified_time ?? null,
        url: file.url ?? fallbackUrl(file.token, type),
      };
    });
    for (const item of items) {
      if (item.type === 'folder') this.allowedFolders.add(item.token);
    }
    return {
      items,
      hasMore: data.has_more ?? false,
      pageToken: data.page_token ?? null,
    };
  }

  async createFolder(parentToken: string, name: string): Promise<DriveCreatedItem> {
    if (!parentToken) {
      throw new BadRequestException('缺少父文件夹');
    }
    await this.assertFolderAllowed(parentToken);
    const data = await this.client.request<CreateFolderData>(
      'POST',
      '/open-apis/drive/v1/files/create_folder',
      { body: { name, folder_token: parentToken } },
    );
    return {
      token: data.token,
      name,
      url:
        data.url ??
        `${FEISHU_TENANT_DOMAIN}/drive/folder/${data.token}`,
    };
  }

  async createDocument(
    folderToken: string,
    title: string,
  ): Promise<DriveCreatedItem> {
    if (!folderToken) {
      throw new BadRequestException('缺少目标文件夹');
    }
    await this.assertFolderAllowed(folderToken);
    const data = await this.client.request<CreateDocumentData>(
      'POST',
      '/open-apis/docx/v1/documents',
      { query: { folder_token: folderToken, title } },
    );
    const documentId = data.document.document_id;
    return {
      token: documentId,
      name: title,
      url: `${FEISHU_TENANT_DOMAIN}/docx/${documentId}`,
    };
  }

  async uploadFile(
    folderToken: string,
    fileName: string,
    base64Content: string,
    size: number,
  ): Promise<DriveCreatedItem> {
    await this.assertFolderAllowed(folderToken);
    const buffer = assertUploadPayload(fileName, base64Content, size);
    const data = await this.client.uploadForm(
      {
        file_name: fileName,
        parent_type: 'explorer',
        parent_node: folderToken,
        size: String(buffer.length),
      },
      fileName,
      buffer,
    );
    return {
      token: data.file_token,
      name: fileName,
      url: `${FEISHU_TENANT_DOMAIN}/file/${data.file_token}`,
    };
  }

  async renameFile(
    fileToken: string,
    type: string,
    name: string,
  ): Promise<DriveCreatedItem> {
    if (type === 'folder') await this.assertFolderAllowed(fileToken);
    await this.client.request<unknown>(
      'PATCH',
      `/open-apis/drive/v1/files/${fileToken}`,
      { query: { type }, body: { new_title: name } },
    );
    return { token: fileToken, name, url: fallbackUrl(fileToken, mapType(type)) };
  }

  async deleteFile(fileToken: string, type: string): Promise<void> {
    if (type === 'folder') await this.assertFolderAllowed(fileToken);
    await this.client.request<unknown>(
      'DELETE',
      `/open-apis/drive/v1/files/${fileToken}`,
      { query: { type } },
    );
  }

  /** 只允许配置的根目录，以及从根目录列出来的子文件夹（或能沿父链走回根目录的文件夹） */
  private async assertFolderAllowed(folderToken: string): Promise<void> {
    const root: string = await this.getRootFolderToken();
    this.allowedFolders.add(root);
    if (folderToken === root || this.allowedFolders.has(folderToken)) return;
    let current: string = folderToken;
    for (let depth = 0; depth < MAX_PARENT_WALK; depth += 1) {
      const parent: string | null = await this.readParentToken(current);
      if (!parent) break;
      if (parent === root || this.allowedFolders.has(parent)) {
        this.allowedFolders.add(folderToken);
        return;
      }
      current = parent;
    }
    throw new ForbiddenException('只能访问已配置根目录下的云盘文件夹');
  }

  private async readParentToken(folderToken: string): Promise<string | null> {
    try {
      const data = await this.client.request<{
        parent_token?: string;
        parentToken?: string;
      }>('GET', `/open-apis/drive/explorer/v2/folder/${folderToken}/meta`);
      return data.parent_token ?? data.parentToken ?? null;
    } catch (error: unknown) {
      const message: string =
        error instanceof Error ? error.message : String(error);
      if (message.length > 0) return null;
      return null;
    }
  }
}
