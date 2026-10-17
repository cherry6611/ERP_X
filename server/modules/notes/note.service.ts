import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, asc, count, desc, eq, gte, lte, sql } from 'drizzle-orm';
import {
  erpApBill,
  erpAr,
  erpNote,
  erpNoteLog,
  erpProject,
  mdCustomer,
  mdSupplier,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { unwrapRows } from '@server/common/utils/rows';
import { buildNoteRegister } from './note-register-rules';
import {
  DISCOUNT_DAY_BASIS,
  NOTE_ACTION_LABELS,
  NOTE_ACTION_TARGET,
  NOTE_ACTION_REQUIRES_COUNTERPARTY,
  NOTE_ACTION_REQUIRES_RATE,
  NOTE_STATUS_LABELS,
  NOTE_TRANSITIONS,
  NOTE_TYPE_LABELS,
  NOTE_TYPES,
  TERMINAL_NOTE_STATUSES,
  computeDiscount,
  dueAlerts,
  noteActionLines,
  noteRegisterSummary,
  validateNoteAction,
  type NoteAction,
  type NoteStatus,
  type NoteType,
} from '@server/common/tax/note-rules';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import { round2 } from '@server/common/utils/number';
import type {
  CreateNoteDto,
  NoteActionDto,
  NoteDiscountPreview,
  NoteDueAlert,
  NoteItem,
  NoteListParams,
  NoteLogItem,
  NoteRegisterDeepResult,
  NoteRegisterResult,
  PagedResult,
} from '@shared/api.interface';

/**
 * C-04 / D-02：应收应付票据（银行承兑 / 商业承兑汇票）。
 *
 * ## 设计要点
 *
 * 1. **状态机与分录口径都在 `server/common/tax/note-rules.ts`**（纯函数 + 27 例单测）。
 *    本服务只负责「取数 → 校验 → 落库 → 生成凭证」，不重复实现业务规则。
 * 2. **票号唯一**（`uq_erp_note_no`）：同一张票据重复入账在并发下由数据库兜底，
 *    服务层翻译成 409 可读中文，而不是把 PostgreSQL 唯一冲突原文抛给用户。
 * 3. **流转动作唯一**（`uq_erp_note_log_action` 部分唯一索引）：
 *    同一张票据的 endorse / discount / settle / dishonor 各只允许一次，
 *    防止重复提交导致重复出凭证。
 * 4. **凭证失败不阻断业务**：与全仓一致，失败写 `comp_voucher_job` 补偿队列，
 *    接口返回 `voucherRef: null`，前端显示"待补录"。
 */


function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 业务时区（Asia/Shanghai）今天 */
function todayInShanghai(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/** `YYYY-MM-DD` 相差天数（a - b） */
function daysBetween(a: string, b: string): number {
  const parse = (value: string): number => {
    const [y, m, d] = value.split('-').map(Number);
    return Date.UTC(y, (m ?? 1) - 1, d ?? 1);
  };
  return Math.floor((parse(a) - parse(b)) / 86_400_000);
}

interface NoteRow {
  note: typeof erpNote.$inferSelect;
  supplierName: string | null;
  customerName: string | null;
  projectName: string | null;
}

@Injectable()
export class NoteService {
  private readonly logger = new Logger(NoteService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly voucherHookService: VoucherHookService
  ) {}

  /* ========== 查询 ========== */

  private baseSelect() {
    return this.db
      .select({
        note: erpNote,
        supplierName: mdSupplier.name,
        customerName: mdCustomer.name,
        projectName: erpProject.name,
      })
      .from(erpNote)
      .leftJoin(mdSupplier, eq(erpNote.supplierId, mdSupplier.id))
      .leftJoin(mdCustomer, eq(erpNote.customerId, mdCustomer.id))
      .leftJoin(erpProject, eq(erpNote.projectId, erpProject.id));
  }

  private toNoteItem(row: NoteRow): NoteItem {
    const note = row.note;
    const today = todayInShanghai();
    return {
      id: note.id,
      code: note.code,
      noteNo: note.noteNo,
      noteType: note.noteType as NoteType,
      drawer: note.drawer,
      payee: note.payee,
      amount: round2(toNumber(note.amount)),
      issueDate: note.issueDate,
      dueDate: note.dueDate,
      status: note.status as NoteStatus,
      arId: note.arId,
      apId: note.apId,
      supplierId: note.supplierId,
      supplierName: row.supplierName,
      customerId: note.customerId,
      customerName: row.customerName,
      projectId: note.projectId,
      projectName: row.projectName,
      discountInterest:
        note.discountInterest === null
          ? null
          : round2(toNumber(note.discountInterest)),
      discountRate:
        note.discountRate === null ? null : round2(toNumber(note.discountRate)),
      settledAmount:
        note.settledAmount === null ? null : round2(toNumber(note.settledAmount)),
      settledDate: note.settledDate,
      endorsementCounterparty: note.endorsementCounterparty,
      remark: note.remark,
      createdAt: note.createdAt.toISOString(),
      daysToDue: daysBetween(note.dueDate, today),
    };
  }

  async listNotes(params: NoteListParams): Promise<PagedResult<NoteItem>> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 200);
    const conditions = [];
    if (params.status) conditions.push(eq(erpNote.status, params.status));
    if (params.noteType) conditions.push(eq(erpNote.noteType, params.noteType));
    if (params.dueFrom) conditions.push(gte(erpNote.dueDate, params.dueFrom));
    if (params.dueTo) conditions.push(lte(erpNote.dueDate, params.dueTo));
    if (params.projectId) {
      conditions.push(eq(erpNote.projectId, params.projectId));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const totalRows = await this.db
      .select({ total: count() })
      .from(erpNote)
      .where(where);
    const rows: NoteRow[] = await this.baseSelect()
      .where(where)
      .orderBy(asc(erpNote.dueDate), desc(erpNote.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      items: rows.map((row) => this.toNoteItem(row)),
      total: Number(totalRows[0]?.total ?? 0),
      page,
      pageSize,
    };
  }

  async getNoteById(id: string): Promise<NoteItem> {
    const rows: NoteRow[] = await this.baseSelect()
      .where(eq(erpNote.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('票据不存在');
    return this.toNoteItem(rows[0]);
  }

  /** 票据流转日志（备查簿的明细来源） */
  async listLogs(noteId: string): Promise<NoteLogItem[]> {
    const rows = await this.db
      .select()
      .from(erpNoteLog)
      .where(eq(erpNoteLog.noteId, noteId))
      .orderBy(asc(erpNoteLog.createdAt));
    return rows.map((row) => ({
      id: row.id,
      noteId: row.noteId,
      action: row.action,
      fromStatus: row.fromStatus,
      toStatus: row.toStatus,
      amount: row.amount === null ? null : round2(toNumber(row.amount)),
      counterparty: row.counterparty,
      voucherRef: row.voucherRef,
      operator: row.operator,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  /* ========== D-02 备查簿与到期预警 ========== */

  async register(): Promise<NoteRegisterResult> {
    const rows = await this.db
      .select({
        status: erpNote.status,
        noteType: erpNote.noteType,
        amount: erpNote.amount,
      })
      .from(erpNote);
    return noteRegisterSummary(
      rows.map((row) => ({
        status: row.status ?? 'received',
        noteType: row.noteType ?? 'bank',
        amount: round2(toNumber(row.amount)),
      }))
    );
  }

  /**
   * D-02：备查簿深化汇总。
   *
   * 四块内容拼成一份可直接给税务/审计的摘要：
   *   ① 状态分布；② **到期结构**（账龄分桶，看流动性压力）；
   *   ③ **票号连续性检查**（缺号/重号 —— 《票据管理实施办法》的硬要求）；
   *   ④ **贴现成本分析**（综合成本率与年化率，资金成本分析的基础数据）。
   *
   * 为什么四块共用一次取数：分散查询会因时间差导致"状态分布的总数"
   * 与"到期结构的总数"不一致，审计看到两个数字对不上会直接质疑整份报告。
   */
  async registerDeep(): Promise<NoteRegisterDeepResult> {
    const today = todayInShanghai();
    const rows = await this.db
      .select({
        id: erpNote.id,
        code: erpNote.code,
        noteNo: erpNote.noteNo,
        noteType: erpNote.noteType,
        status: erpNote.status,
        amount: erpNote.amount,
        drawer: erpNote.drawer,
        dueDate: erpNote.dueDate,
        discountInterest: erpNote.discountInterest,
        discountRate: erpNote.discountRate,
        discountDays: erpNote.discountDays,
      })
      .from(erpNote)
      .orderBy(asc(erpNote.dueDate));
    return buildNoteRegister(
      rows.map((row) => ({
        id: row.id,
        code: row.code,
        noteNo: row.noteNo,
        noteType: row.noteType ?? 'bank',
        status: row.status ?? 'received',
        amount: round2(toNumber(row.amount)),
        drawer: row.drawer,
        dueDate: row.dueDate,
        // 距今天数由服务端按业务时区算，前端不自己算（避免时区口径漂移）
        daysLeft: daysBetween(row.dueDate, today),
        discountInterest:
          row.discountInterest === null
            ? null
            : round2(toNumber(row.discountInterest)),
        discountRate:
          row.discountRate === null ? null : round2(toNumber(row.discountRate)),
        discountDays:
          row.discountDays === null ? null : Math.trunc(toNumber(row.discountDays)),
      })),
      today
    );
  }

  async dueAlerts(): Promise<NoteDueAlert[]> {
    const rows = await this.db
      .select({
        code: erpNote.code,
        noteNo: erpNote.noteNo,
        status: erpNote.status,
        amount: erpNote.amount,
        dueDate: erpNote.dueDate,
      })
      .from(erpNote);
    return dueAlerts(
      rows.map((row) => ({
        code: row.code,
        noteNo: row.noteNo,
        status: row.status ?? 'received',
        amount: round2(toNumber(row.amount)),
        dueDate: row.dueDate,
      })),
      todayInShanghai()
    );
  }

  /** 供 cron / 手工调用的预警文本（返回给调用方决定怎么发） */
  buildAlertText(alerts: NoteDueAlert[]): string {
    if (alerts.length === 0) return '当前无临期或逾期票据。';
    return [
      `票据到期提醒（共 ${alerts.length} 张）：`,
      ...alerts.map((alert) => {
        const when =
          alert.daysLeft < 0
            ? `已逾期 ${-alert.daysLeft} 天`
            : alert.daysLeft === 0
              ? '今日到期'
              : `${alert.daysLeft} 天后到期`;
        return `· ${alert.noteNo}（${alert.code}）${alert.amount.toFixed(2)} 元 — ${when}（${alert.dueDate}）`;
      }),
    ].join('\n');
  }

  /* ========== 登记 ========== */

  async createNote(dto: CreateNoteDto): Promise<NoteItem> {
    if (!NOTE_TYPES.includes(dto.noteType)) {
      throw new BadRequestException(
        `票据类型仅支持 ${NOTE_TYPES.map((t) => `${t}（${NOTE_TYPE_LABELS[t]}）`).join(' / ')}`
      );
    }
    if (!(dto.amount > 0)) {
      throw new BadRequestException('票面金额必须大于 0');
    }
    // 关联对象必须存在于对应主数据，避免挂到不存在的客户/供应商
    if (dto.supplierId) await this.assertSupplierExists(dto.supplierId);
    if (dto.customerId) await this.assertCustomerExists(dto.customerId);

    const code = await generateBizCode(
      this.db,
      erpNote,
      erpNote.code,
      'NOTE',
      new Date(),
      { bizType: 'NOTE' }
    );
    try {
      const inserted = await this.db
        .insert(erpNote)
        .values({
          code,
          noteNo: dto.noteNo,
          noteType: dto.noteType,
          drawer: dto.drawer ?? null,
          payee: dto.payee ?? null,
          amount: String(round2(dto.amount)),
          issueDate: dto.issueDate ?? null,
          dueDate: dto.dueDate,
          status: 'received',
          arId: dto.arId ?? null,
          apId: dto.apId ?? null,
          supplierId: dto.supplierId ?? null,
          customerId: dto.customerId ?? null,
          projectId: dto.projectId ?? null,
          remark: dto.remark ?? null,
        })
        .returning({ id: erpNote.id });
      await this.writeLog({
        noteId: inserted[0].id,
        action: 'receive',
        fromStatus: null,
        toStatus: 'received',
        amount: round2(dto.amount),
        counterparty: dto.drawer ?? null,
        remark: '票据登记入账',
      });
      this.logger.log(
        `票据登记 ${code} 票号=${dto.noteNo} 金额=${dto.amount} 到期=${dto.dueDate}`
      );
      return this.getNoteById(inserted[0].id);
    } catch (error) {
      // uq_erp_note_no：同一张票据不允许重复入账
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('uq_erp_note_no')) {
        throw new ConflictException(
          `票号 ${dto.noteNo} 已登记，同一张票据不允许重复入账`
        );
      }
      throw error;
    }
  }

  /* ========== 贴现试算 ========== */

  /** 贴现预览：提交前把息费、到账额与分录摊开给财务确认 */
  async previewDiscount(
    id: string,
    discountRate: number,
    discountDate?: string
  ): Promise<NoteDiscountPreview> {
    const note = await this.getNoteById(id);
    const errors = validateNoteAction(note.status, 'discount');
    if (errors.length > 0) throw new BadRequestException(errors.join('；'));
    if (!Number.isFinite(discountRate) || discountRate < 0) {
      throw new BadRequestException('贴现率必须为不小于 0 的数值');
    }
    const date = discountDate ?? todayInShanghai();
    const result = computeDiscount({
      amount: note.amount,
      rate: discountRate,
      discountDate: date,
      dueDate: note.dueDate,
    });
    const lines = noteActionLines('discount', note.amount, result.interest);
    return {
      amount: note.amount,
      rate: discountRate,
      days: result.days,
      interest: result.interest,
      netProceeds: result.netProceeds,
      lines: lines.map((line) => ({
        accountCode: line.accountCode,
        debit: round2(line.debit ?? 0),
        credit: round2(line.credit ?? 0),
      })),
    };
  }

  /* ========== 流转 ========== */

  async noteAction(
    id: string,
    dto: NoteActionDto,
    operator: string
  ): Promise<NoteItem> {
    const note = await this.getNoteById(id);
    const errors = validateNoteAction(note.status, dto.action);
    if (errors.length > 0) throw new BadRequestException(errors.join('；'));

    if (
      NOTE_ACTION_REQUIRES_COUNTERPARTY.includes(dto.action) &&
      !dto.counterparty
    ) {
      throw new BadRequestException(
        `「${NOTE_ACTION_LABELS[dto.action]}」必须填写受让方（counterparty）`
      );
    }
    if (NOTE_ACTION_REQUIRES_RATE.includes(dto.action)) {
      if (dto.discountRate === undefined || dto.discountRate === null) {
        throw new BadRequestException('贴现必须填写贴现率（discountRate，单位 %）');
      }
      if (!Number.isFinite(dto.discountRate) || dto.discountRate < 0) {
        throw new BadRequestException('贴现率必须为不小于 0 的数值');
      }
    }

    const actionDate =
      dto.action === 'discount'
        ? (dto.discountDate ?? todayInShanghai())
        : dto.action === 'settle'
          ? (dto.settledDate ?? todayInShanghai())
          : todayInShanghai();

    // 贴现息：必须用「贴现日 → 到期日」的天数，不能用「今天」，否则补录历史贴现会算错
    let interest = 0;
    if (dto.action === 'discount') {
      interest = computeDiscount({
        amount: note.amount,
        rate: dto.discountRate ?? 0,
        discountDate: actionDate,
        dueDate: note.dueDate,
      }).interest;
    }
    const settledAmount =
      dto.action === 'discount'
        ? round2(note.amount - interest)
        : dto.action === 'settle'
          ? round2(dto.settledAmount ?? note.amount)
          : null;

    const targetStatus = NOTE_ACTION_TARGET[dto.action];
    const lines = noteActionLines(dto.action, note.amount, interest);
    const sourceRef = `note:${note.code}:${dto.action}`;
    const voucherResult = await this.voucherHookService.generateVoucherDraft({
      sourceType: 'note',
      sourceRef,
      voucherDate: actionDate,
      summary: `票据${NOTE_ACTION_LABELS[dto.action]} ${note.noteNo}`,
      lines,
    });
    if (voucherResult === 'failed') {
      await this.voucherHookService.recordCompensation(
        'note',
        sourceRef,
        `票据${NOTE_ACTION_LABELS[dto.action]}凭证生成失败 ${note.code}`,
        lines,
        actionDate
      );
    }

    const patch: Record<string, unknown> = {
      status: targetStatus,
      updatedAt: new Date(),
    };
    if (dto.action === 'endorse') {
      patch.endorsementCounterparty = dto.counterparty;
    }
    if (dto.action === 'discount') {
      patch.discountRate = String(round2(dto.discountRate ?? 0));
      patch.discountInterest = String(interest);
      // D-02：落库计息天数。贴现天数在贴现那一刻固定，不能日后从
      // settled_date/due_date 现算 —— 那会随查询时间漂移出不同的年化率。
      patch.discountDays = computeDiscount({
        amount: note.amount,
        rate: dto.discountRate ?? 0,
        discountDate: actionDate,
        dueDate: note.dueDate,
      }).days;
      patch.settledAmount = String(settledAmount ?? 0);
      patch.settledDate = actionDate;
    }
    if (dto.action === 'settle') {
      patch.settledAmount = String(settledAmount ?? note.amount);
      patch.settledDate = actionDate;
    }
    await this.db.update(erpNote).set(patch).where(eq(erpNote.id, id));

    try {
      await this.writeLog({
        noteId: id,
        action: dto.action,
        fromStatus: note.status,
        toStatus: targetStatus,
        amount:
          dto.action === 'discount'
            ? settledAmount
            : dto.action === 'settle'
              ? settledAmount
              : note.amount,
        counterparty: dto.counterparty ?? null,
        voucherRef: voucherResult === 'created' ? sourceRef : null,
        operator,
        remark: dto.remark ?? null,
      });
    } catch (error) {
      // uq_erp_note_log_action：同一动作只允许一次 —— 并发重复提交时状态已改，
      // 这里把日志唯一冲突翻译成明确的 409，避免用户以为"操作成功了两次"
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('uq_erp_note_log_action')) {
        throw new ConflictException(
          `该票据的「${NOTE_ACTION_LABELS[dto.action]}」已执行过，不允许重复操作`
        );
      }
      throw error;
    }
    this.logger.warn(
      `票据${NOTE_ACTION_LABELS[dto.action]} ${note.code} ${note.status}→${targetStatus} ` +
        `金额=${note.amount}${interest > 0 ? ` 贴现息=${interest}` : ''} by=${operator}`
    );
    return this.getNoteById(id);
  }

  /* ========== 内部工具 ========== */

  private async writeLog(input: {
    noteId: string;
    action: string;
    fromStatus: string | null;
    toStatus: string;
    amount?: number | null;
    counterparty?: string | null;
    voucherRef?: string | null;
    operator?: string | null;
    remark?: string | null;
  }): Promise<void> {
    await this.db.insert(erpNoteLog).values({
      noteId: input.noteId,
      action: input.action,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      amount: input.amount === null || input.amount === undefined
        ? null
        : String(input.amount),
      counterparty: input.counterparty ?? null,
      voucherRef: input.voucherRef ?? null,
      operator: input.operator ?? null,
      remark: input.remark ?? null,
    });
  }

  private async assertSupplierExists(id: string): Promise<void> {
    const rows = await this.db
      .select({ id: mdSupplier.id })
      .from(mdSupplier)
      .where(eq(mdSupplier.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('供应商不存在');
  }

  private async assertCustomerExists(id: string): Promise<void> {
    const rows = await this.db
      .select({ id: mdCustomer.id })
      .from(mdCustomer)
      .where(eq(mdCustomer.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('客户不存在');
  }

  /** 贴现息基准（暴露给前端展示口径说明，避免业务方疑惑数字怎么来的） */
  discountBasis(): { basis: number; note: string } {
    return {
      basis: DISCOUNT_DAY_BASIS,
      note: `贴现息 = 票面 × 贴现率/100 × 贴现天数/${DISCOUNT_DAY_BASIS}，贴现天数按「算头不算尾」`,
    };
  }

  /** 关联单据的余额快照（票据详情页展示"这张票冲的是哪笔应收/应付"） */
  async linkedDocument(id: string): Promise<{
    ar: { code: string; amount: number; settledAmount: number } | null;
    ap: { code: string; amount: number; paidAmount: number } | null;
  }> {
    const note = await this.getNoteById(id);
    let ar: { code: string; amount: number; settledAmount: number } | null = null;
    let ap: { code: string; amount: number; paidAmount: number } | null = null;
    if (note.arId) {
      const rows = await this.db
        .select({
          code: erpAr.code,
          amount: erpAr.amount,
          settledAmount: erpAr.settledAmount,
        })
        .from(erpAr)
        .where(eq(erpAr.id, note.arId))
        .limit(1);
      if (rows[0]) {
        ar = {
          code: rows[0].code,
          amount: round2(toNumber(rows[0].amount)),
          settledAmount: round2(toNumber(rows[0].settledAmount)),
        };
      }
    }
    if (note.apId) {
      const rows = await this.db
        .select({
          code: erpApBill.code,
          amount: erpApBill.amount,
          paidAmount: erpApBill.paidAmount,
        })
        .from(erpApBill)
        .where(eq(erpApBill.id, note.apId))
        .limit(1);
      if (rows[0]) {
        ap = {
          code: rows[0].code,
          amount: round2(toNumber(rows[0].amount)),
          paidAmount: round2(toNumber(rows[0].paidAmount)),
        };
      }
    }
    return { ar, ap };
  }

  /**
   * 状态与动作字典（前端渲染操作按钮用，避免前端硬编码状态机）。
   *
   * ## 为什么 `actions` 里要带 `allowedFrom`（真实缺陷修复）
   *
   * 票据页的操作列只列"当前状态允许的动作"，但它原先**没有**拿到权威状态机，
   * 只能在前端自己写一份过滤 —— 而那份只钉了 `endorse` / `discount` 两个动作，
   * 其余落到 `return true` 兜底。后果是**已背书 / 已贴现**的票据
   * （两者都不是终态，默认"未结清"筛选下就在列表里）多出一个「确认持有」按钮，
   * 而 `NOTE_TRANSITIONS.hold = ['received', 'held']` —— 点下去必然被本服务的
   * `noteAction()`（第一行的 `validateNoteAction()`）以 400
   * 「「确认持有」不允许从「已背书」发起，允许的前置状态：已收到 / 持有中」拒绝。
   *
   * 这类"前端显示点了必然失败的按钮"与本仓 B-01 已修复的
   * `finance_viewer` 越权按钮是同一类问题。修法是**把允许前置状态随字典一起下发**
   * （`allowedFrom` = `NOTE_TRANSITIONS[action]`，唯一真源仍是
   * `server/common/tax/note-rules.ts`）—— 前端因此**不再持有任何状态机副本**，
   * 状态机改动不会再出现"前后端各写一份、改一处漏一处"。
   *
   * ⚠️ 与 `target`（动作完成后的状态）不同：`target` 是"结果"，
   * `allowedFrom` 是"前置条件"，前端做按钮显隐要用后者。
   */
  dictionaries(): {
    statuses: Array<{ value: NoteStatus; label: string }>;
    types: Array<{ value: NoteType; label: string }>;
    actions: Array<{
      value: NoteAction;
      label: string;
      target: NoteStatus;
      requiresCounterparty: boolean;
      requiresRate: boolean;
      /** 该动作允许的前置状态（= `NOTE_TRANSITIONS[action]`），前端据此显隐按钮 */
      allowedFrom: NoteStatus[];
    }>;
  } {
    const statusOrder: NoteStatus[] = [
      'received',
      'held',
      'endorsed',
      'discounted',
      'settled',
      'dishonored',
    ];
    return {
      statuses: statusOrder.map((value) => ({
        value,
        label: NOTE_STATUS_LABELS[value],
      })),
      types: NOTE_TYPES.map((value) => ({
        value,
        label: NOTE_TYPE_LABELS[value],
      })),
      actions: (
        ['hold', 'endorse', 'discount', 'settle', 'dishonor'] as NoteAction[]
      ).map((value) => ({
        value,
        label: NOTE_ACTION_LABELS[value],
        target: NOTE_ACTION_TARGET[value],
        requiresCounterparty: NOTE_ACTION_REQUIRES_COUNTERPARTY.includes(value),
        requiresRate: NOTE_ACTION_REQUIRES_RATE.includes(value),
        // 展开成新数组：不要把状态机的模块级数组直接交给调用方（可被改写）
        allowedFrom: [...NOTE_TRANSITIONS[value]],
      })),
    };
  }

  /** 未结清票据数（给待办中心/看板角标用） */
  async outstandingCount(): Promise<number> {
    const rows = await this.db.execute(sql`
      SELECT count(*)::int AS total FROM erp_note
      WHERE status NOT IN ('settled', 'dishonored')
    `);
    const row = unwrapRows<{ total: number }>(rows)[0];
    return Number(row?.total ?? 0);
  }

  /** 终态判定（前端禁用按钮的权威来源，避免前后端各写一套） */
  isTerminal(status: string): boolean {
    return TERMINAL_NOTE_STATUSES.includes(status as NoteStatus);
  }
}
