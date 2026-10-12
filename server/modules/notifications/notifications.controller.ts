import { Body, Controller, Post, Req } from '@nestjs/common';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import { NeedLogin } from '@server/platform';
import type { Request } from 'express';
import { actorFromRequest } from '@server/common/auth/actor';
import { consumeRate } from '@server/common/security/rate-limit';
import { NotificationsService } from './notifications.service';
import type {
  ApprovalNotificationResult,
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
  ])
  bizType!:
    | 'expense'
    | 'purchase'
    | 'leave'
    | 'payroll'
    | 'admin_bill'
    | 'admin_rent_contract';

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

  @Post('approval')
  async sendApprovalNotification(
    @Req() req: Request,
    @Body() dto: SendApprovalNotificationDto
  ): Promise<ApprovalNotificationResult> {
    const actor = actorFromRequest(req);
    consumeRate(`notify:${actor.userId}`, 10, 60 * 60 * 1000);
    return this.notificationsService.sendApprovalNotification(dto, {
      kind: 'user',
      userId: actor.userId,
    });
  }
}
