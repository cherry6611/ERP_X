import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { CanCapability, CanCapabilityRead, NeedLogin } from '@server/platform';
import { actorFromRequest } from '@server/common/auth/actor';
import type { Request } from 'express';
import { Req } from '@nestjs/common';
import {
  IsDateString,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Min,
  MaxLength,
} from 'class-validator';
import { NoteService } from './note.service';
import type {
  CreateNoteDto as ICreateNoteDto,
  NoteActionDto as INoteActionDto,
  NoteAction,
  NoteDiscountPreview,
  NoteDueAlert,
  NoteItem,
  NoteLogItem,
  NoteRegisterDeepResult,
  NoteRegisterResult,
  PagedResult,
} from '@shared/api.interface';

/**
 * C-04 / D-02：票据请求体 DTO。
 *
 * ⚠️ 这些 class **必须定义在 controller 之前**：
 * `@Body()` 会把 DTO 构造器作为设计期元数据写到 controller 的装饰器上，
 * 而编译到 CJS 后类声明仍是 `let/const`（TDZ）。若定义在 controller 之后，
 * 生产构建启动时会抛 `Cannot access 'X' before initialization` ——
 * `tsc --noEmit` 与 jest 都不会发现，只有真正 require 编译产物才暴露。
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export class CreateNoteDto implements ICreateNoteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  noteNo!: string;

  @IsIn(['bank', 'commercial'], {
    message: '票据类型仅支持 bank（银行承兑）/ commercial（商业承兑）',
  })
  noteType!: 'bank' | 'commercial';

  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  amount!: number;

  @Matches(DATE_ONLY, { message: '到期日必须为 YYYY-MM-DD' })
  dueDate!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  drawer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  payee?: string;

  @IsOptional()
  @Matches(DATE_ONLY, { message: '出票日必须为 YYYY-MM-DD' })
  issueDate?: string;

  @IsOptional()
  @IsUUID()
  arId?: string;

  @IsOptional()
  @IsUUID()
  apId?: string;

  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @IsOptional()
  @IsUUID()
  customerId?: string;

  @IsOptional()
  @IsUUID()
  projectId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remark?: string;
}

export class NoteActionDto implements INoteActionDto {
  @IsIn(['hold', 'endorse', 'discount', 'settle', 'dishonor'], {
    message: '动作仅支持 hold / endorse / discount / settle / dishonor',
  })
  action!: NoteAction;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  counterparty?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  discountRate?: number;

  @IsOptional()
  @Matches(DATE_ONLY, { message: '贴现日必须为 YYYY-MM-DD' })
  discountDate?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  settledAmount?: number;

  @IsOptional()
  @Matches(DATE_ONLY, { message: '结算日期必须为 YYYY-MM-DD' })
  settledDate?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  remark?: string;
}

/** 贴现试算入参 */
export class PreviewDiscountDto {
  @IsNumber({ maxDecimalPlaces: 4 })
  @Min(0)
  discountRate!: number;

  @IsOptional()
  @Matches(DATE_ONLY, { message: '贴现日必须为 YYYY-MM-DD' })
  discountDate?: string;
}

@NeedLogin()
@Controller('api/notes')
export class NoteController {
  constructor(private readonly noteService: NoteService) {}

  @CanCapabilityRead('finance')
  @Get()
  async list(
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('status') status?: string,
    @Query('noteType') noteType?: string,
    @Query('dueFrom') dueFrom?: string,
    @Query('dueTo') dueTo?: string,
    @Query('projectId') projectId?: string
  ): Promise<PagedResult<NoteItem>> {
    return this.noteService.listNotes({
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      status,
      noteType,
      dueFrom,
      dueTo,
      projectId,
    });
  }

  /** 状态/类型/动作字典（前端据此渲染操作按钮，不硬编码状态机） */
  @Get('dictionaries')
  dictionaries() {
    return this.noteService.dictionaries();
  }

  /** D-02 票据备查簿 */
  @CanCapabilityRead('finance')
  @Get('register')
  async register(): Promise<NoteRegisterResult> {
    return this.noteService.register();
  }

  /**
   * D-02 备查簿深化：到期结构 + 票号连续性 + 贴现成本分析 + 需关注清单。
   *
   * 四块共用一次取数（避免时间差导致两份数字对不上，审计会直接质疑整份报告）。
   */
  @CanCapabilityRead('finance')
  @Get('register-deep')
  async registerDeep(): Promise<NoteRegisterDeepResult> {
    return this.noteService.registerDeep();
  }

  /** D-02 到期预警（逾期 / 15 天内） */
  @CanCapabilityRead('finance')
  @Get('due-alerts')
  async dueAlerts(): Promise<NoteDueAlert[]> {
    return this.noteService.dueAlerts();
  }

  @CanCapabilityRead('finance')
  @Get('discount-basis')
  discountBasis() {
    return this.noteService.discountBasis();
  }

  @CanCapabilityRead('finance')
  @Get(':id')
  async detail(@Param('id', ParseUUIDPipe) id: string): Promise<NoteItem> {
    return this.noteService.getNoteById(id);
  }

  @CanCapabilityRead('finance')
  @Get(':id/logs')
  async logs(@Param('id', ParseUUIDPipe) id: string): Promise<NoteLogItem[]> {
    return this.noteService.listLogs(id);
  }

  /** 关联单据余额（这张票冲的是哪笔应收/应付） */
  @CanCapabilityRead('finance')
  @Get(':id/linked-document')
  async linkedDocument(@Param('id', ParseUUIDPipe) id: string) {
    return this.noteService.linkedDocument(id);
  }

  /** 贴现试算：提交前确认息费、到账额与分录 */
  @CanCapability('finance_write')
  @Post(':id/discount-preview')
  async previewDiscount(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PreviewDiscountDto
  ): Promise<NoteDiscountPreview> {
    return this.noteService.previewDiscount(
      id,
      dto.discountRate,
      dto.discountDate
    );
  }

  @CanCapability('finance_write')
  @Post()
  async create(@Body() dto: CreateNoteDto): Promise<NoteItem> {
    return this.noteService.createNote(dto);
  }

  @CanCapability('finance_write')
  @Post(':id/actions')
  async action(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: NoteActionDto
  ): Promise<NoteItem> {
    return this.noteService.noteAction(id, dto, actorFromRequest(req).userId);
  }
}
