import {
  BadGatewayException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { DriveConfigService } from './drive-config.service';
import { registerFeishuTokenInvalidator } from './feishu-token';

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
  attempt?: number;
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

  constructor(private readonly configService: DriveConfigService) {
    registerFeishuTokenInvalidator(() => this.invalidateToken());
  }

  invalidateToken(): void {
    this.token = null;
    this.tokenExpireAt = 0;
  }

  /** 正在刷新令牌的 Promise，用于并发去重（防缓存击穿） */
  private inflight: Promise<string> | null = null;

  async getToken(): Promise<string> {
    const now = Date.now();
    if (this.token && now < this.tokenExpireAt - 5 * 60 * 1000) {
      return this.token;
    }
    // 修复 P1-3：令牌进入「提前 5 分钟刷新」窗口后，并发请求会各自打一次
    // token 端点（缓存击穿/惊群），既浪费配额也可能触发飞书侧限流。
    // 用 in-flight Promise 去重，保证同一时刻只有一次真实请求。
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchToken()
      .then((token) => token)
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    const now = Date.now();
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
      this.logger.error(`获取飞书 tenant_access_token 失败 code=${result.code}`);
      throw new ServiceUnavailableException(
        `获取飞书访问凭证失败：${result.msg}`,
      );
    }
    this.token = result.tenant_access_token;
    this.tokenExpireAt = now + (result.expire ?? 7200) * 1000;
    return this.token;
  }

  private lastCalls: number[] = [];

  private async pace(): Promise<void> {
    const now = Date.now();
    this.lastCalls = this.lastCalls.filter((at) => now - at < 1000);
    if (this.lastCalls.length >= 100) {
      const wait = 1000 - (now - this.lastCalls[0]);
      await new Promise((resolve) => setTimeout(resolve, Math.max(wait, 50)));
    }
    this.lastCalls.push(Date.now());
  }

  async request<T>(
    method: string,
    path: string,
    options: RequestOptions = {},
  ): Promise<T> {
    await this.pace();
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
      this.logger.error(`飞书接口响应非 JSON http=${resp.status} path=${path}`);
      throw new FeishuApiError(-1, `响应格式异常（HTTP ${resp.status}），请稍后重试`);
    }
    if (result.code !== 0) {
      const attempt = options.attempt ?? 0;
      // 修复 P1-3：抖动/限流/5xx 一律纳入重试，并加指数退避 + 抖动。
      // 原来的「零延迟立即重试」在服务端已经过载时会加剧拥塞。
      const retryable =
        result.code === 99991663 ||
        result.code === 99991661 ||
        result.code === 99991400 ||
        (result.code >= 500 && result.code < 600);
      if (retryable && attempt < 3) {
        this.invalidateToken();
        const delayMs = 2 ** attempt * 200 + Math.floor(Math.random() * 200);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return this.request<T>(method, path, {
          ...options,
          attempt: attempt + 1,
        });
      }
      this.logger.error(`飞书接口错误 code=${result.code} path=${path}`);
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
