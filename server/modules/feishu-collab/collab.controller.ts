import { BadRequestException, Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { IsArray, IsIn, IsNotEmpty, IsString } from 'class-validator';
import { CanCapability, CanCapabilityRead, DRIZZLE_DATABASE, NeedLogin, type PostgresJsDatabase } from '@server/platform';
import { compFeishuApproval } from '@server/database/schema';
import { FeishuClientService } from '@server/modules/feishu-drive/feishu-client.service';
import { FeishuContactService } from './contact.service';

const APPROVAL_TYPES = ['expense', 'purchase', 'leave', 'payroll', 'admin_bill', 'admin_rent_contract', 'quotation'] as const;

class ApprovalDto {
  @IsIn(APPROVAL_TYPES)
  bizType!: (typeof APPROVAL_TYPES)[number];

  @IsString()
  @IsNotEmpty()
  bizCode!: string;
}

class CalendarDto {
  @IsString()
  @IsNotEmpty()
  summary!: string;

  @IsString()
  @IsNotEmpty()
  start!: string;

  @IsString()
  @IsNotEmpty()
  end!: string;
}

class MemberDto {
  @IsArray()
  @IsString({ each: true })
  userIds!: string[];
}

class ChatDto extends MemberDto {
  @IsString()
  @IsNotEmpty()
  name!: string;
}

@NeedLogin()
@Controller('api/feishu')
export class FeishuCollabController {
  constructor(
    private readonly contact: FeishuContactService,
    private readonly feishu: FeishuClientService,
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
  ) {}

  @CanCapability('drive_write')
  @Post('contact/sync')
  syncContact() {
    return this.contact.fullSync();
  }

  @CanCapabilityRead('drive')
  @Get('contact/conflicts')
  conflicts() {
    return this.contact.listConflicts();
  }

  @CanCapability('drive_write')
  @Post('approval')
  async startApproval(@Body() dto: ApprovalDto): Promise<{ instanceCode: string }> {
    // D4：审批未配置时 fail-closed，不再返回 200 + unconfigured
    const codeEnv = process.env[`FEISHU_APPROVAL_${dto.bizType.toUpperCase()}`];
    if (!codeEnv) {
      throw new BadRequestException('审批未配置，无法发起');
    }
    const data = await this.feishu.request<{ instance_code?: string }>(
      'POST',
      '/open-apis/approval/v4/instances',
      {
        body: {
          approval_code: codeEnv,
          form: JSON.stringify([
            { id: 'bizCode', type: 'input', value: dto.bizCode },
          ]),
        },
      },
    );
    const instanceCode = data.instance_code;
    if (!instanceCode) {
      throw new BadRequestException('审批未配置，无法发起');
    }
    await this.db.insert(compFeishuApproval).values({
      bizType: dto.bizType,
      bizCode: dto.bizCode,
      instanceCode,
      status: 'pending',
    });
    return { instanceCode };
  }

  @CanCapability('drive_write')
  @Post('calendar/events')
  async createEvent(@Body() dto: CalendarDto): Promise<{ eventId: string }> {
    const data = await this.feishu.request<{ event?: { event_id?: string } }>(
      'POST',
      '/open-apis/calendar/v4/calendars/primary/events',
      { body: { summary: dto.summary, start_time: { timestamp: dto.start }, end_time: { timestamp: dto.end } } },
    );
    return { eventId: data.event?.event_id ?? '' };
  }

  @CanCapability('drive_write')
  @Post('calendar/freebusy')
  async freebusy(@Body() dto: CalendarDto): Promise<unknown> {
    return this.feishu.request('POST', '/open-apis/calendar/v4/freebusy/list', {
      body: { time_min: dto.start, time_max: dto.end },
    });
  }

  @CanCapability('drive_write')
  @Post('chats')
  async createChat(@Body() dto: ChatDto): Promise<{ chatId: string }> {
    const data = await this.feishu.request<{ chat_id?: string }>('POST', '/open-apis/im/v1/chats', {
      body: { name: dto.name, user_id_list: dto.userIds ?? [] },
    });
    return { chatId: data.chat_id ?? '' };
  }

  @CanCapability('drive_write')
  @Post('chats/:chatId/members')
  async addChatMembers(
    @Param('chatId') chatId: string,
    @Body() dto: MemberDto,
  ): Promise<{ ok: true }> {
    await this.feishu.request('POST', `/open-apis/im/v1/chats/${chatId}/members`, {
      body: { id_list: dto.userIds },
    });
    return { ok: true };
  }
}
