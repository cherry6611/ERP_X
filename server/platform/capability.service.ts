import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { Inject } from '@nestjs/common';
import { sysUser } from '@server/database/schema';
import { FeishuClientService } from '@server/modules/feishu-drive/feishu-client.service';
import { DRIZZLE_DATABASE } from './tokens';

const QUOTATION_PROMPT = `你是专业的报价单结构化解析专家。只输出 JSON，不要 Markdown。
字段：title, quoteDate, validUntil, remark, items。
items 每项含 itemName, unit, quantity, unitPrice, discountPct, estUnitCost, remark。
日期用 YYYY-MM-DD，无法识别则为 null。discountPct 为 0-100 的整数。`;

const TABLE_ENV: Record<string, string> = {
  erp_bitable_two_way_sync_1: 'FEISHU_BITABLE_COST_TABLE',
  contract_ledger_archiving_1: 'FEISHU_BITABLE_CONTRACT_TABLE',
  flexible_labor_hours_sync_1: 'FEISHU_BITABLE_TIMESHEET_TABLE',
};

@Injectable()
export class CapabilityService {
  private readonly logger = new Logger(CapabilityService.name);

  constructor(
    private readonly moduleRef: ModuleRef,
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  private feishu(): FeishuClientService {
    return this.moduleRef.get(FeishuClientService, { strict: false });
  }

  load(id: string): { call: (action: string, input: unknown) => Promise<unknown> } {
    return {
      call: (action, input) => this.dispatch(id, action, input),
    };
  }

  private async dispatch(id: string, action: string, input: unknown): Promise<unknown> {
    if (id === 'send_erp_approval_notification_1' && action === 'send_feishu_message') {
      return this.sendMessage(input);
    }
    if (id === 'quotation_text_to_json_parse_1' && action === 'textToJson') {
      return this.parseQuotation(input);
    }
    if (action === 'batchAddRecords') return this.batchAdd(id, input);
    if (action === 'searchRecords') return this.searchRecords(id, input);
    throw new ServiceUnavailableException(`未实现的飞书能力 ${id}.${action}`);
  }

  private async sendMessage(input: unknown): Promise<{ success: boolean }> {
    const body = input as { receiverIds?: string[]; title?: string; content?: string };
    const ids = body.receiverIds ?? [];
    let sent = 0;
    for (const id of ids) {
      const openId = await this.resolveOpenId(id);
      if (!openId) continue;
      const text = `${body.title ?? ''}\n${body.content ?? ''}`;
      await this.feishu().request('POST', '/open-apis/im/v1/messages', {
        query: { receive_id_type: 'open_id' },
        body: {
          receive_id: openId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
      });
      sent += 1;
    }
    return { success: sent > 0 };
  }

  private async resolveOpenId(userId: string): Promise<string | null> {
    if (userId.startsWith('ou_')) return userId;
    const rows = await this.db
      .select({ feishuOpenId: sysUser.feishuOpenId })
      .from(sysUser)
      .where(eq(sysUser.id, userId))
      .limit(1);
    return rows[0]?.feishuOpenId ?? null;
  }

  private async parseQuotation(input: unknown): Promise<unknown> {
    const text = (input as { text?: string }).text ?? '';
    const base = process.env.LLM_API_BASE;
    const key = process.env.LLM_API_KEY;
    const model = process.env.LLM_MODEL || 'deepseek-chat';
    if (!base || !key) {
      throw new ServiceUnavailableException('未配置 LLM_API_BASE / LLM_API_KEY，无法解析报价单');
    }
    const resp = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: QUOTATION_PROMPT },
          { role: 'user', content: text },
        ],
      }),
    });
    if (!resp.ok) {
      this.logger.error(`报价解析模型返回 HTTP ${resp.status}`);
      throw new ServiceUnavailableException('报价解析模型调用失败');
    }
    const payload = (await resp.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = payload.choices?.[0]?.message?.content ?? '';
    const jsonText = content.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    return JSON.parse(jsonText) as unknown;
  }

  private tableOf(pluginId: string): { app: string; table: string } {
    const app = process.env.FEISHU_BITABLE_APP_TOKEN ?? '';
    const envName = TABLE_ENV[pluginId];
    const table = envName ? process.env[envName] ?? '' : '';
    if (!app || !table) {
      throw new ServiceUnavailableException(
        `多维表格未配置：FEISHU_BITABLE_APP_TOKEN / ${envName ?? pluginId}`,
      );
    }
    return { app, table };
  }

  private async batchAdd(pluginId: string, input: unknown): Promise<{ records: Array<{ id: string }> }> {
    const { app, table } = this.tableOf(pluginId);
    const records = (input as { records?: Array<{ record?: Record<string, unknown> }> }).records ?? [];
    const data = await this.feishu().request<{ records?: Array<{ record_id?: string }> }>(
      'POST',
      `/open-apis/bitable/v1/apps/${app}/tables/${table}/records/batch_create`,
      { body: { records: records.map((row) => ({ fields: row.record ?? {} })) } },
    );
    return {
      records: (data.records ?? []).map((row) => ({ id: row.record_id ?? '' })),
    };
  }

  private async searchRecords(pluginId: string, input: unknown): Promise<{
    hasMore: boolean;
    pageToken?: string;
    records: Array<{ id: string; record: Record<string, unknown> }>;
  }> {
    const { app, table } = this.tableOf(pluginId);
    const query = input as { pageSize?: number; pageToken?: string };
    const data = await this.feishu().request<{
      has_more?: boolean;
      page_token?: string;
      items?: Array<{ record_id?: string; fields?: Record<string, unknown> }>;
    }>('POST', `/open-apis/bitable/v1/apps/${app}/tables/${table}/records/search`, {
      body: {
        page_size: query.pageSize ?? 100,
        page_token: query.pageToken,
      },
    });
    return {
      hasMore: Boolean(data.has_more),
      pageToken: data.page_token,
      records: (data.items ?? [])
        .filter((item) => typeof item.record_id === 'string')
        .map((item) => ({
          id: item.record_id as string,
          record: item.fields ?? {},
        })),
    };
  }
}
