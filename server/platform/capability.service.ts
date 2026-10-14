import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { and, eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { Inject } from '@nestjs/common';
import { compFeishuBitableConfig, sysUser } from '@server/database/schema';
import { FeishuClientService } from '@server/modules/feishu-drive/feishu-client.service';
import { approvalCard } from './feishu/cards';
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

const TABLE_BIZ: Record<string, string> = {
  erp_bitable_two_way_sync_1: 'cost',
  contract_ledger_archiving_1: 'contract',
  flexible_labor_hours_sync_1: 'timesheet',
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
    if (action === 'batchUpdateRecords') return this.batchUpdate(id, input);
    if (action === 'batchDeleteRecords') return this.batchDelete(id, input);
    if (action === 'listFields') return this.listFields(id);
    if (action === 'searchRecords') return this.searchRecords(id, input);
    throw new ServiceUnavailableException(`未实现的飞书能力 ${id}.${action}`);
  }

  private async sendMessage(input: unknown): Promise<{ success: boolean; failed?: string[] }> {
    const body = input as { receiverIds?: string[]; title?: string; content?: string };
    const ids = body.receiverIds ?? [];
    let sent = 0;
    const failed: string[] = [];
    for (const id of ids) {
      const receiver = await this.resolveReceiver(id);
      if (!receiver) {
        failed.push(id);
        // 管理员账号通常由 bootstrap 创建、从未经过飞书授权，
        // 这里给出可操作的修复指引，而不是只留一条看不懂的错误日志。
        this.logger.error(
          `飞书消息未发送：用户未绑定飞书 user=${id}。` +
            `请让该用户访问 /api/auth/feishu/bind 完成授权绑定，或在其账号上补录 feishu_union_id。`
        );
        continue;
      }
      const card = approvalCard(body.title ?? '通知', body.content ?? '');
      await this.feishu().request('POST', '/open-apis/im/v1/messages', {
        query: { receive_id_type: receiver.idType },
        body: {
          receive_id: receiver.id,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      });
      sent += 1;
    }
    // 兜底：目标用户未绑定飞书时，审批/预警会彻底丢失。
    // 配置 FEISHU_FALLBACK_RECEIVER（open_id 或 union_id）后，改为给该兜底人
    // 发一条「仅标题、不含正文」的提醒，避免敏感内容外泄的同时不丢事。
    if (failed.length > 0) {
      const fallback = process.env.FEISHU_FALLBACK_RECEIVER;
      if (fallback && sent === 0) {
        try {
          const notice = approvalCard(
            'ERP 通知未能送达',
            `有 ${failed.length} 位接收人未绑定飞书，请前往系统完成授权绑定。`
          );
          await this.feishu().request('POST', '/open-apis/im/v1/messages', {
            query: {
              receive_id_type: fallback.startsWith('on_') ? 'union_id' : 'open_id',
            },
            body: {
              receive_id: fallback,
              msg_type: 'interactive',
              content: JSON.stringify(notice),
            },
          });
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.error(`兜底通知发送失败: ${message}`);
        }
      }
    }
    return { success: sent > 0, ...(failed.length > 0 ? { failed } : {}) };
  }

  /**
   * 解析飞书消息接收人。
   *
   * 历史缺陷（B6）：只认 feishu_open_id。open_id 是「应用级」身份，
   * 一旦重建应用 / 换 App ID，全部 open_id 失效；而 bootstrap 出来的管理员
   * 从未授权过飞书，字段必然为空 → 管理员永远收不到审批与预警通知。
   *
   * 现在按稳定性从高到低回退：union_id（跨应用稳定）→ open_id（当前应用有效）。
   * im/v1/messages 的 receive_id_type 支持 open_id / union_id / user_id / email / chat_id。
   */
  private async resolveReceiver(
    userId: string
  ): Promise<{ idType: 'open_id' | 'union_id'; id: string } | null> {
    if (userId.startsWith('ou_')) return { idType: 'open_id', id: userId };
    if (userId.startsWith('on_')) return { idType: 'union_id', id: userId };
    if (!/^[0-9a-f-]{36}$/i.test(userId)) return null;
    const rows = await this.db
      .select({
        feishuOpenId: sysUser.feishuOpenId,
        feishuUnionId: sysUser.feishuUnionId,
      })
      .from(sysUser)
      .where(eq(sysUser.id, userId))
      .limit(1);
    const row = rows[0];
    if (row?.feishuUnionId) return { idType: 'union_id', id: row.feishuUnionId };
    if (row?.feishuOpenId) return { idType: 'open_id', id: row.feishuOpenId };
    return null;
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
      signal: AbortSignal.timeout(60_000),
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

  private async tableOf(pluginId: string): Promise<{ app: string; table: string }> {
    const biz = TABLE_BIZ[pluginId];
    if (biz) {
      try {
        const rows = await this.db
          .select()
          .from(compFeishuBitableConfig)
          .where(and(eq(compFeishuBitableConfig.bizType, biz), eq(compFeishuBitableConfig.enabled, 1)))
          .limit(1);
        if (rows[0]?.appToken && rows[0].tableId) {
          return { app: rows[0].appToken, table: rows[0].tableId };
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`多维表格配置表不可用，改读环境变量 ${message}`);
      }
    }
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
    const { app, table } = await this.tableOf(pluginId);
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

  private async batchUpdate(pluginId: string, input: unknown): Promise<{ records: Array<{ id: string }> }> {
    const { app, table } = await this.tableOf(pluginId);
    const records = (input as { records?: Array<{ id?: string; record?: Record<string, unknown> }> }).records ?? [];
    const data = await this.feishu().request<{ records?: Array<{ record_id?: string }> }>(
      'POST',
      `/open-apis/bitable/v1/apps/${app}/tables/${table}/records/batch_update`,
      { body: { records: records.map((row) => ({ record_id: row.id, fields: row.record ?? {} })) } },
    );
    return { records: (data.records ?? []).map((row) => ({ id: row.record_id ?? '' })) };
  }

  private async batchDelete(pluginId: string, input: unknown): Promise<{ records: Array<{ id: string }> }> {
    const { app, table } = await this.tableOf(pluginId);
    const records = (input as { records?: string[] }).records ?? [];
    await this.feishu().request(
      'POST',
      `/open-apis/bitable/v1/apps/${app}/tables/${table}/records/batch_delete`,
      { body: { records } },
    );
    return { records: records.map((id) => ({ id })) };
  }

  private async listFields(pluginId: string): Promise<{ fields: Array<{ id: string; name: string }> }> {
    const { app, table } = await this.tableOf(pluginId);
    const data = await this.feishu().request<{ items?: Array<{ field_id?: string; field_name?: string }> }>(
      'GET',
      `/open-apis/bitable/v1/apps/${app}/tables/${table}/fields`,
    );
    return {
      fields: (data.items ?? []).map((item) => ({ id: item.field_id ?? '', name: item.field_name ?? '' })),
    };
  }

  private async searchRecords(pluginId: string, input: unknown): Promise<{
    hasMore: boolean;
    pageToken?: string;
    records: Array<{ id: string; record: Record<string, unknown> }>;
  }> {
    const { app, table } = await this.tableOf(pluginId);
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
