import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  DRIZZLE_DATABASE,
  type PostgresJsDatabase,
} from '@server/platform';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  astAsset,
  astDepreciation,
  erpCostAllocation,
  erpProjectCost,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import type {
  AssetDepreciationItem,
  DepreciatePeriodDto,
  DepreciateResult,
  PagedResult,
} from '@shared/api.interface';

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const DEPRECIABLE_STATUSES = ['in_use', 'idle', 'repair'];

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** 单个资产净值不足等可跳过场景：回滚该资产折旧插入并继续处理其余资产 */
class DepreciationSkipError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'DepreciationSkipError';
  }
}

function periodEndDate(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${period}-${String(lastDay).padStart(2, '0')}`;
}

export interface DepreciationListParams {
  page?: number;
  pageSize?: number;
  period?: string;
  assetId?: string;
}

interface DepreciationRow {
  id: string;
  assetId: string | null;
  assetCode: string | null;
  assetName: string | null;
  period: string | null;
  amount: string | null;
  costGenerated: boolean | null;
  remark: string | null;
  createdAt: Date;
}

@Injectable()
export class AssetDepreciationService {
  private readonly logger = new Logger(AssetDepreciationService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly voucherHookService: VoucherHookService
  ) {}

  async listDepreciations(
    params: DepreciationListParams
  ): Promise<PagedResult<AssetDepreciationItem>> {
    const page = Math.max(1, params.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, params.pageSize ?? 20));
    const conditions = [];
    if (params.period) {
      if (!PERIOD_PATTERN.test(params.period)) {
        throw new BadRequestException('期间格式必须为 YYYY-MM');
      }
      conditions.push(eq(astDepreciation.period, params.period));
    }
    if (params.assetId) conditions.push(eq(astDepreciation.assetId, params.assetId));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const totalRows: Array<{ total: number }> = await this.db
      .select({ total: count() })
      .from(astDepreciation)
      .where(where);
    const rows: DepreciationRow[] = await this.db
      .select({
        id: astDepreciation.id,
        assetId: astDepreciation.assetId,
        assetCode: astAsset.code,
        assetName: astAsset.name,
        period: astDepreciation.period,
        amount: astDepreciation.amount,
        costGenerated: astDepreciation.costGenerated,
        remark: astDepreciation.remark,
        createdAt: astDepreciation.createdAt,
      })
      .from(astDepreciation)
      .leftJoin(astAsset, eq(astDepreciation.assetId, astAsset.id))
      .where(where)
      .orderBy(desc(astDepreciation.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);
    return {
      items: rows.map((row: DepreciationRow) => ({
        id: row.id,
        assetId: row.assetId ?? '',
        assetCode: row.assetCode ?? '',
        assetName: row.assetName ?? '',
        period: row.period ?? '',
        amount: Number(row.amount ?? 0),
        costGenerated: row.costGenerated ?? false,
        remark: row.remark,
        createdAt: row.createdAt.toISOString(),
      })),
      total: Number(totalRows[0]?.total ?? 0),
      page,
      pageSize,
    };
  }

  /** 月度折旧计提批量任务：事务内逐资产插入折旧 + 原子扣减净值 + GPU 联动成本 */
  async depreciate(dto: DepreciatePeriodDto): Promise<DepreciateResult> {
    const period = dto.period;
    if (!PERIOD_PATTERN.test(period)) {
      throw new BadRequestException('期间格式必须为 YYYY-MM');
    }
    const assets = await this.db
      .select()
      .from(astAsset)
      .where(inArray(astAsset.status, DEPRECIABLE_STATUSES))
      .orderBy(asc(astAsset.code));

    const thisPeriodRows: Array<{ assetId: string | null }> = await this.db
      .select({ assetId: astDepreciation.assetId })
      .from(astDepreciation)
      .where(eq(astDepreciation.period, period));
    const doneThisPeriod = new Set<string>();
    for (const row of thisPeriodRows) {
      if (row.assetId) doneThisPeriod.add(row.assetId);
    }

    const countRows: Array<{ assetId: string | null; total: number }> =
      await this.db
        .select({ assetId: astDepreciation.assetId, total: count() })
        .from(astDepreciation)
        .groupBy(astDepreciation.assetId);
    const doneTotal = new Map<string, number>();
    for (const row of countRows) {
      if (row.assetId) doneTotal.set(row.assetId, Number(row.total ?? 0));
    }

    let assetCount = 0;
    let totalAmount = 0;
    /** D-29：有项目归 6401，无项目归 6602 管理费用 */
    let projectDepreciation = 0;
    let adminDepreciation = 0;
    for (const asset of assets) {
      if (doneThisPeriod.has(asset.id)) continue;
      const usefulMonths = asset.usefulMonths ?? 36;
      const done = doneTotal.get(asset.id) ?? 0;
      if (done >= usefulMonths) continue;

      const originalValue = Number(asset.originalValue ?? 0);
      const residualValue = Number(asset.residualValue ?? 0);
      const netValue = Number(asset.netValue ?? 0);
      const remaining = round2(netValue - residualValue);
      if (remaining < 0.01) continue;

      const depreciableBase = round2(originalValue - residualValue);
      let amount = round2(depreciableBase / usefulMonths);
      const isLastMonth = done + 1 >= usefulMonths;
      if (isLastMonth || amount > remaining) amount = remaining;
      if (amount < 0.01) continue;

      const amountStr = amount.toFixed(2);
      const isGpu = asset.category === 'server_gpu';
      const costCode =
        isGpu && asset.projectId
          ? await generateBizCode(
              this.db,
              erpProjectCost,
              erpProjectCost.code,
              'CST'
            )
          : null;
      const allocCode =
        isGpu && !asset.projectId
          ? await generateBizCode(
              this.db,
              erpCostAllocation,
              erpCostAllocation.code,
              'ALC'
            )
          : null;

      try {
        await this.db.transaction(async (tx) => {
          await tx.insert(astDepreciation).values({
            assetId: asset.id,
            period,
            amount: amountStr,
            costGenerated: isGpu,
            remark: isGpu
              ? asset.projectId
                ? `已生成项目成本 asset:${asset.code}`
                : `已生成公共成本分摊 asset:${asset.code}`
              : null,
          });
          const updated = await tx
            .update(astAsset)
            .set({
              netValue: sql`${astAsset.netValue} - ${amountStr}`,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(astAsset.id, asset.id),
                sql`${astAsset.netValue} - ${amountStr} >= ${astAsset.residualValue} - 0.005`
              )
            )
            .returning({ id: astAsset.id });
          if (updated.length === 0) {
            throw new DepreciationSkipError(
              `资产 ${asset.code} 净值不足，跳过本期计提`
            );
          }
          if (costCode) {
            await tx.insert(erpProjectCost).values({
              code: costCode,
              projectId: asset.projectId,
              costType: 'compute',
              amount: amountStr,
              period,
              occurredDate: periodEndDate(period),
              sourceRef: `asset:${asset.code}`,
              remark: `GPU 资产折旧：${asset.name}`,
            });
          }
          if (allocCode) {
            await tx.insert(erpCostAllocation).values({
              code: allocCode,
              sourceDesc: asset.name,
              costType: 'compute',
              amount: amountStr,
              targetProjectId: null,
              period,
              sourceRef: `asset:${asset.code}`,
              remark: `GPU 资产折旧公共分摊：${asset.name}`,
            });
          }
        });
      } catch (err) {
        if (err instanceof DepreciationSkipError) {
          this.logger.warn(err.message);
          continue;
        }
        throw err;
      }
      assetCount += 1;
      totalAmount = round2(totalAmount + amount);
      if (asset.projectId) {
        projectDepreciation = round2(projectDepreciation + amount);
      } else {
        adminDepreciation = round2(adminDepreciation + amount);
      }
    }

    /* A2：sourceRef 带批次；D-29 按是否挂项目拆分费用科目 */
    const batchId = `${Date.now().toString(36)}`;
    const postDepreciation = async (
      expenseAccount: '6401' | '6602',
      amount: number,
      label: string,
    ) => {
      if (amount <= 0) return;
      const sourceRef = `depreciation:${period}:${expenseAccount}:${batchId}`;
      const lines = [
        { accountCode: expenseAccount, debit: amount },
        { accountCode: '1602', credit: amount },
      ];
      const result = await this.voucherHookService.generateVoucherDraft({
        sourceType: 'depreciation',
        sourceRef,
        voucherDate: periodEndDate(period),
        summary: `折旧计提 ${period} ${label}`,
        lines,
      });
      if (result === 'failed') {
        await this.voucherHookService.recordCompensation(
          'depreciation',
          sourceRef,
          `折旧凭证生成失败 ${label}`,
          lines,
          periodEndDate(period),
        );
      }
    };
    await postDepreciation('6401', projectDepreciation, '项目成本');
    await postDepreciation('6602', adminDepreciation, '管理费用');
    return { period, assetCount, totalAmount };
  }
}
