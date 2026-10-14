import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { CapabilityService, DRIZZLE_DATABASE } from '@server/platform';
import {
  FeishuApiError,
  FeishuClientService,
} from '@server/modules/feishu-drive/feishu-client.service';
import { compFeishuBitableConfig } from '@server/database/schema';
import type {
  ParseQuotationDocDto,
  ParsedQuotationDraft,
  ParsedQuotationItem,
} from '@shared/api.interface';
import { extractQuotationTextFromFile } from './quotation-file-text';
import { tryParseQuotationTable } from './quotation-table-parse';

const DEFAULT_QUOTE_FIELD_MAP: Record<string, string> = {
  报价标题: 'title',
  项目名称: 'title',
  报价日期: 'quoteDate',
  有效期: 'validUntil',
  备注: 'remark',
  '整单折扣%': 'headerDiscountPct',
  整单折扣: 'headerDiscountPct',
  明细名称: 'itemName',
  服务项: 'itemName',
  单位: 'unit',
  数量: 'quantity',
  单价: 'unitPrice',
  预估成本: 'estUnitCost',
  '折扣%': 'discountPct',
  折扣: 'discountPct',
};

/** 飞书云文档 / 云空间文件 / 电子表格 token */
const DOC_URL_PATTERN =
  /\/(?:docx|docs|wiki|file|sheets)\/([A-Za-z0-9_-]+)(?:[/?#]|$)/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

type DocKind = 'docx' | 'docs' | 'wiki' | 'file' | 'sheets';

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
    private readonly feishuClient: FeishuClientService,
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  async getBitableMeta(): Promise<{
    configured: boolean;
    appToken?: string;
    tableId?: string;
    fieldMap: Record<string, string>;
  }> {
    const cfg = await this.loadQuotationBitableConfig();
    if (!cfg) {
      return { configured: false, fieldMap: DEFAULT_QUOTE_FIELD_MAP };
    }
    return {
      configured: true,
      appToken: cfg.appToken,
      tableId: cfg.tableId,
      fieldMap: cfg.fieldMap,
    };
  }

  async listBitableRecords(pageSize = 50): Promise<{
    records: Array<{ recordId: string; fields: Record<string, unknown> }>;
  }> {
    const cfg = await this.requireQuotationBitableConfig();
    const data = await this.feishuClient.request<{
      items?: Array<{ record_id?: string; fields?: Record<string, unknown> }>;
    }>('GET', `/open-apis/bitable/v1/apps/${cfg.appToken}/tables/${cfg.tableId}/records`, {
      query: { page_size: String(Math.min(Math.max(pageSize, 1), 100)) },
    });
    const records = (data.items ?? []).map((item) => ({
      recordId: item.record_id ?? '',
      fields: item.fields ?? {},
    }));
    return { records };
  }

  async previewFromBitable(recordIds: string[]): Promise<ParsedQuotationDraft> {
    if (!recordIds.length) throw new BadRequestException('请至少选择一条记录');
    const cfg = await this.requireQuotationBitableConfig();
    const { records } = await this.listBitableRecords(100);
    const selected = records.filter((r) => recordIds.includes(r.recordId));
    if (selected.length === 0) throw new BadRequestException('未找到选中的多维表格记录');

    const reverse = new Map<string, string>();
    for (const [feishuCol, erpField] of Object.entries(cfg.fieldMap)) {
      reverse.set(erpField, feishuCol);
    }

    const first = selected[0].fields;
    const items: ParsedQuotationItem[] = [];
    for (const row of selected) {
      const fields = row.fields;
      const itemName = this.pickText(fields, reverse.get('itemName'), ['明细名称', '服务项', '品名']);
      const quantity = this.pickNumber(fields, reverse.get('quantity'), ['数量']);
      const unitPrice = this.pickNumber(fields, reverse.get('unitPrice'), ['单价']);
      if (!itemName || quantity === null || unitPrice === null) continue;
      items.push({
        itemName,
        unit: this.pickText(fields, reverse.get('unit'), ['单位']),
        quantity,
        unitPrice,
        discountPct: this.pickNumber(fields, reverse.get('discountPct'), ['折扣%', '折扣']),
        estUnitCost: this.pickNumber(fields, reverse.get('estUnitCost'), ['预估成本', '成本']),
        remark: this.pickText(fields, reverse.get('remark'), ['明细备注']),
      });
    }
    if (items.length === 0) {
      throw new BadRequestException('选中记录未能映射出有效明细，请检查字段映射或表数据');
    }
    return {
      title: this.pickText(first, reverse.get('title'), ['报价标题', '项目名称']),
      quoteDate: normalizeDate(this.pickText(first, reverse.get('quoteDate'), ['报价日期'])),
      validUntil: normalizeDate(this.pickText(first, reverse.get('validUntil'), ['有效期'])),
      remark: this.pickText(first, reverse.get('remark'), ['备注']),
      headerDiscountPct:
        this.pickNumber(first, reverse.get('headerDiscountPct'), [
          '整单折扣%',
          '整单折扣',
        ]) ?? null,
      items,
    };
  }

  private async loadQuotationBitableConfig(): Promise<{
    appToken: string;
    tableId: string;
    fieldMap: Record<string, string>;
  } | null> {
    const rows = await this.db
      .select()
      .from(compFeishuBitableConfig)
      .where(eq(compFeishuBitableConfig.bizType, 'quotation'))
      .limit(1);
    const row = rows[0];
    if (row && row.enabled !== 0) {
      let fieldMap = DEFAULT_QUOTE_FIELD_MAP;
      if (row.fieldMap) {
        try {
          fieldMap = { ...DEFAULT_QUOTE_FIELD_MAP, ...(JSON.parse(row.fieldMap) as Record<string, string>) };
        } catch {
          /* keep default */
        }
      }
      return { appToken: row.appToken, tableId: row.tableId, fieldMap };
    }
    const appToken = process.env.FEISHU_BITABLE_APP_TOKEN ?? '';
    const tableId = process.env.FEISHU_BITABLE_QUOTATION_TABLE ?? '';
    if (!appToken || !tableId) return null;
    return { appToken, tableId, fieldMap: DEFAULT_QUOTE_FIELD_MAP };
  }

  private async requireQuotationBitableConfig() {
    const cfg = await this.loadQuotationBitableConfig();
    if (!cfg) {
      throw new ServiceUnavailableException(
        '未配置报价多维表格：请配置 bizType=quotation 的 app_token/table_id，或设置 FEISHU_BITABLE_QUOTATION_TABLE',
      );
    }
    return cfg;
  }

  private fieldText(value: unknown): string | null {
    if (value == null) return null;
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (Array.isArray(value)) {
      const parts = value
        .map((v) => {
          if (typeof v === 'string' || typeof v === 'number') return String(v);
          if (v && typeof v === 'object' && 'text' in v) return String((v as { text: unknown }).text ?? '');
          return '';
        })
        .filter(Boolean);
      return parts.length ? parts.join('') : null;
    }
    if (typeof value === 'object' && value && 'text' in value) {
      return String((value as { text: unknown }).text ?? '') || null;
    }
    return null;
  }

  private pickText(
    fields: Record<string, unknown>,
    preferred: string | undefined,
    fallbacks: string[],
  ): string | null {
    const keys = preferred ? [preferred, ...fallbacks] : fallbacks;
    for (const key of keys) {
      const text = this.fieldText(fields[key]);
      if (text) return text;
    }
    return null;
  }

  private pickNumber(
    fields: Record<string, unknown>,
    preferred: string | undefined,
    fallbacks: string[],
  ): number | null {
    const keys = preferred ? [preferred, ...fallbacks] : fallbacks;
    for (const key of keys) {
      const raw = fields[key];
      const n = normalizeNumber(typeof raw === 'object' ? this.fieldText(raw) : raw);
      if (n !== null) return n;
    }
    return null;
  }

  private extractDocRef(docUrl: string): { kind: DocKind; token: string } {
    const trimmed = docUrl.trim();
    const match = DOC_URL_PATTERN.exec(trimmed);
    if (!match || match[1].length < 8) {
      throw new BadRequestException(
        '请粘贴飞书链接（支持 /docx/、/docs/、/wiki/、/file/、/sheets/，例如 https://xxx.feishu.cn/sheets/xxxx）',
      );
    }
    const lower = trimmed.toLowerCase();
    const kind: DocKind = lower.includes('/sheets/')
      ? 'sheets'
      : lower.includes('/file/')
        ? 'file'
        : lower.includes('/wiki/')
          ? 'wiki'
          : lower.includes('/docs/')
            ? 'docs'
            : 'docx';
    return { kind, token: match[1] };
  }

  private cellToText(cell: unknown): string {
    if (cell == null) return '';
    if (typeof cell === 'string' || typeof cell === 'number' || typeof cell === 'boolean') {
      return String(cell);
    }
    if (Array.isArray(cell)) {
      return cell.map((c) => this.cellToText(c)).filter(Boolean).join('');
    }
    if (typeof cell === 'object') {
      const obj = cell as Record<string, unknown>;
      if (typeof obj.text === 'string') return obj.text;
      if (typeof obj.name === 'string') return obj.name;
      if (Array.isArray(obj.textArr)) {
        return obj.textArr.map((t) => this.cellToText(t)).join('');
      }
    }
    return '';
  }

  private async fetchSheetText(spreadsheetToken: string): Promise<string> {
    const sheets = await this.feishuClient.listSpreadsheetSheets(spreadsheetToken);
    const visible = sheets.filter((s) => s.sheetId && !s.hidden);
    const targets = visible.length > 0 ? visible : sheets.filter((s) => s.sheetId);
    if (targets.length === 0) {
      throw new BadRequestException('电子表格中没有可用工作表');
    }
    const lines: string[] = [];
    for (const sheet of targets.slice(0, 5)) {
      // 限制列宽避免超大响应；足够覆盖常见报价表
      const range = `${sheet.sheetId}!A1:Z300`;
      let values: unknown[][] = [];
      try {
        values = await this.feishuClient.getSpreadsheetValues(
          spreadsheetToken,
          range,
        );
      } catch (error: unknown) {
        if (error instanceof FeishuApiError) {
          this.logger.warn(
            `读取工作表失败 sheet=${sheet.sheetId}: ${error.message}`,
          );
          continue;
        }
        throw error;
      }
      if (!values.length) continue;
      lines.push(`# ${sheet.title || sheet.sheetId}`);
      for (const row of values) {
        const cells = (Array.isArray(row) ? row : []).map((c) =>
          this.cellToText(c).replace(/\t|\n/g, ' ').trim(),
        );
        while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
        if (cells.some((c) => c.length > 0)) {
          lines.push(cells.join('\t'));
        }
      }
    }
    const text = lines.join('\n').trim();
    if (!text) {
      throw new BadRequestException(
        '电子表格内容为空，或应用无权读取。请将表格分享给飞书应用「晟笙ERP」可读后重试',
      );
    }
    return text;
  }

  private async fetchOnlineDocText(
    token: string,
    type: 'docx' | 'doc' | 'docs',
  ): Promise<string> {
    if (type === 'doc' || type === 'docs') {
      return this.feishuClient.getLegacyDocRawContent(token);
    }
    return this.feishuClient.getDocRawContent(token);
  }

  private async fetchDriveFileText(fileToken: string): Promise<string> {
    const downloaded = await this.feishuClient.downloadFile(fileToken);
    const extracted = await extractQuotationTextFromFile(downloaded);
    if (!extracted.ok) {
      throw new BadRequestException(extracted.reason);
    }
    return extracted.text;
  }

  /** 通过元数据探测 token 真实类型（/file/ 链接可能对应附件或在线文档） */
  private async resolveDriveDocType(
    token: string,
  ): Promise<'file' | 'docx' | 'doc' | 'sheet' | 'bitable' | 'wiki' | null> {
    const candidates = ['file', 'docx', 'doc', 'sheet', 'bitable', 'wiki'] as const;
    try {
      const { metas } = await this.feishuClient.batchQueryMetas(
        candidates.map((docType) => ({ docToken: token, docType })),
      );
      const hit = metas.find((m) => m.docToken === token && m.docType);
      if (!hit) return null;
      const t = hit.docType.toLowerCase();
      if (t === 'file' || t === 'docx' || t === 'doc' || t === 'sheet' || t === 'bitable' || t === 'wiki') {
        return t;
      }
      return null;
    } catch (error: unknown) {
      if (error instanceof FeishuApiError) return null;
      throw error;
    }
  }

  private async fetchRawContent(ref: {
    kind: DocKind;
    token: string;
  }): Promise<string> {
    const errors: string[] = [];

    const tryOnline = async (token: string, type: 'docx' | 'doc' | 'docs') => {
      try {
        const text = await this.fetchOnlineDocText(token, type);
        if (text.trim()) return text;
        errors.push('云文档内容为空');
      } catch (error: unknown) {
        if (error instanceof FeishuApiError) {
          errors.push(error.message);
        } else {
          throw error;
        }
      }
      return null;
    };

    const tryFile = async (token: string) => {
      try {
        return await this.fetchDriveFileText(token);
      } catch (error: unknown) {
        if (error instanceof BadRequestException) throw error;
        if (error instanceof FeishuApiError) {
          errors.push(error.message);
          return null;
        }
        throw error;
      }
    };

    const trySheet = async (token: string) => {
      try {
        return await this.fetchSheetText(token);
      } catch (error: unknown) {
        if (error instanceof BadRequestException) throw error;
        if (error instanceof FeishuApiError) {
          errors.push(error.message);
          return null;
        }
        throw error;
      }
    };

    if (ref.kind === 'sheets') {
      const text = await trySheet(ref.token);
      if (text) return text;
    }

    if (ref.kind === 'wiki') {
      const node = await this.feishuClient.getWikiNode(ref.token);
      if (node) {
        if (node.objType === 'docx' || node.objType === 'doc') {
          const text = await tryOnline(
            node.objToken,
            node.objType === 'doc' ? 'doc' : 'docx',
          );
          if (text) return text;
        } else if (node.objType === 'file') {
          const text = await tryFile(node.objToken);
          if (text) return text;
        } else if (node.objType === 'sheet') {
          const text = await trySheet(node.objToken);
          if (text) return text;
        } else {
          throw new BadRequestException(
            `该知识库节点类型为「${node.objType}」，报价解析仅支持云文档、电子表格或 Word/Excel/文本附件`,
          );
        }
      }
      const asDocx = await tryOnline(ref.token, 'docx');
      if (asDocx) return asDocx;
    }

    if (ref.kind === 'docs') {
      const legacy = await tryOnline(ref.token, 'doc');
      if (legacy) return legacy;
      const asDocx = await tryOnline(ref.token, 'docx');
      if (asDocx) return asDocx;
    }

    if (ref.kind === 'docx') {
      const text = await tryOnline(ref.token, 'docx');
      if (text) return text;
    }

    if (ref.kind === 'file') {
      const resolved = await this.resolveDriveDocType(ref.token);
      if (resolved === 'sheet') {
        const text = await trySheet(ref.token);
        if (text) return text;
      }
      if (resolved === 'bitable') {
        throw new BadRequestException(
          '该 /file/ 链接对应飞书多维表格，请改用「多维表格导入」',
        );
      }
      if (resolved === 'docx' || resolved === 'doc') {
        const text = await tryOnline(ref.token, resolved === 'doc' ? 'doc' : 'docx');
        if (text) return text;
      }
      const downloaded = await tryFile(ref.token);
      if (downloaded) return downloaded;
      const node =
        (await this.feishuClient.getWikiNode(ref.token, 'file')) ??
        (await this.feishuClient.getWikiNode(ref.token));
      if (node?.objType === 'docx' || node?.objType === 'doc') {
        const text = await tryOnline(
          node.objToken,
          node.objType === 'doc' ? 'doc' : 'docx',
        );
        if (text) return text;
      }
      if (node?.objType === 'sheet') {
        const text = await trySheet(node.objToken);
        if (text) return text;
      }
      if (node?.objType === 'file' && node.objToken !== ref.token) {
        const text = await tryFile(node.objToken);
        if (text) return text;
      }
      const asDocx = await tryOnline(ref.token, 'docx');
      if (asDocx) return asDocx;
    }

    const detail = errors.length ? `（${errors.slice(0, 2).join('；')}）` : '';
    if (ref.kind === 'sheets') {
      throw new BadRequestException(
        `无法读取该飞书电子表格。请确认已分享给飞书应用「晟笙ERP」可读，或改上传本地 .xlsx/.csv${detail}`,
      );
    }
    if (ref.kind === 'file') {
      throw new BadRequestException(
        `无法读取该飞书文件。请确认：1）已将文件分享给飞书应用「晟笙ERP」可读；2）附件为 .docx/.xlsx/.txt/.csv，或粘贴 /docx/、/sheets/ 链接；3）也可改用「多维表格导入」${detail}`,
      );
    }
    throw new BadRequestException(
      `无法读取该云文档，请确认链接有效且应用可访问${detail}`,
    );
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

  private async parseFromContent(content: string): Promise<ParsedQuotationDraft> {
    if (content.trim().length === 0) {
      throw new BadRequestException('文档内容为空，无法解析报价信息');
    }

    // 表格型报价（Excel / 飞书表格导出等）优先确定性解析，不依赖 LLM
    const fromTable = tryParseQuotationTable(content);
    if (fromTable && fromTable.items.length > 0) {
      return fromTable;
    }

    let output: unknown;
    try {
      output = await this.capabilityService
        .load('quotation_text_to_json_parse_1')
        .call('textToJson', { text: content });
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      this.logger.error('报价文档 AI 解析插件调用异常', message);
      if (error instanceof ServiceUnavailableException) {
        throw error;
      }
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

  async parseDoc(dto: ParseQuotationDocDto): Promise<ParsedQuotationDraft> {
    const docRef = this.extractDocRef(dto.docUrl);
    const content = await this.fetchRawContent(docRef);
    return this.parseFromContent(content);
  }

  /** 本地上传表格/文档解析（xlsx/csv/txt/docx） */
  async parseUploadedFile(file: {
    originalname: string;
    mimetype: string;
    buffer: Buffer;
  }): Promise<ParsedQuotationDraft> {
    if (!file?.buffer?.length) {
      throw new BadRequestException('请选择要上传的文件');
    }
    const extracted = await extractQuotationTextFromFile({
      buffer: file.buffer,
      fileName: file.originalname || 'upload',
      contentType: file.mimetype || '',
    });
    if (!extracted.ok) {
      throw new BadRequestException(extracted.reason);
    }
    return this.parseFromContent(extracted.text);
  }
}
