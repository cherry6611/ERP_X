import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CapabilityService } from '@server/platform';
import {
  FeishuApiError,
  FeishuClientService,
} from '@server/modules/feishu-drive/feishu-client.service';
import type {
  ParseQuotationDocDto,
  ParsedQuotationDraft,
  ParsedQuotationItem,
} from '@shared/api.interface';

const DOC_URL_PATTERN = /\/docx\/([A-Za-z0-9]+)/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

interface RawParsedItem {
  itemName?: unknown;
  unit?: unknown;
  quantity?: unknown;
  unitPrice?: unknown;
  discountPct?: unknown;
  estUnitCost?: unknown;
  remark?: unknown;
}

interface RawParsedOutput {
  title?: unknown;
  quoteDate?: unknown;
  validUntil?: unknown;
  remark?: unknown;
  items?: unknown;
}

function normalizeDate(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return DATE_PATTERN.test(value.trim()) ? value.trim() : null;
}

function normalizeOptionalText(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return value.trim();
}

function normalizeNumber(value: unknown): number | null {
  const num = typeof value === 'string' ? Number(value) : value;
  if (typeof num !== 'number' || !Number.isFinite(num) || num < 0) return null;
  return num;
}

@Injectable()
export class QuotationImportService {
  private readonly logger = new Logger(QuotationImportService.name);

  constructor(
    @Inject(CapabilityService)
    private readonly capabilityService: CapabilityService,
    private readonly feishuClient: FeishuClientService
  ) {}

  private extractDocToken(docUrl: string): string {
    const match = DOC_URL_PATTERN.exec(docUrl.trim());
    if (!match || match[1].length < 8) {
      throw new BadRequestException(
        '请粘贴飞书云文档链接（形如 https://xxx.feishu.cn/docx/xxxx）',
      );
    }
    return match[1];
  }

  private async fetchRawContent(docToken: string): Promise<string> {
    try {
      return await this.feishuClient.getDocRawContent(docToken);
    } catch (error: unknown) {
      if (error instanceof FeishuApiError) {
        throw new BadRequestException(
          `无法读取该云文档，请确认链接为 docx 文档且应用可访问（${error.message}）`,
        );
      }
      throw error;
    }
  }

  private normalizeItems(rawItems: unknown): ParsedQuotationItem[] {
    if (!Array.isArray(rawItems)) return [];
    const items: ParsedQuotationItem[] = [];
    for (const raw of rawItems) {
      if (raw === null || typeof raw !== 'object') continue;
      const item = raw as RawParsedItem;
      const itemName =
        typeof item.itemName === 'string' ? item.itemName.trim() : '';
      if (itemName.length === 0) continue;
      const quantity = normalizeNumber(item.quantity);
      const unitPrice = normalizeNumber(item.unitPrice);
      if (quantity === null || quantity <= 0) continue;
      if (unitPrice === null) continue;
      items.push({
        itemName,
        unit: normalizeOptionalText(item.unit),
        quantity,
        unitPrice,
        discountPct: normalizeNumber(item.discountPct),
        estUnitCost: normalizeNumber(item.estUnitCost),
        remark: normalizeOptionalText(item.remark),
      });
    }
    return items;
  }

  async parseDoc(dto: ParseQuotationDocDto): Promise<ParsedQuotationDraft> {
    const docToken = this.extractDocToken(dto.docUrl);
    const content = await this.fetchRawContent(docToken);
    if (content.trim().length === 0) {
      throw new BadRequestException('文档内容为空，无法解析报价信息');
    }
    let output: unknown;
    try {
      output = await this.capabilityService
        .load('quotation_text_to_json_parse_1')
        .call('textToJson', { text: content });
    } catch (error: unknown) {
      const stack: string =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.logger.error('报价文档 AI 解析插件调用异常', stack);
      throw new ServiceUnavailableException(
        '报价文档解析服务异常，请稍后重试或改为手动录入',
      );
    }
    if (output === null || typeof output !== 'object') {
      throw new ServiceUnavailableException(
        '报价文档解析结果异常，请重试或改为手动录入',
      );
    }
    const raw = output as RawParsedOutput;
    const items = this.normalizeItems(raw.items);
    if (items.length === 0) {
      throw new BadRequestException(
        '未能从文档中识别出报价明细，请检查文档内容或改为手动录入',
      );
    }
    return {
      title: normalizeOptionalText(raw.title),
      quoteDate: normalizeDate(raw.quoteDate),
      validUntil: normalizeDate(raw.validUntil),
      remark: normalizeOptionalText(raw.remark),
      items,
    };
  }
}
