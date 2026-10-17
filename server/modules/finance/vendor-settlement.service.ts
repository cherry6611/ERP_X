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
import { and, eq, gte, inArray, lt, ne } from 'drizzle-orm';
import {
  erpApBill,
  erpLaborRate,
  erpTimesheet,
  mdEmployee,
  mdSupplier,
} from '@server/database/schema';
import { generateBizCode } from '@server/common/utils/biz-code';
import { round2 } from '@server/common/utils/number';
import { inputIssueLines } from '@server/common/tax/posting';
import { TaxResolverService } from '@server/modules/tax/tax-resolver.service';
import { VoucherHookService } from '@server/modules/voucher/voucher-hook.service';
import { todayInShanghai } from '@server/common/utils/biz-date';
import type {
  GenerateVendorSettlementDto,
  GenerateVendorSettlementResult,
  VendorSettlementLine,
  VendorSettlementPreview,
} from '@shared/api.interface';

const FLEX_EMPLOYMENT_TYPES = ['part_time', 'flex'];
/*
 * ⚠️ 原为 `/^\d{4}-\d{2}$/u` —— 它接受 `2026-13` / `2026-00` / `2026-99`，
 * 而全仓另外 18 处同名常量用的都是「月份 01–12」的严格版。这是**唯一一处口径分叉**，
 * 后果不是"提示不友好"，而是算错期间：
 *
 *   `resolvePeriodRange('2026-13')` 里 `new Date(Date.UTC(2026, 13, 0))` ——
 *   JS 的月份溢出会滚到 2027 年，于是"13 月"的月末变成 2027-01-31，
 *   `start = '2026-13-01'` 这个非法日期被拿去查工时区间（`WHERE work_date >= $1`），
 *   PostgreSQL 对非法日期字面量直接报错；更隐蔽的是 `sourceRef`
 *   会落成 `VS:2026-13:...` 这种永远无法与正常期间对齐的幂等键。
 *
 * 现已与其他 18 处统一为「月份 01–12」。`period-utils.ts` 是同一正则的权威副本
 * （该模块带 15 条断言），此处保留本地常量是为了不让 finance 模块反向依赖
 * finance-reports；两处正则必须逐字相同。
 *
 * 全仓 19 处 `PERIOD_PATTERN` 复核结果（2026-10-17）：
 *   · 18 处 = `/^\d{4}-(0[1-9]|1[0-2])$/`（含本处，修完分叉后）
 *   ·  1 处 = `/^(\d{4})-(0[1-9]|1[0-2])$/`（`statement.logic.ts`，
 *     多两个捕获组是为了同时取出年/月，**语义等价**，且该模块有 spec）
 */
const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

interface PeriodRange {
  start: string;
  end: string;
  monthEnd: string;
}

interface SettlementComputation {
  supplierName: string;
  lines: VendorSettlementLine[];
  totalAmount: number;
  sourceRef: string;
}

function resolvePeriodRange(period: string): PeriodRange {
  const year: number = Number.parseInt(period.slice(0, 4), 10);
  const month: number = Number.parseInt(period.slice(5, 7), 10);
  const nextYear: number = month === 12 ? year + 1 : year;
  const nextMonth: number = month === 12 ? 1 : month + 1;
  const monthEnd: string = new Date(Date.UTC(year, month, 0))
    .toISOString()
    .slice(0, 10);
  return {
    start: `${period}-01`,
    end: `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`,
    monthEnd,
  };
}

/** 外协结算金额取整：统一走全仓唯一实现 round2（对负数量取整对称，红冲可平）。 */
const roundAmount = round2;

@Injectable()
export class VendorSettlementService {
  private readonly logger = new Logger(VendorSettlementService.name);

  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly voucherHookService: VoucherHookService,
    private readonly taxResolver: TaxResolverService
  ) {}

  async preview(
    supplierId?: string,
    period?: string,
    projectId?: string
  ): Promise<VendorSettlementPreview> {
    const effectiveSupplierId: string = supplierId ?? '';
    const effectivePeriod: string = period ?? '';
    if (effectiveSupplierId === '') {
      throw new BadRequestException('supplierId 必填');
    }
    if (!PERIOD_PATTERN.test(effectivePeriod)) {
      throw new BadRequestException('period 格式必须为 YYYY-MM');
    }
    const effectiveProjectId: string | undefined =
      projectId === '' ? undefined : projectId;
    const computation = await this.compute(
      effectiveSupplierId,
      effectivePeriod,
      effectiveProjectId ?? null
    );
    const existing = await this.db
      .select({ id: erpApBill.id })
      .from(erpApBill)
      .where(
        and(
          eq(erpApBill.sourceRef, computation.sourceRef),
          ne(erpApBill.status, 'voided'),
        ),
      )
      .limit(1);
    return {
      supplierId: effectiveSupplierId,
      supplierName: computation.supplierName,
      period: effectivePeriod,
      projectId: effectiveProjectId ?? null,
      lines: computation.lines,
      totalAmount: computation.totalAmount,
      sourceRef: computation.sourceRef,
      alreadyGenerated: existing.length > 0,
    };
  }

  async generate(
    dto: GenerateVendorSettlementDto
  ): Promise<GenerateVendorSettlementResult> {
    if (!dto.supplierId) {
      throw new BadRequestException('supplierId 必填');
    }
    if (!PERIOD_PATTERN.test(dto.period)) {
      throw new BadRequestException('period 格式必须为 YYYY-MM');
    }
    const computation = await this.compute(
      dto.supplierId,
      dto.period,
      dto.projectId ?? null
    );
    if (computation.lines.length === 0) {
      throw new BadRequestException('该期间无已确认工时明细，无法生成结算');
    }
    const missingRateLine = computation.lines.find(
      (line: VendorSettlementLine) => line.rate <= 0
    );
    if (missingRateLine) {
      throw new BadRequestException(
        `角色「${missingRateLine.roleName ?? ''}」未配置生效费率，无法生成结算`
      );
    }
    const code = await generateBizCode(
      this.db,
      erpApBill,
      erpApBill.code,
      'APB'
    );
    const inserted = await this.db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: erpApBill.id })
        .from(erpApBill)
        .where(
        and(
          eq(erpApBill.sourceRef, computation.sourceRef),
          ne(erpApBill.status, 'voided'),
        ),
      )
        .limit(1)
        .for('update');
      if (existing.length > 0) {
        throw new ConflictException('该期间结算单已生成，请勿重复生成');
      }
      try {
        const rows = await tx
          .insert(erpApBill)
          .values({
            code,
            supplierId: dto.supplierId,
            projectId: dto.projectId ?? null,
            amount: String(computation.totalAmount),
            paidAmount: '0',
            dueDate: dto.dueDate,
            status: 'pending',
            source: 'vendor_settlement',
            sourceRef: computation.sourceRef,
            remark: `外协结算 ${dto.period}`,
          })
          .returning({
            id: erpApBill.id,
            code: erpApBill.code,
            amount: erpApBill.amount,
          });
        if (rows.length === 0) {
          throw new BadRequestException('应付单生成失败');
        }
        return rows[0];
      } catch (error) {
        // F4X-10：uq_erp_ap_bill_source_ref 并发插入时兜底
        const pgCode =
          error && typeof error === 'object' && 'code' in error
            ? String((error as { code: unknown }).code)
            : '';
        if (pgCode === '23505') {
          throw new ConflictException('该期间结算单已生成，请勿重复生成');
        }
        throw error;
      }
    });

    // A3：外协结算补进项凭证
    const amount = Number(inserted.amount ?? 0);
    // P1-9：先把税率解析与分录取出（纯读），失败登记补偿队列时才能带上可重放的分录。
    const resolved = await this.taxResolver.resolve({
      supplierId: dto.supplierId,
      side: 'input',
    });
    const settlementLines = inputIssueLines(amount, resolved.rate);
    try {
      await this.voucherHookService.generateVoucherDraft({
        sourceType: 'ap',
        sourceRef: `ap:${inserted.code}`,
        voucherDate: dto.dueDate ?? todayInShanghai(),
        summary: `外协结算 ${dto.period} ${inserted.code}`,
        lines: settlementLines,
        taxEntityId: resolved.taxEntityId,
      });
    } catch (error) {
      this.logger.error(
        `外协结算凭证失败 ap:${inserted.code}`,
        error instanceof Error ? error.stack : String(error)
      );
      await this.voucherHookService.recordCompensation(
        'ap',
        `ap:${inserted.code}`,
        error instanceof Error ? error.message : String(error),
        settlementLines,
        dto.dueDate ?? todayInShanghai()
      );
    }

    return {
      apId: inserted.id,
      code: inserted.code,
      amount,
    };
  }

  private async compute(
    supplierId: string,
    period: string,
    projectId: string | null
  ): Promise<SettlementComputation> {
    const supplierRows = await this.db
      .select({ name: mdSupplier.name })
      .from(mdSupplier)
      .where(eq(mdSupplier.id, supplierId));
    if (supplierRows.length === 0) {
      throw new NotFoundException('供应商不存在');
    }
    const range = resolvePeriodRange(period);
    const conditions = [
      eq(mdEmployee.supplierId, supplierId),
      inArray(mdEmployee.employmentType, FLEX_EMPLOYMENT_TYPES),
      eq(erpTimesheet.status, 'confirmed'),
      gte(erpTimesheet.workDate, range.start),
      lt(erpTimesheet.workDate, range.end),
    ];
    if (projectId) {
      conditions.push(eq(erpTimesheet.projectId, projectId));
    }
    /*
     * B9（§7.2）：**费率必须按「工时当日生效费率」逐日取**。
     *
     * ## 原缺陷（两账不符）
     *
     * 外协结算原先用「期间月末」的费率（`effectiveFrom <= monthEnd` 取最新一条），
     * 而工时确认（`costs.service.ts:654-664`）用的是**工当日**的费率
     * （`effectiveFrom <= workDate`）。同一批工时因此算出两个金额：
     *
     *   示例：某角色 5/15 起费率由 500 调到 600，员工 5 月 1–14 日报 40 小时、
     *   15–31 日报 60 小时（共 100 小时）。
     *     · 成本侧（逐日）：40×500 + 60×600 = 56,000
     *     · 结算侧（月末价）：100×600 = 60,000 → **差 4,000**
     *   报告给的 2 万量级同理（工时更多、调整更晚）。
     *
     * 后果：`erp_project_cost`（成本）与 `erp_ap_bill`（应付外协）是两个数，
     * 项目毛利与供应商对账同时失真，**且没有任何机制能发现**。
     *
     * ## 修法：以**逐条工时**为单位取费率再求和
     *
     * 不再 `groupBy(员工, 角色)` 后配一个费率，而是取出每条工时的
     * `(workDate, hours, roleName)`，为每条找 `effectiveFrom <= workDate`
     * 的最新费率，乘出金额后再汇总。这样两边**必然相等**：
     * 成本侧对每条工时用的正是同一个查询条件。
     *
     * ## 费率缺失**报错**而不是按 0 计
     *
     * 成本侧取不到费率时会**拒绝确认工时**，所以能走到结算说明是"确认后费率被
     * 改动/删除"的历史数据。按 0 计会让应付凭空少一笔（等于不给供应商钱），
     * 且账面上看不出来 —— 因此这里显式列出缺费率的角色并要求补录。
     */
    const rows = await this.db
      .select({
        employeeId: erpTimesheet.employeeId,
        employeeName: mdEmployee.name,
        roleName: erpTimesheet.roleName,
        workDate: erpTimesheet.workDate,
        hours: erpTimesheet.hours,
      })
      .from(erpTimesheet)
      .innerJoin(mdEmployee, eq(erpTimesheet.employeeId, mdEmployee.id))
      .where(and(...conditions))
      .orderBy(mdEmployee.name, erpTimesheet.workDate);

    // 取出该角色**全部**费率（含期间开始前的历史费率 —— 期间初期的工时
    // 要用"当时生效"的那一条，只取期间内的会漏）
    const roleNames: string[] = [
      ...new Set(rows.map((row) => row.roleName ?? '')),
    ];
    const ratesByRole = new Map<string, Array<{ from: string; rate: number }>>();
    if (roleNames.length > 0) {
      const rateRows = await this.db
        .select({
          roleName: erpLaborRate.roleName,
          rate: erpLaborRate.rate,
          effectiveFrom: erpLaborRate.effectiveFrom,
        })
        .from(erpLaborRate)
        .where(inArray(erpLaborRate.roleName, roleNames));
      for (const rateRow of rateRows) {
        const key: string = rateRow.roleName ?? '';
        const list = ratesByRole.get(key) ?? [];
        list.push({
          // `effectiveFrom` 为 null 表示"一直有效"→ 用最小日期兜底参与排序
          from: rateRow.effectiveFrom ?? '0001-01-01',
          rate: Number(rateRow.rate),
        });
        ratesByRole.set(key, list);
      }
      // 每个角色内部按生效日**降序**，于是"第一条 <= workDate"即当日费率
      for (const list of ratesByRole.values()) {
        list.sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0));
      }
    }
    /** 逐条工时取「工当日生效费率」—— 与 `costs.service.ts` 完全同一判据 */
    const rateOn = (roleName: string, workDate: string | null): number | null => {
      const list = ratesByRole.get(roleName) ?? [];
      const day = workDate ?? range.monthEnd;
      for (const entry of list) {
        if (entry.from <= day) return entry.rate;
      }
      return null;
    };

    const byKey = new Map<
      string,
      {
        employeeId: string;
        employeeName: string;
        roleName: string | null;
        hours: number;
        amount: number;
      }
    >();
    const missingRates = new Set<string>();
    for (const row of rows) {
      const roleName: string = row.roleName ?? '';
      const rate = rateOn(roleName, row.workDate);
      if (rate === null || rate <= 0) {
        missingRates.add(roleName || '（未填角色）');
        continue;
      }
      const hours = Number(row.hours ?? 0);
      const key = `${row.employeeId ?? ''}|${roleName}`;
      const acc =
        byKey.get(key) ??
        {
          employeeId: row.employeeId ?? '',
          employeeName: row.employeeName ?? '',
          roleName: row.roleName,
          hours: 0,
          amount: 0,
        };
      acc.hours += hours;
      acc.amount += hours * rate;
      byKey.set(key, acc);
    }
    if (missingRates.size > 0) {
      throw new BadRequestException(
        `以下角色在工时发生日没有生效费率，无法结算：${[...missingRates].join('、')}。` +
          `请到「成本 → 角色费率」补齐相应日期的费率后重试` +
          `（外协结算与项目成本必须用同一费率口径，否则两账不符）`
      );
    }
    const lines: VendorSettlementLine[] = [...byKey.values()]
      .sort((a, b) => (a.employeeName < b.employeeName ? -1 : 1))
      .map((acc) => ({
        employeeId: acc.employeeId,
        employeeName: acc.employeeName,
        roleName: acc.roleName,
        hours: roundAmount(acc.hours),
        /*
         * 报告展示的"费率"：期间内只有一个费率时即该费率；
         * 调过价时给**加权平均**（金额 ÷ 小时）。
         *
         * 为什么不是"最后一个费率"：使用者会拿它去核算总额，
         * 而调价月按最后费率乘总小时数必然对不上金额 ——
         * 那会让人怀疑结算单算错了，而实际是展示口径的问题。
         */
        rate: acc.hours > 0 ? roundAmount(acc.amount / acc.hours) : 0,
        amount: roundAmount(acc.amount),
      }));
    const totalAmount: number = roundAmount(
      lines.reduce((acc: number, line: VendorSettlementLine) => acc + line.amount, 0)
    );
    const sourceRef = `VS:${period}:${supplierId}:${projectId || 'ALL'}`;
    return {
      supplierName: supplierRows[0].name,
      lines,
      totalAmount,
      sourceRef,
    };
  }
}
