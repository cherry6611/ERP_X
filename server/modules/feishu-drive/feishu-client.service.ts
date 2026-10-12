import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DriveConfigService } from './drive-config.service';

const FEISHU_OPEN_BASE = 'https://open.feishu.cn';
export const FEISHU_TENANT_DOMAIN = 'https://chengshengdata.feishu.cn';

interface FeishuApiEnvelope<T> {
  code: number;
  msg: string;
  data?: T;
}

interface TenantTokenResponse {
  code: number;
  msg: string;
  tenant_access_token?: string;
  expire?: number;
}

interface RequestOptions {
  query?: Record<string, string>;
  body?: unknown;
}

export class FeishuApiError extends BadGatewayException {
  readonly feishuCode: number;

  constructor(feishuCode: number, msg: string) {
    super(`飞书接口错误 ${feishuCode}：${msg}`);
    this.feishuCode = feishuCode;
  }
}

@Injectable()
export class FeishuClientService {
  private readonly logger = new Logger(FeishuClientService.name);
  private token: string | null = null;
  private tokenExpireAt = 0;

  constructor(private readonly configService: DriveConfigService) {}

  invalidateToken(): void {
    this.token = null;
    this.tokenExpireAt = 0;
  }

  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.tokenExpireAt - 5 * 60 * 1000) {
      return this.token;
    }
    const { appId, appSecret } = await this.configService.getConfig();
    const resp = await fetch(
      `${FEISHU_OPEN_BASE}/open-apis/auth/v3/tenant_access_token/internal`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      },
    );
    const result = (await resp.json()) as TenantTokenResponse;
    if (result.code !== 0 || !result.tenant_access_token) {
      this.logger.error(
        `获取飞书 tenant_access_token 失败 code=${result.code} msg=${result.msg}`,
      );
      throw new ServiceUnavailableException(
        `获取飞书访问凭证失败：${result.msg}`,
      );
    }
    this.token = result.tenant_access_token;
    this.tokenExpireAt = now + (result.expire ?? 7200) * 1000;
    return this.token;
  }

  async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    const token = await this.getToken();
    const url = new URL(`${FEISHU_OPEN_BASE}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const resp = await fetch(url, {
      method,
      headers:
        method.toUpperCase() === 'GET'
          ? { Authorization: `Bearer ${token}` }
          : {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json; charset=utf-8',
            },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    const text: string = await resp.text();
    let result: FeishuApiEnvelope<T>;
    try {
      result = JSON.parse(text) as FeishuApiEnvelope<T>;
    } catch {
      this.logger.error(
        `飞书接口响应非 JSON http=${resp.status} ${path} body=${text.slice(0, 200)}`,
      );
      throw new FeishuApiError(
        -1,
        `响应格式异常（HTTP ${resp.status}），请稍后重试`,
      );
    }
    if (result.code !== 0) {
      this.logger.error(`飞书接口错误 ${result.code} ${result.msg} ${path}`);
      throw new FeishuApiError(result.code, result.msg);
    }
    return result.data as T;
  }

  async getDocRawContent(docToken: string): Promise<string> {
    const data = await this.request<{ content?: string }>(
      'GET',
      `/open-apis/docx/v1/documents/${docToken}/raw_content`,
    );
    return data.content ?? '';
  }

  async uploadForm(
    fields: Record<string, string>,
    fileName: string,
    content: Buffer,
  ): Promise<{ file_token: string }> {
    const token = await this.getToken();
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) {
      form.append(key, value);
    }
    form.append('file', new Blob([new Uint8Array(content)]), fileName);
    const resp = await fetch(
      `${FEISHU_OPEN_BASE}/open-apis/drive/v1/files/upload_all`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      },
    );
    const text = await resp.text();
    const result = (
      text ? JSON.parse(text) : { code: 0, msg: 'success', data: {} }
    ) as FeishuApiEnvelope<{ file_token: string }>;
    if (result.code !== 0) {
      this.logger.error(
        `飞书文件上传失败 code=${result.code} msg=${result.msg}`,
      );
      throw new FeishuApiError(result.code, `文件上传失败 ${result.msg}`);
    }
    if (!result.data?.file_token) {
      this.logger.error('飞书文件上传成功但未返回 file_token');
      throw new BadGatewayException('飞书文件上传未返回文件标识');
    }
    return result.data;
  }
}
