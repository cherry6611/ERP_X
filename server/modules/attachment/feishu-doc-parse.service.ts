import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  FeishuApiError,
  FeishuClientService,
} from '@server/modules/feishu-drive/feishu-client.service';
import type { ParsedFeishuDocLink } from '@shared/api.interface';
import {
  feishuDocTypeLabel,
  parseFeishuDocUrl,
} from './feishu-doc-link';

@Injectable()
export class FeishuDocParseService {
  private readonly logger = new Logger(FeishuDocParseService.name);

  constructor(private readonly feishuClient: FeishuClientService) {}

  async parseUrl(rawUrl: string): Promise<ParsedFeishuDocLink> {
    let ref;
    try {
      ref = parseFeishuDocUrl(rawUrl);
    } catch (err: unknown) {
      throw new BadRequestException(
        err instanceof Error ? err.message : '飞书链接解析失败',
      );
    }

    const normalizedUrl = rawUrl.trim().split(/[?#]/)[0];
    const fallbackTitle = `${feishuDocTypeLabel(ref.docType)} · ${ref.token.slice(0, 8)}`;

    try {
      const { metas, failed } = await this.feishuClient.batchQueryMetas([
        { docToken: ref.token, docType: ref.docType },
      ]);
      const meta = metas.find(
        (m) => m.docToken === ref.token || m.docToken.length > 0,
      );
      if (meta?.title) {
        return {
          title: meta.title,
          docType: meta.docType || ref.docType,
          token: ref.token,
          url: meta.url || normalizedUrl,
        };
      }
      if (failed.length > 0) {
        this.logger.warn(
          `飞书元数据查询失败 token=${ref.token} code=${failed[0]?.code}`,
        );
        return {
          title: fallbackTitle,
          docType: ref.docType,
          token: ref.token,
          url: normalizedUrl,
          warning:
            '未能从飞书拉取文档标题（请确认已分享给应用可读），仍可登记链接',
        };
      }
    } catch (error: unknown) {
      const message =
        error instanceof FeishuApiError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      this.logger.warn(`飞书元数据接口异常: ${message}`);
      return {
        title: fallbackTitle,
        docType: ref.docType,
        token: ref.token,
        url: normalizedUrl,
        warning: `飞书元数据暂不可用：${message}。仍可登记链接`,
      };
    }

    return {
      title: fallbackTitle,
      docType: ref.docType,
      token: ref.token,
      url: normalizedUrl,
    };
  }
}
