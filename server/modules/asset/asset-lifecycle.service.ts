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
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import {
  astAsset,
  astChange,
  astDepreciation,
  astDisposal,
  astImpairment,
  erpProject,
  hrDepartment,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { unwrapRows } from '@server/common/utils/rows';
import {
  assetDisposalLines,
  assetImpairmentLines,
} from '@server/common/tax/posting';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import type {
  AssetDisposalItem,
  AssetImpairmentItem,
  AssetLifecycleEvent,
  AssetLifecycleResult,
  CreateAssetDisposalDto,
  CreateAssetImpairmentDto,
  DisposalAction,
  ImpairmentTestPreview,
} from '@shared/api.interface';

/**
 * D-08：资产全生命周期（采购建卡 → 变更归属 → 折旧 → 减值 → 处置 → 报废）。
 *
 * 定位：`AssetService` 负责卡片与变更的 CRUD，折旧在 `AssetDepreciationService`，
 * 本服务负责**减值与处置**以及把三者串成一条可追溯的时间线。
 *
 * 会计口径（需财务确认，见迁移 `2026-10-15-upgrade-batch3-asset-accounts.sql`）：
 * - 减值：借 6701 资产减值损失 / 贷 1604 固定资产减值准备（备抵科目，不冲减原值）
 * - 处置：借 1603 固定资产清理 + 借 1602 + 借 1604 / 贷 1601；
 *         处置收入 借 1002 / 贷 1603（+ 贷 222101）；
 *         净额 借 6711（损失）或 贷 6301（收益）。
 *
 * 金额恒等式（单测断言）：`gainLoss = 处置收入 − 销项税 − 净值`，
 * 其中 `净值 = 原值 − 累计折旧 − 已计提减值准备`；
 * 凭证借贷必须平衡，且 1603 在分录中自动轧平为 0。
 */

/** 可处置的资产状态（已处置/报废的不允许再次处置） */
const DISPOSABLE_STATUSES = ['in_use', 'idle', 'repair'];
/** 允许减值测试的状态：已处置的资产不再测试 */
const IMPAIRABLE_STATUSES = ['in_use', 'idle', 'repair'];
const DISPOSAL_TYPES = ['sale', 'scrap', 'donate'] as const;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** 业务月末（业务时区概念上的当月最后一天，仅用于凭证日期） */
function periodEndDate(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(lastDay).padStart(2, '0')}`;
}

interface AssetRow {
  id: string;
  code: string;
  name: string | null;
  category: string | null;
  status: string | null;
  originalValue: string | null;
  netValue: string | null;
  residualValue: string | null;
  usefulMonths: number | null;
  purchaseDate: string | null;
  departmentId: string | null;
  projectId: string | null;
  purchaseOrderId: string | null;
  remark: string | null;
}

@Injectable()
export class AssetLifecycleService {
  private readonly logger = new Logger(AssetLifecycleService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly voucherHookService: VoucherHookService,
  ) {}

  /* ========== 资产快照与累计减值 ========== */

  private async loadAsset(id: string): Promise<AssetRow> {
    const rows = await this.db
      .select({
        id: astAsset.id,
        code: astAsset.code,
        name: astAsset.name,
        category: astAsset.category,
        status: astAsset.status,
        originalValue: astAsset.originalValue,
        netValue: astAsset.netValue,
        residualValue: astAsset.residualValue,
        usefulMonths: astAsset.usefulMonths,
        purchaseDate: astAsset.purchaseDate,
        departmentId: astAsset.departmentId,
        projectId: astAsset.projectId,
        purchaseOrderId: astAsset.purchaseOrderId,
        remark: astAsset.remark,
      })
      .from(astAsset)
      .where(eq(astAsset.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('固定资产不存在');
    return rows[0];
  }

  /**
   * 累计折旧合计。
   *
   * 为什么不用 `ast_asset.accumulated_depreciation`：该列在当前 schema 中**不存在**
   * （卡片表只有 `net_value` 作为冗余净值）。折旧的唯一事实来源是
   * `ast_depreciation` 明细，因此这里按资产汇总，避免读到不存在的列。
   */
  async totalDepreciation(assetId: string): Promise<number> {
    const rows = await this.db
      .select({
        total: sql<string>`coalesce(sum(${astDepreciation.amount}), 0)`,
      })
      .from(astDepreciation)
      .where(eq(astDepreciation.assetId, assetId));
    return round2(toNumber(rows[0]?.total));
  }

  /** 已计提的减值准备合计（1604 口径） */
  async totalImpairment(assetId: string): Promise<number> {
    const rows = await this.db
      .select({
        total: sql<string>`coalesce(sum(${astImpairment.impairmentLoss}), 0)`,
      })
      .from(astImpairment)
      .where(eq(astImpairment.assetId, assetId));
    return round2(toNumber(rows[0]?.total));
  }

  /**
   * 账面价值（减值测试基准）= 原值 − 累计折旧 − 已计提减值准备。
   * 下限为 0：累计折旧+减值不可能超过原值（超出说明历史数据有误，
   * 这里 clamp 而不是抛错，避免因历史脏数据导致整个减值流程不可用）。
   */
  private bookValueOf(
    asset: AssetRow,
    accumulatedDepreciation: number,
    impairment: number
  ): number {
    const original = toNumber(asset.originalValue);
    return round2(
      Math.max(original - accumulatedDepreciation - impairment, 0)
    );
  }

  /* ========== D-08 ③：减值测试 ========== */

  /**
   * 减值测试预览（不落库）：
   * 减值损失 = max(账面价值 − 可收回金额, 0)。
   * 可收回金额 = max(公允价值减处置费用, 预计未来现金流量现值)，
   * 由调用方按评估结果传入（本系统不做估值模型）。
   */
  async previewImpairmentTest(params: {
    assetId: string;
    recoverableAmount: number;
  }): Promise<ImpairmentTestPreview> {
    const asset = await this.loadAsset(params.assetId);
    if (!IMPAIRABLE_STATUSES.includes(asset.status ?? 'in_use')) {
      throw new BadRequestException(
        `资产 ${asset.code} 当前状态为 ${asset.status}，不可计提减值`
      );
    }
    if (!Number.isFinite(params.recoverableAmount) || params.recoverableAmount < 0) {
      throw new BadRequestException('可收回金额必须为不小于 0 的数值');
    }
    const accumulatedImpairment = await this.totalImpairment(params.assetId);
    const accumulatedDepreciation = await this.totalDepreciation(params.assetId);
    const bookValue = this.bookValueOf(
      asset,
      accumulatedDepreciation,
      accumulatedImpairment
    );
    const recoverableAmount = round2(params.recoverableAmount);
    const impairmentLoss = round2(Math.max(bookValue - recoverableAmount, 0));
    return {
      assetId: asset.id,
      assetCode: asset.code,
      assetName: asset.name ?? '',
      originalValue: round2(toNumber(asset.originalValue)),
      accumulatedDepreciation,
      accumulatedImpairment,
      bookValue,
      recoverableAmount,
      impairmentLoss,
      /** 是否需要计提（损失为 0 时无需建单） */
      needsImpairment: impairmentLoss > 0,
      /** 测试后可收回金额低于残值时的提示（不阻断，仅供复核） */
      belowResidual:
        recoverableAmount < round2(toNumber(asset.residualValue)),
    };
  }

  /** 计提减值（落库 + 生成凭证）；凭证失败不阻断建单，但记录补偿队列 */
  async createImpairment(
    dto: CreateAssetImpairmentDto,
    userId: string
  ): Promise<AssetImpairmentItem> {
    const preview = await this.previewImpairmentTest({
      assetId: dto.assetId,
      recoverableAmount: dto.recoverableAmount,
    });
    if (preview.impairmentLoss <= 0) {
      throw new BadRequestException(
        `可收回金额 ${preview.recoverableAmount} 不低于账面价值 ${preview.bookValue}，无需计提减值`
      );
    }
    const asset = await this.loadAsset(dto.assetId);
    const code = await generateBizCode(
      this.db,
      astImpairment,
      astImpairment.code,
      'IMP',
      new Date(),
      { bizType: 'ASSET_IMPAIRMENT' }
    );
    // 同一资产同一期间只允许一次减值测试（防止重复计提）
    const dup = await this.db
      .select({ id: astImpairment.id })
      .from(astImpairment)
      .where(
        and(
          eq(astImpairment.assetId, dto.assetId),
          eq(astImpairment.period, dto.period)
        )
      )
      .limit(1);
    if (dup.length > 0) {
      throw new ConflictException(
        `资产 ${asset.code} 在期间 ${dto.period} 已有减值记录，如需更正请先删除该记录`
      );
    }

    const sourceRef = `asset-impairment:${code}`;
    const lines = assetImpairmentLines(preview.impairmentLoss);
    const voucherResult = await this.voucherHookService.generateVoucherDraft({
      sourceType: 'impairment',
      sourceRef,
      voucherDate: dto.testDate,
      summary: `固定资产减值 ${asset.code} ${asset.name ?? ''}`.trim(),
      lines,
    });
    if (voucherResult === 'failed') {
      await this.voucherHookService.recordCompensation(
        'impairment',
        sourceRef,
        `减值凭证生成失败 ${code}`,
        lines,
        dto.testDate
      );
    }

    const inserted = await this.db
      .insert(astImpairment)
      .values({
        code,
        assetId: dto.assetId,
        testDate: dto.testDate,
        period: dto.period,
        bookValue: String(preview.bookValue),
        recoverableAmount: String(preview.recoverableAmount),
        impairmentLoss: String(preview.impairmentLoss),
        method: dto.method ?? 'recoverable_vs_book',
        voucherRef: voucherResult === 'created' ? sourceRef : null,
        remark: dto.remark ?? null,
      })
      .returning();
    this.logger.warn(
      `计提固定资产减值 ${code} asset=${asset.code} loss=${preview.impairmentLoss} by=${userId}`
    );
    void lines;
    return this.toImpairmentItem(inserted[0], asset);
  }

  async listImpairments(params: {
    assetId?: string;
    period?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ items: AssetImpairmentItem[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 200);
    const conditions = [];
    if (params.assetId) conditions.push(eq(astImpairment.assetId, params.assetId));
    if (params.period) conditions.push(eq(astImpairment.period, params.period));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const totalRows = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(astImpairment)
      .where(where);
    const rows = await this.db
      .select({
        impairment: astImpairment,
        assetCode: astAsset.code,
        assetName: astAsset.name,
      })
      .from(astImpairment)
      .leftJoin(astAsset, eq(astImpairment.assetId, astAsset.id))
      .where(where)
      .orderBy(desc(astImpairment.testDate), desc(astImpairment.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      items: rows.map((row) =>
        this.toImpairmentItem(row.impairment, {
          code: row.assetCode ?? '',
          name: row.assetName,
        } as AssetRow)
      ),
      total: Number(totalRows[0]?.total ?? 0),
      page,
      pageSize,
    };
  }

  /** 删除减值记录（仅未生成凭证或凭证已作废时可删；用于更正错误测试） */
  async deleteImpairment(id: string, userId: string): Promise<{ ok: true }> {
    const rows = await this.db
      .select({
        id: astImpairment.id,
        code: astImpairment.code,
        voucherRef: astImpairment.voucherRef,
        assetId: astImpairment.assetId,
      })
      .from(astImpairment)
      .where(eq(astImpairment.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('减值记录不存在');
    if (rows[0].voucherRef) {
      throw new BadRequestException(
        `减值记录 ${rows[0].code} 已生成凭证（${rows[0].voucherRef}），请先作废凭证再删除；否则账实不符`
      );
    }
    await this.db.delete(astImpairment).where(eq(astImpairment.id, id));
    this.logger.warn(`删除减值记录 ${rows[0].code} by=${userId}`);
    return { ok: true };
  }

  private toImpairmentItem(
    row: {
      id: string;
      code: string;
      assetId: string;
      testDate: string;
      period: string | null;
      bookValue: string | null;
      recoverableAmount: string | null;
      impairmentLoss: string | null;
      method: string;
      voucherRef: string | null;
      remark: string | null;
      createdAt: Date;
    },
    asset: Pick<AssetRow, 'code' | 'name'>
  ): AssetImpairmentItem {
    return {
      id: row.id,
      code: row.code,
      assetId: row.assetId,
      assetCode: asset.code,
      assetName: asset.name ?? '',
      testDate: row.testDate,
      period: row.period ?? '',
      bookValue: round2(toNumber(row.bookValue)),
      recoverableAmount: round2(toNumber(row.recoverableAmount)),
      impairmentLoss: round2(toNumber(row.impairmentLoss)),
      method: row.method,
      voucherRef: row.voucherRef,
      remark: row.remark,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /* ========== D-08 ④：处置与报废 ========== */

  /** 处置预览：给出净值、预计损益与将生成的分录（前端确认后再提交） */
  async previewDisposal(params: {
    assetId: string;
    disposalType: 'sale' | 'scrap' | 'donate';
    disposalIncome?: number;
    taxRate?: number;
  }): Promise<{
    netBookValue: number;
    accumulatedImpairment: number;
    taxAmount: number;
    gainLoss: number;
    lines: Array<{ accountCode: string; debit: number; credit: number }>;
  }> {
    const asset = await this.loadAsset(params.assetId);
    const accumulatedImpairment = await this.totalImpairment(params.assetId);
    const accumulated = await this.totalDepreciation(params.assetId);
    const original = round2(toNumber(asset.originalValue));
    const netBookValue = round2(
      Math.max(original - accumulated - accumulatedImpairment, 0)
    );
    const income = round2(Math.max(params.disposalIncome ?? 0, 0));
    const rate = params.taxRate ?? 0;
    // 销项税按含税收入倒算，与 shared/tax.splitTax 口径一致
    const taxAmount =
      income > 0 && rate > 0
        ? round2(Math.round(((income * rate) / (100 + rate)) * 100) / 100)
        : 0;
    const { lines, gainLoss } = assetDisposalLines({
      originalValue: original,
      accumulatedDepreciation: accumulated,
      impairmentProvision: accumulatedImpairment,
      disposalIncome: income,
      outputTax: taxAmount,
      disposalType: params.disposalType,
    });
    return {
      netBookValue,
      accumulatedImpairment,
      taxAmount,
      gainLoss,
      lines: lines.map((line) => ({
        accountCode: line.accountCode,
        debit: round2(line.debit ?? 0),
        credit: round2(line.credit ?? 0),
      })),
    };
  }

  /** 提交处置申请（状态机 disposing，尚未生成凭证） */
  async createDisposal(
    dto: CreateAssetDisposalDto,
    userId: string
  ): Promise<AssetDisposalItem> {
    if (!DISPOSAL_TYPES.includes(dto.disposalType)) {
      throw new BadRequestException(
        `处置方式仅支持 ${DISPOSAL_TYPES.join(' / ')}`
      );
    }
    const asset = await this.loadAsset(dto.assetId);
    if (!DISPOSABLE_STATUSES.includes(asset.status ?? 'in_use')) {
      throw new BadRequestException(
        `资产 ${asset.code} 当前状态为 ${asset.status}，不可处置（已处置/报废的资产不能重复处置）`
      );
    }
    const pending = await this.db
      .select({ id: astDisposal.id })
      .from(astDisposal)
      .where(
        and(eq(astDisposal.assetId, dto.assetId), eq(astDisposal.status, 'disposing'))
      )
      .limit(1);
    if (pending.length > 0) {
      throw new ConflictException(
        `资产 ${asset.code} 已有待完成的处置申请，请先完成或驳回`
      );
    }
    const preview = await this.previewDisposal({
      assetId: dto.assetId,
      disposalType: dto.disposalType,
      disposalIncome: dto.disposalIncome,
      taxRate: dto.taxRate,
    });
    const code = await generateBizCode(
      this.db,
      astDisposal,
      astDisposal.code,
      'DSP',
      new Date(),
      { bizType: 'ASSET_DISPOSAL' }
    );
    const inserted = await this.db
      .insert(astDisposal)
      .values({
        code,
        assetId: dto.assetId,
        disposalType: dto.disposalType,
        status: 'disposing',
        applyDate: dto.applyDate,
        originalValue: String(round2(toNumber(asset.originalValue))),
        accumulatedDepreciation: String(await this.totalDepreciation(dto.assetId)),
        netValue: String(preview.netBookValue),
        disposalIncome: String(round2(Math.max(dto.disposalIncome ?? 0, 0))),
        taxRate: dto.taxRate == null ? null : String(dto.taxRate),
        taxAmount: String(preview.taxAmount),
        gainLoss: String(preview.gainLoss),
        reason: dto.reason ?? null,
        remark: dto.remark ?? null,
      })
      .returning();
    this.logger.log(
      `提交资产处置 ${code} asset=${asset.code} type=${dto.disposalType} by=${userId}`
    );
    return this.toDisposalItem(inserted[0], asset);
  }

  /**
   * 处置审批：`complete` 生成凭证并置 `disposed`/`scrapped`，`reject` 置 `rejected`。
   *
   * 关键：**先置状态再生成凭证的顺序不重要，但凭证生成必须与状态变更解耦**——
   * 凭证失败时保留 `disposing` 会被误认为"未处理"，因此这里选择
   * "状态先落 disposed，凭证失败进补偿队列"，并在响应里如实返回 `voucherRef: null`，
   * 由运维通过凭证失败队列补录（与全仓其它业务一致）。
   */
  async disposalAction(
    id: string,
    action: DisposalAction,
    userId: string
  ): Promise<AssetDisposalItem> {
    const rows = await this.db
      .select()
      .from(astDisposal)
      .where(eq(astDisposal.id, id))
      .limit(1);
    if (rows.length === 0) throw new NotFoundException('处置单不存在');
    const disposal = rows[0];
    if (disposal.status !== 'disposing') {
      throw new BadRequestException(
        `处置单当前状态为 ${disposal.status}，仅"处置中"可审批`
      );
    }
    const asset = await this.loadAsset(disposal.assetId);

    if (action === 'reject') {
      const updated = await this.db
        .update(astDisposal)
        .set({
          status: 'rejected',
          approvedBy: userId,
          updatedAt: new Date(),
        })
        .where(eq(astDisposal.id, id))
        .returning();
      return this.toDisposalItem(updated[0], asset);
    }

    const accumulatedImpairment = await this.totalImpairment(disposal.assetId);
    const { lines, gainLoss } = assetDisposalLines({
      originalValue: toNumber(disposal.originalValue),
      accumulatedDepreciation: toNumber(disposal.accumulatedDepreciation),
      impairmentProvision: accumulatedImpairment,
      disposalIncome: toNumber(disposal.disposalIncome),
      outputTax: toNumber(disposal.taxAmount),
      disposalType: (disposal.disposalType ?? 'scrap') as
        | 'sale'
        | 'scrap'
        | 'donate',
    });
    const finalStatus =
      disposal.disposalType === 'scrap' ? 'scrapped' : 'disposed';
    const sourceRef = `asset-disposal:${disposal.code}`;
    const voucherDate = disposal.disposeDate ?? disposal.applyDate;
    const voucherResult = await this.voucherHookService.generateVoucherDraft({
      sourceType: 'disposal',
      sourceRef,
      voucherDate,
      summary: `固定资产处置 ${asset.code} ${asset.name ?? ''}`.trim(),
      lines,
    });
    if (voucherResult === 'failed') {
      await this.voucherHookService.recordCompensation(
        'disposal',
        sourceRef,
        `处置凭证生成失败 ${disposal.code}`,
        lines,
        voucherDate
      );
    }
    await this.db
      .update(astDisposal)
      .set({
        status: finalStatus,
        gainLoss: String(gainLoss),
        voucherRef: voucherResult === 'created' ? sourceRef : null,
        approvedBy: userId,
        disposeDate: disposal.disposeDate ?? voucherDate,
        updatedAt: new Date(),
      })
      .where(eq(astDisposal.id, id));
    // 同步资产卡片状态，避免"已处置但卡片仍显示在用"
    await this.db
      .update(astAsset)
      .set({
        status: finalStatus === 'scrapped' ? 'scrapped' : 'disposed',
        netValue: '0',
        updatedAt: new Date(),
      })
      .where(eq(astAsset.id, disposal.assetId));
    this.logger.warn(
      `资产处置完成 ${disposal.code} asset=${asset.code} gainLoss=${gainLoss} by=${userId}`
    );
    const refreshed = await this.db
      .select()
      .from(astDisposal)
      .where(eq(astDisposal.id, id))
      .limit(1);
    return this.toDisposalItem(refreshed[0], asset);
  }

  async listDisposals(params: {
    assetId?: string;
    status?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ items: AssetDisposalItem[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(Math.max(params.pageSize ?? 20, 1), 200);
    const conditions = [];
    if (params.assetId) conditions.push(eq(astDisposal.assetId, params.assetId));
    if (params.status) conditions.push(eq(astDisposal.status, params.status));
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const totalRows = await this.db
      .select({ total: sql<number>`count(*)::int` })
      .from(astDisposal)
      .where(where);
    const rows = await this.db
      .select({
        disposal: astDisposal,
        assetCode: astAsset.code,
        assetName: astAsset.name,
      })
      .from(astDisposal)
      .leftJoin(astAsset, eq(astDisposal.assetId, astAsset.id))
      .where(where)
      .orderBy(desc(astDisposal.applyDate), desc(astDisposal.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      items: rows.map((row) =>
        this.toDisposalItem(row.disposal, {
          code: row.assetCode ?? '',
          name: row.assetName,
        } as AssetRow)
      ),
      total: Number(totalRows[0]?.total ?? 0),
      page,
      pageSize,
    };
  }

  private toDisposalItem(
    row: {
      id: string;
      code: string;
      assetId: string;
      disposalType: string;
      status: string;
      applyDate: string;
      disposeDate: string | null;
      originalValue: string | null;
      accumulatedDepreciation: string | null;
      netValue: string | null;
      disposalIncome: string | null;
      taxRate: string | null;
      taxAmount: string | null;
      gainLoss: string | null;
      voucherRef: string | null;
      reason: string | null;
      remark: string | null;
      approvedBy: string | null;
      createdAt: Date;
    },
    asset: Pick<AssetRow, 'code' | 'name'>
  ): AssetDisposalItem {
    return {
      id: row.id,
      code: row.code,
      assetId: row.assetId,
      assetCode: asset.code,
      assetName: asset.name ?? '',
      disposalType: (row.disposalType ?? 'scrap') as AssetDisposalItem['disposalType'],
      status: (row.status ?? 'disposing') as AssetDisposalItem['status'],
      applyDate: row.applyDate,
      disposeDate: row.disposeDate,
      originalValue: round2(toNumber(row.originalValue)),
      accumulatedDepreciation: round2(toNumber(row.accumulatedDepreciation)),
      netValue: round2(toNumber(row.netValue)),
      disposalIncome: round2(toNumber(row.disposalIncome)),
      taxRate: row.taxRate == null ? null : round2(toNumber(row.taxRate)),
      taxAmount: round2(toNumber(row.taxAmount)),
      gainLoss: round2(toNumber(row.gainLoss)),
      voucherRef: row.voucherRef,
      reason: row.reason,
      remark: row.remark,
      approvedBy: row.approvedBy,
      createdAt: row.createdAt.toISOString(),
    };
  }

  /* ========== D-08 ⑤：完整生命周期时间线 ========== */

  /**
   * 把建卡 / 采购来源 / 变更 / 折旧 / 减值 / 处置合并为一条按时间排序的事件流。
   *
   * 为什么需要：需求书 D-08 ⑤ 明确要求"完整生命周期查询"。
   * 分散在四张表里的记录若不在一个时间线上，审计无法判断
   * "某次变更是否发生在减值测试之后"这类顺序问题。
   */
  async lifecycle(assetId: string): Promise<AssetLifecycleResult> {
    const asset = await this.loadAsset(assetId);
    const [changes, depreciations, impairments, disposals] = await Promise.all([
      this.db
        .select()
        .from(astChange)
        .where(eq(astChange.assetId, assetId))
        .orderBy(asc(astChange.createdAt)),
      this.db
        .select()
        .from(astDepreciation)
        .where(eq(astDepreciation.assetId, assetId))
        .orderBy(asc(astDepreciation.period)),
      this.db
        .select()
        .from(astImpairment)
        .where(eq(astImpairment.assetId, assetId))
        .orderBy(asc(astImpairment.testDate)),
      this.db
        .select()
        .from(astDisposal)
        .where(eq(astDisposal.assetId, assetId))
        .orderBy(asc(astDisposal.applyDate)),
    ]);

    const events: AssetLifecycleEvent[] = [];
    if (asset.purchaseDate) {
      events.push({
        eventType: 'purchase',
        occurredAt: asset.purchaseDate,
        title: '采购建卡',
        amount: round2(toNumber(asset.originalValue)),
        refCode: asset.code,
        detail: asset.purchaseOrderId
          ? `来源采购订单 ${asset.purchaseOrderId}`
          : '手工建卡',
      });
    }
    for (const row of changes) {
      events.push({
        eventType: 'change',
        occurredAt: row.createdAt.toISOString().slice(0, 10),
        title: `资产变更（${row.changeType ?? 'transfer'}）`,
        amount: null,
        refCode: row.code,
        detail: [row.beforeValue, row.afterValue, row.remark]
          .filter(Boolean)
          .join(' → '),
      });
    }
    for (const row of depreciations) {
      events.push({
        eventType: 'depreciation',
        occurredAt: row.period ? periodEndDate(row.period) : '',
        title: `折旧计提 ${row.period ?? ''}`.trim(),
        amount: round2(toNumber(row.amount)),
        refCode: row.period ?? '',
        detail: row.remark ?? '',
      });
    }
    for (const row of impairments) {
      events.push({
        eventType: 'impairment',
        occurredAt: row.testDate,
        title: `减值测试（账面 ${round2(toNumber(row.bookValue))} / 可收回 ${round2(toNumber(row.recoverableAmount))}）`,
        amount: round2(toNumber(row.impairmentLoss)),
        refCode: row.code,
        detail: row.voucherRef ?? '未生成凭证',
      });
    }
    for (const row of disposals) {
      events.push({
        eventType: 'disposal',
        occurredAt: row.disposeDate ?? row.applyDate,
        title: `资产处置（${row.disposalType}）`,
        amount: round2(toNumber(row.gainLoss)),
        refCode: row.code,
        detail: `${row.status}${row.reason ? ` · ${row.reason}` : ''}`,
      });
    }
    events.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));

    const accumulatedImpairment = await this.totalImpairment(assetId);
    const accumulated = await this.totalDepreciation(assetId);
    const original = round2(toNumber(asset.originalValue));
    return {
      assetId: asset.id,
      assetCode: asset.code,
      assetName: asset.name ?? '',
      status: asset.status ?? 'in_use',
      originalValue: original,
      accumulatedDepreciation: accumulated,
      accumulatedImpairment,
      residualValue: round2(toNumber(asset.residualValue)),
      netBookValue: round2(
        Math.max(original - accumulated - accumulatedImpairment, 0)
      ),
      purchaseOrderId: asset.purchaseOrderId,
      departmentName: await this.departmentName(asset.departmentId),
      projectName: await this.projectName(asset.projectId),
      events,
    };
  }

  private async departmentName(id: string | null): Promise<string | null> {
    if (!id) return null;
    const rows = await this.db
      .select({ name: hrDepartment.name })
      .from(hrDepartment)
      .where(eq(hrDepartment.id, id))
      .limit(1);
    return rows[0]?.name ?? null;
  }

  private async projectName(id: string | null): Promise<string | null> {
    if (!id) return null;
    const rows = await this.db
      .select({ name: erpProject.name })
      .from(erpProject)
      .where(eq(erpProject.id, id))
      .limit(1);
    return rows[0]?.name ?? null;
  }

  /**
   * 资产归属（部门/项目）与使用人，供详情页头部展示。
   *
   * ⚠️ **`keeperName` 当前恒为 `null`** —— 这不是偷懒，是修复一个真实的 500：
   * 原实现写的是
   * ```
   * LEFT JOIN md_employee e ON e.id = a.keeper_employee_id
   * ```
   * 而 `ast_asset` **没有 `keeper_employee_id` 列**（实测库结构确认），
   * 因此该端点被调用时 PostgreSQL 直接报
   * `column a.keeper_employee_id does not exist`，整个接口 500。
   * 之所以长期没被发现：前端从未调用 `/ownership`
   * （只有 `getLifecycle` 被 `AssetLifecyclePanel` 使用），
   * 而 pglite 的 `migrate:dryrun` 只执行迁移、不执行这些查询。
   *
   * 为什么**不**补一个 `keeper_employee_id` 列把功能凑出来：
   * 资产保管/使用人是一个**真实的业务模型**（谁在用、领用/归还记录、
   * 离职移交），不是"加个 nullable 列"就能成立的 —— 加了也没人填，
   * 反而会让人以为系统在追踪保管人。是否引入该模型需业务确认。
   *
   * 因此这里如实返回 `null`，并在契约注释中说明未实现；
   * 契约字段保留是为了不破坏已发布的接口形状。
   */
  async ownership(assetId: string): Promise<{
    departmentId: string | null;
    departmentName: string | null;
    projectId: string | null;
    projectName: string | null;
    keeperName: string | null;
  }> {
    const asset = await this.loadAsset(assetId);
    return {
      departmentId: asset.departmentId,
      departmentName: await this.departmentName(asset.departmentId),
      projectId: asset.projectId,
      projectName: await this.projectName(asset.projectId),
      keeperName: null,
    };
  }
}
