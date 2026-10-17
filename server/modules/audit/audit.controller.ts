import { Controller, Get, Query } from '@nestjs/common';
import { CanCapability, NeedLogin } from '@server/platform';
import { AuditService } from './audit.service';
import { AuditChainService } from './audit-chain.service';
import type {
  AuditActorOption,
  AuditChainAnchor,
  AuditChainVerification,
  AuditImmutabilityProbe,
  AuditListParams,
  AuditLogExportResult,
  AuditLogListResult,
} from '@shared/api.interface';

/** 把 query 里的字符串收敛成契约类型（空串一律视为"未提供"） */
function parseParams(query: {
  objectType?: string;
  action?: string;
  actor?: string;
  dateFrom?: string;
  dateTo?: string;
  limit?: string;
}): AuditListParams {
  const trimmed = (value?: string): string | undefined => {
    const next = (value ?? '').trim();
    return next.length > 0 ? next : undefined;
  };
  const parsed = limitOf(query.limit);
  return {
    objectType: trimmed(query.objectType),
    action: trimmed(query.action),
    actor: trimmed(query.actor),
    dateFrom: trimmed(query.dateFrom),
    dateTo: trimmed(query.dateTo),
    limit: parsed,
  };
}

function limitOf(limit?: string): number | undefined {
  if (!limit) return undefined;
  const parsed = Number.parseInt(limit, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

@NeedLogin()
@Controller('api/audit')
export class AuditController {
  constructor(
    private readonly auditService: AuditService,
    private readonly auditChainService: AuditChainService
  ) {}

  @CanCapability('audit')
  @Get('demo-residue')
  async demoResidue(): Promise<{ projects: number; contracts: number }> {
    return this.auditService.countDemoResidue();
  }

  /**
   * 审计日志列表。
   *
   * ⚠️ `action` 曾经在 SQL `LIMIT` **之后**用 `rows.filter()` 过滤，导致结果条数
   * 随 `limit` 变化（100→2 行、200→12 行，库里实际 93 条）。现在所有条件
   * （模块 / 操作 / 操作人 / 日期区间）都在 `where` 里，并额外返回 `total`，
   * 让界面的「共 N 条」是**筛选后的真实条数**而不是"这一页碰巧有几行"。
   */
  @CanCapability('audit')
  @Get('logs')
  async listLogs(
    @Query('objectType') objectType?: string,
    @Query('action') action?: string,
    @Query('actor') actor?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('limit') limit?: string
  ): Promise<AuditLogListResult> {
    return this.auditService.listLogs(
      parseParams({ objectType, action, actor, dateFrom, dateTo, limit })
    );
  }

  /**
   * 导出筛选后的**全集**为 CSV（上限见 `MAX_EXPORT_ROWS`，超出时 `truncated=true`）。
   *
   * 单独开一个接口而不是让前端拼当前页：审计导出必须是"把筛选结果整体带走"，
   * 只导出可见的 10 行等于让审计人员拿到一份看起来完整、实际残缺的证据。
   */
  @CanCapability('audit')
  @Get('logs/export')
  async exportLogs(
    @Query('objectType') objectType?: string,
    @Query('action') action?: string,
    @Query('actor') actor?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string
  ): Promise<AuditLogExportResult> {
    return this.auditService.exportCsv(
      parseParams({ objectType, action, actor, dateFrom, dateTo })
    );
  }

  /** 操作人筛选下拉的数据源（避免前端硬编码用户清单） */
  @CanCapability('audit')
  @Get('actors')
  async listActors(): Promise<AuditActorOption[]> {
    return this.auditService.listActors();
  }

  /* ========== D-09 / NFR-S8：防篡改校验 ========== */

  /** 在线校验审计链：回答"日志有没有被改过" */
  @CanCapability('audit')
  @Get('chain-verification')
  async verifyChain(
    @Query('limit') limit?: string
  ): Promise<AuditChainVerification> {
    return this.auditChainService.verify({ limit: limitOf(limit) });
  }

  /** 导出链锚点：应定期外发到独立系统，用于证明"日志未被整体重写" */
  @CanCapability('audit')
  @Get('chain-anchor')
  async chainAnchor(): Promise<AuditChainAnchor> {
    return this.auditChainService.anchor();
  }

  /** 只追加约束自检（等保演示/运维自检：UPDATE 与 DELETE 都必须被拒绝） */
  @CanCapability('audit')
  @Get('immutability-probe')
  async immutabilityProbe(): Promise<AuditImmutabilityProbe> {
    return this.auditChainService.assertImmutableProbe();
  }
}
