import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import { CanCapability, NeedLogin } from '@server/platform';
import type { Request } from 'express';
import { actorFromRequest } from '@server/common/auth/actor';
import { consumeRate } from '@server/common/security/rate-limit';
import { NotificationsService } from './notifications.service';
import type {
  ApprovalNotificationResult,
  ListInboxMessagesResult,
  MarkInboxMessageReadResult,
  SendApprovalNotificationRequest,
} from '@shared/api.interface';

export class SendApprovalNotificationDto
  implements SendApprovalNotificationRequest
{
  @IsString()
  @IsIn([
    'expense',
    'purchase',
    'leave',
    'payroll',
    'admin_bill',
    'admin_rent_contract',
    'quotation',
  ])
  bizType!:
    | 'expense'
    | 'purchase'
    | 'leave'
    | 'payroll'
    | 'admin_bill'
    | 'admin_rent_contract'
    | 'quotation';

  @IsString()
  @IsNotEmpty()
  bizCode!: string;

  @IsString()
  @IsNotEmpty()
  title!: string;

  @IsString()
  @IsNotEmpty()
  content!: string;
}

@NeedLogin()
@Controller('api/notifications')
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  /**
   * U-27 / SEC-A：不在此用 CanRole(admin)，否则提交人无法催办。
   * 服务侧二次校验：仅单据提交人或 admin 可发；其余 403。
   */
  @CanCapability('self_service')
  @Post('approval')
  async sendApprovalNotification(
    @Req() req: Request,
    @Body() dto: SendApprovalNotificationDto
  ): Promise<ApprovalNotificationResult> {
    const actor = actorFromRequest(req);
    await consumeRate(`notify:${actor.userId}`, 10, 60 * 60 * 1000);
    return this.notificationsService.sendApprovalNotification(dto, {
      kind: 'user',
      userId: actor.userId,
    });
  }

  /** B8：当前用户站内信列表；query unreadOnly=1|true 时仅未读 */
  @Get('inbox')
  async listInbox(
    @Req() req: Request,
    @Query('unreadOnly') unreadOnly?: string
  ): Promise<ListInboxMessagesResult> {
    const actor = actorFromRequest(req);
    const onlyUnread =
      unreadOnly === '1' || unreadOnly === 'true' || unreadOnly === 'yes';
    return this.notificationsService.listInboxMessages(
      actor.userId,
      onlyUnread
    );
  }

  /** B8：将当前用户的一条站内信标为已读 */
  @CanCapability('self_service')
  @Patch('inbox/:id/read')
  async markInboxRead(
    @Req() req: Request,
    @Param('id') id: string
  ): Promise<MarkInboxMessageReadResult> {
    const actor = actorFromRequest(req);
    return this.notificationsService.markInboxMessageRead(actor.userId, id);
  }
}
