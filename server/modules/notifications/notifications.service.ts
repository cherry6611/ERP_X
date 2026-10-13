import { BadRequestException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AuthorizationSDK,
  CapabilityService,
  DRIZZLE_DATABASE,
  type ListMembersParams,
  type ListMembersResponse,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { compAttachment, sysInboxMessage } from '@server/database/schema';
import type {
  ApprovalBizType,
  ApprovalNotificationResult,
  InboxMessage,
  ListInboxMessagesResult,
  MarkInboxMessageReadResult,
  SendApprovalNotificationRequest,
} from '@shared/api.interface';
import { stripDisallowedUrls } from '@server/common/security/feishu-url';
import { isAllowedFeishuUrl } from '@server/common/security/feishu-url';
import { AuditService } from '@server/modules/audit/audit.service';
import type { SendErpApprovalNotificationOneOutput } from '@shared/plugin-types';

const ADMIN_ROLE_BIZ_ID = 'admin';
const MEMBERS_PAGE_SIZE = 100;
const MAX_MEMBER_PAGES = 20;

const BIZ_TABLE: Record<ApprovalBizType, string> = {
  expense: 'fin_expense_claim',
  purchase: 'pur_request',
  leave: 'hr_leave_request',
  payroll: 'hr_payroll',
  admin_bill: 'erp_admin_bill',
  admin_rent_contract: 'erp_admin_rent_contract',
  quotation: 'crm_quotation',
};

const NOTIFIABLE_STATUS: Record<ApprovalBizType, string[]> = {
  expense: ['pending', 'submitted', 'escalated'],
  purchase: ['pending', 'submitted'],
  leave: ['pending', 'submitted'],
  payroll: ['submitted'],
  admin_bill: ['submitted', 'pending'],
  admin_rent_contract: ['pending', 'submitted', 'active'],
  quotation: ['pending_approval', 'submitted'],
};

const BIZ_LABEL: Record<ApprovalBizType, string> = {
  expense: '报销单',
  purchase: '采购申请',
  leave: '请假申请',
  payroll: '工资单',
  admin_bill: '行政缴费',
  admin_rent_contract: '租房合同',
  quotation: '报价单',
};

export type ApprovalNotifyAuth =
  | { kind: 'user'; userId: string }
  | { kind: 'system' };

const BIZ_ATTACHMENT_RESOURCE: Partial<Record<ApprovalBizType, string>> = {
  expense: 'fin_expense_claim',
  purchase: 'pur_request',
  leave: 'hr_leave_request',
  payroll: 'hr_payroll',
  admin_bill: 'admin_bill',
  admin_rent_contract: 'admin_rent_contract',
  quotation: 'crm_quotation',
};

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly authzSDK: AuthorizationSDK,
    @Inject(DRIZZLE_DATABASE)
    private readonly db: PostgresJsDatabase,
    @Inject(CapabilityService)
    private readonly capabilityService: CapabilityService,
    private readonly auditService: AuditService
  ) {}

  async sendApprovalNotification(
    dto: SendApprovalNotificationRequest,
    auth: ApprovalNotifyAuth
  ): Promise<ApprovalNotificationResult> {
    const bizInfo = await this.findBizInfo(dto);
    if (!bizInfo) {
      throw new NotFoundException('单据不存在，不能发送审批通知');
    }
    if (
      auth.kind === 'user' &&
      !NOTIFIABLE_STATUS[dto.bizType].includes(bizInfo.status)
    ) {
      throw new BadRequestException('当前单据状态不能发送审批通知');
    }
    if (auth.kind === 'user') {
      const isAdmin: boolean = (await this.listAdminUserIds()).includes(
        auth.userId
      );
      if (auth.userId !== bizInfo.submitterId && !isAdmin) {
        throw new ForbiddenException('仅单据提交人或管理员可发送审批通知');
      }
    }

    const adminIds: string[] = await this.listAdminUserIds();
    const recipients = [...new Set([...adminIds, ...(bizInfo.submitterId ? [bizInfo.submitterId] : [])])];
    if (recipients.length === 0) {
      this.logger.warn(
        `审批通知未发送（no_recipients）bizType=${dto.bizType} bizCode=${dto.bizCode}`
      );
      return { sent: false, reason: 'no_recipients' };
    }

    const docLinks = await this.listBizDocLinks(dto.bizType, bizInfo.bizId);
    const safeLinks = docLinks.filter((doc: { name: string; url: string }) =>
      isAllowedFeishuUrl(doc.url)
    );
    const label: string = BIZ_LABEL[dto.bizType];
    const title: string =
      auth.kind === 'user'
        ? `【审批】${label} ${dto.bizCode}`
        : stripDisallowedUrls(dto.title);
    const baseContent: string =
      auth.kind === 'user'
        ? `${label} ${dto.bizCode} 待处理，请在 ERP 中审批。`
        : stripDisallowedUrls(dto.content);
    const content: string =
      safeLinks.length > 0
        ? `${baseContent}\n相关文档：${safeLinks
            .map((doc: { name: string; url: string }) => `${doc.name} ${doc.url}`)
            .join('；')}`
        : baseContent;

    // B8：站内信与飞书通道并行写入（有收件人即落库，不依赖飞书是否发送成功）
    await this.insertInboxMessages(recipients, title, content, {
      bizType: dto.bizType,
      bizCode: dto.bizCode,
    });

    const result = await this.sendViaFeishuPlugin(recipients, title, content, {
      scene: `审批通知 bizType=${dto.bizType} bizCode=${dto.bizCode}`,
    });
    await this.auditService.record({
      actor: auth.kind === 'user' ? auth.userId : 'system',
      action: 'notify',
      objectType: dto.bizType,
      objectCode: dto.bizCode,
      detail: `sent=${result.sent} receivers=${adminIds.length}`,
    });
    return result;
  }

  /** B8：列出当前用户站内信，可选仅未读 */
  async listInboxMessages(
    userId: string,
    unreadOnly?: boolean
  ): Promise<ListInboxMessagesResult> {
    const conditions = [eq(sysInboxMessage.userId, userId)];
    if (unreadOnly) {
      conditions.push(isNull(sysInboxMessage.readAt));
    }
    const rows = await this.db
      .select()
      .from(sysInboxMessage)
      .where(and(...conditions))
      .orderBy(desc(sysInboxMessage.createdAt))
      .limit(200);
    return {
      items: rows.map((row) => this.toInboxMessage(row)),
    };
  }

  /** B8：将当前用户的一条站内信标为已读 */
  async markInboxMessageRead(
    userId: string,
    id: string
  ): Promise<MarkInboxMessageReadResult> {
    const existing = await this.db
      .select({ id: sysInboxMessage.id, readAt: sysInboxMessage.readAt })
      .from(sysInboxMessage)
      .where(and(eq(sysInboxMessage.id, id), eq(sysInboxMessage.userId, userId)))
      .limit(1);
    if (existing.length === 0) {
      throw new NotFoundException('站内信不存在');
    }
    const readAt = existing[0].readAt ?? new Date();
    if (!existing[0].readAt) {
      await this.db
        .update(sysInboxMessage)
        .set({ readAt })
        .where(
          and(eq(sysInboxMessage.id, id), eq(sysInboxMessage.userId, userId))
        );
    }
    return { ok: true, id, readAt: readAt.toISOString() };
  }

  private async insertInboxMessages(
    userIds: string[],
    title: string,
    content: string,
    biz: { bizType: string; bizCode: string }
  ): Promise<void> {
    if (userIds.length === 0) return;
    try {
      await this.db.insert(sysInboxMessage).values(
        userIds.map((userId) => ({
          userId,
          title,
          content,
          bizType: biz.bizType,
          bizCode: biz.bizCode,
        }))
      );
    } catch (error: unknown) {
      const stack: string =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.logger.error(
        `站内信写入失败 bizType=${biz.bizType} bizCode=${biz.bizCode}`,
        stack
      );
    }
  }

  private toInboxMessage(row: {
    id: string;
    userId: string;
    title: string | null;
    content: string | null;
    bizType: string | null;
    bizCode: string | null;
    readAt: Date | null;
    createdAt: Date;
  }): InboxMessage {
    return {
      id: row.id,
      userId: row.userId,
      title: row.title,
      content: row.content,
      bizType: row.bizType,
      bizCode: row.bizCode,
      readAt: row.readAt ? row.readAt.toISOString() : null,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** 给 admin 角色全部成员发送系统通知（非审批类，如信用预警） */
  async sendAdminNotification(
    title: string,
    content: string
  ): Promise<ApprovalNotificationResult> {
    const adminIds: string[] = await this.listAdminUserIds();
    if (adminIds.length === 0) {
      this.logger.warn(`admin 通知未发送（no_recipients）title=${title}`);
      return { sent: false, reason: 'no_recipients' };
    }
    return this.sendViaFeishuPlugin(adminIds, title, content, {
      scene: `admin 通知 title=${title}`,
    });
  }

  /** 给指定用户列表发送系统通知（非审批类，如应收到期提醒），自动去重接收人 */
  async sendUserNotification(
    receiverIds: string[],
    title: string,
    content: string
  ): Promise<ApprovalNotificationResult> {
    const uniqueIds: string[] = [...new Set(receiverIds)].filter(
      (id: string) => id.length > 0
    );
    if (uniqueIds.length === 0) {
      this.logger.warn(`用户通知未发送（no_recipients）title=${title}`);
      return { sent: false, reason: 'no_recipients' };
    }
    return this.sendViaFeishuPlugin(uniqueIds, title, content, {
      scene: `用户通知 title=${title}`,
    });
  }

  /** 查询 admin 角色全部成员 user_id（供其他模块按 admin 分组收件） */
  async getAdminUserIds(): Promise<string[]> {
    return this.listAdminUserIds();
  }

  /** 通过 send_erp_approval_notification_1 插件发送飞书消息（服务端 CapabilityService.call 无泛型，返回 unknown，运行时收窄后取字段） */
  private async sendViaFeishuPlugin(
    receiverIds: string[],
    title: string,
    content: string,
    context: { scene: string }
  ): Promise<ApprovalNotificationResult> {
    try {
      const output: unknown = await this.capabilityService
        .load('send_erp_approval_notification_1')
        .call('send_feishu_message', {
          receiverIds,
          title,
          content,
        });
      if (output === null || typeof output !== 'object') {
        this.logger.warn(
          `飞书消息发送失败（send_failed，返回非对象）scene=${context.scene}`
        );
        return { sent: false, reason: 'send_failed' };
      }
      const result = output as Partial<SendErpApprovalNotificationOneOutput>;
      if (result.success !== true) {
        this.logger.warn(`飞书消息发送失败（send_failed）scene=${context.scene}`);
        return { sent: false, reason: 'send_failed' };
      }
      return { sent: true };
    } catch (error: unknown) {
      const stack: string =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.logger.error(`飞书消息插件调用异常 scene=${context.scene}`, stack);
      return { sent: false, reason: 'send_failed' };
    }
  }

  /** 查单据创建者 user_id 与单据 id，用于定向发送与附文档链接；查不到回退 admin 全员 */
  private async findBizInfo(
    dto: SendApprovalNotificationRequest
  ): Promise<{ submitterId: string; bizId: string; status: string } | null> {
    const tableName: string = BIZ_TABLE[dto.bizType];
    try {
      const rows: unknown = await this.db.execute(
        sql`SELECT (x._created_by).user_id AS uid, x.id AS biz_id, x.status AS status FROM ${sql.raw(`"${tableName}"`)} x WHERE x.code = ${dto.bizCode} LIMIT 1`
      );
      const list = Array.isArray(rows)
        ? (rows as { uid: string | null; biz_id: string; status: string | null }[])
        : ((rows as { rows?: { uid: string | null; biz_id: string; status: string | null }[] }).rows ?? []);
      const first = list[0];
      if (first && typeof first.biz_id === 'string') {
        return {
          submitterId: typeof first.uid === 'string' ? first.uid : '',
          bizId: first.biz_id,
          status: first.status ?? '',
        };
      }
      return null;
    } catch (error: unknown) {
      const stack: string =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.logger.warn(
        `审批通知查单据失败 bizType=${dto.bizType} bizCode=${dto.bizCode}`
      );
      this.logger.warn(stack);
      return null;
    }
  }

  /** 查单据已登记的附件/云文档链接（最多 5 条），拼进通知正文 */
  private async listBizDocLinks(
    bizType: ApprovalBizType,
    bizId: string
  ): Promise<{ name: string; url: string }[]> {
    const resourceType: string | undefined = BIZ_ATTACHMENT_RESOURCE[bizType];
    if (resourceType === undefined) return [];
    try {
      const rows: { fileName: string; fileUrl: string }[] = await this.db
        .select({ fileName: compAttachment.fileName, fileUrl: compAttachment.fileUrl })
        .from(compAttachment)
        .where(
          and(
            eq(compAttachment.resourceType, resourceType),
            eq(compAttachment.resourceId, bizId)
          )
        )
        .limit(5);
      return rows.map((row: { fileName: string; fileUrl: string }) => ({
        name: row.fileName,
        url: row.fileUrl,
      }));
    } catch (error: unknown) {
      const stack: string =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
      this.logger.warn(
        `审批通知查附件链接失败 bizType=${bizType} bizId=${bizId}`
      );
      this.logger.warn(stack);
      return [];
    }
  }

  /** 查询 admin 角色的用户成员妙达 user_id（部门/群成员忽略），支持分页 */
  private async listAdminUserIds(): Promise<string[]> {
    const ids: string[] = [];
    for (let page = 1; page <= MAX_MEMBER_PAGES; page += 1) {
      const query: ListMembersParams = {
        type: 'User',
        page,
        pageSize: MEMBERS_PAGE_SIZE,
      };
      const res: ListMembersResponse = await this.authzSDK.members.list(
        ADMIN_ROLE_BIZ_ID,
        query
      );
      const userList = res.members.userList ?? [];
      for (const user of userList) {
        const userId: string | undefined = user.userID ?? user.miaodaUserID;
        if (userId) ids.push(userId);
      }
      if (!res.hasMore) break;
    }
    return [...new Set(ids)];
  }
}
