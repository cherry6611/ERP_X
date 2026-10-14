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
/** 出站飞书请求默认超时（毫秒），防止接口抖动拖死连接 */
const FEISHU_FETCH_TIMEOUT_MS = 15_000;

async function feishuFetch(
  url: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEISHU_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ServiceUnavailableException('飞书接口超时，请稍后重试');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

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
    const resp = await feishuFetch(
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
    const resp = await feishuFetch(url, {
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
      // L5：仅 token 失效 / 限流 / 5xx 重试；普通 4xx 不退避，避免错误放大
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

  /** 列出电子表格工作表 */
  async listSpreadsheetSheets(spreadsheetToken: string): Promise<
    Array<{ sheetId: string; title: string; hidden: boolean }>
  > {
    const data = await this.request<{
      sheets?: Array<{
        sheet_id?: string;
        title?: string;
        hidden?: boolean;
      }>;
    }>('GET', `/open-apis/sheets/v3/spreadsheets/${spreadsheetToken}/sheets/query`);
    return (data.sheets ?? []).map((s) => ({
      sheetId: s.sheet_id ?? '',
      title: s.title ?? '',
      hidden: Boolean(s.hidden),
    }));
  }

  /** 读取电子表格某一范围（ToString，便于文本解析） */
  async getSpreadsheetValues(
    spreadsheetToken: string,
    range: string,
  ): Promise<unknown[][]> {
    const data = await this.request<{
      valueRange?: { values?: unknown[][] };
      values?: unknown[][];
    }>('GET', `/open-apis/sheets/v2/spreadsheets/${spreadsheetToken}/values/${encodeURIComponent(range)}`, {
      query: {
        valueRenderOption: 'ToString',
        dateTimeRenderOption: 'FormattedString',
      },
    });
    return data.valueRange?.values ?? data.values ?? [];
  }

  /** 旧版 Docs（/docs/）纯文本 */
  async getLegacyDocRawContent(docToken: string): Promise<string> {
    const data = await this.request<{ content?: string }>(
      'GET',
      `/open-apis/doc/v2/${docToken}/raw_content`,
    );
    return data.content ?? '';
  }

  async batchQueryMetas(
    docs: Array<{ docToken: string; docType: string }>,
  ): Promise<{
    metas: Array<{ docToken: string; docType: string; title: string; url?: string }>;
    failed: Array<{ token: string; code: number }>;
  }> {
    if (docs.length === 0) return { metas: [], failed: [] };
    const data = await this.request<{
      metas?: Array<{
        doc_token?: string;
        doc_type?: string;
        title?: string;
        url?: string;
      }>;
      failed_list?: Array<{ token?: string; code?: number }>;
    }>('POST', '/open-apis/drive/v1/metas/batch_query', {
      body: {
        request_docs: docs.map((d) => ({
          doc_token: d.docToken,
          doc_type: d.docType,
        })),
        with_url: true,
      },
    });
    return {
      metas: (data.metas ?? []).map((m) => ({
        docToken: m.doc_token ?? '',
        docType: (m.doc_type ?? '').toLowerCase(),
        title: m.title ?? '',
        url: m.url,
      })),
      failed: (data.failed_list ?? []).map((f) => ({
        token: f.token ?? '',
        code: f.code ?? 0,
      })),
    };
  }

  async getWikiNode(
    token: string,
    objType?: string,
  ): Promise<{ objToken: string; objType: string; title: string } | null> {
    try {
      const query: Record<string, string> = { token };
      if (objType) query.obj_type = objType;
      const data = await this.request<{
        node?: { obj_token?: string; obj_type?: string; title?: string };
      }>('GET', '/open-apis/wiki/v2/spaces/get_node', { query });
      const node = data.node;
      if (!node?.obj_token || !node.obj_type) return null;
      return {
        objToken: node.obj_token,
        objType: node.obj_type.toLowerCase(),
        title: node.title ?? '',
      };
    } catch (error: unknown) {
      if (error instanceof FeishuApiError) return null;
      throw error;
    }
  }

  /**
   * 下载云空间普通文件（不含在线文档）。成功时返回二进制与文件名。
   */
  async downloadFile(fileToken: string): Promise<{
    buffer: Buffer;
    contentType: string;
    fileName: string;
  }> {
    await this.pace();
    const token = await this.getToken();
    const url = `${FEISHU_OPEN_BASE}/open-apis/drive/v1/files/${encodeURIComponent(fileToken)}/download`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } catch (error: unknown) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new ServiceUnavailableException('飞书文件下载超时，请稍后重试');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const contentType = resp.headers.get('content-type') ?? '';
    const disposition = resp.headers.get('content-disposition') ?? '';
    const arrayBuf = await resp.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);

    // 失败时飞书常返回 JSON envelope
    if (
      contentType.includes('application/json') ||
      (buffer.length > 0 && buffer[0] === 0x7b /* { */)
    ) {
      try {
        const result = JSON.parse(buffer.toString('utf8')) as FeishuApiEnvelope<unknown>;
        if (typeof result.code === 'number' && result.code !== 0) {
          throw new FeishuApiError(result.code, result.msg || '文件下载失败');
        }
      } catch (error: unknown) {
        if (error instanceof FeishuApiError) throw error;
      }
    }
    if (!resp.ok) {
      throw new FeishuApiError(resp.status, `文件下载失败 HTTP ${resp.status}`);
    }

    let fileName = 'file';
    const star = /filename\*=UTF-8''([^;]+)/i.exec(disposition);
    const plain = /filename="?([^";]+)"?/i.exec(disposition);
    if (star?.[1]) {
      try {
        fileName = decodeURIComponent(star[1]);
      } catch {
        fileName = star[1];
      }
    } else if (plain?.[1]) {
      fileName = plain[1];
    }
    return { buffer, contentType, fileName };
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
    const resp = await feishuFetch(
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
