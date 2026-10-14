import { Controller, Get, Query } from '@nestjs/common';
import { CanCapability, NeedLogin } from '@server/platform';
import { AuditService } from './audit.service';
import { AuditChainService } from './audit-chain.service';
import type {
  AuditChainAnchor,
  AuditChainVerification,
  AuditImmutabilityProbe,
  AuditLog,
} from '@shared/api.interface';

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

  @CanCapability('audit')
  @Get('logs')
  async listLogs(
    @Query('objectType') objectType?: string,
    @Query('action') action?: string,
    @Query('limit') limit?: string
  ): Promise<AuditLog[]> {
    const parsed = limit ? Number.parseInt(limit, 10) : undefined;
    return this.auditService.listLogs(
      objectType,
      action,
      Number.isNaN(parsed) ? undefined : parsed
    );
  }

  /* ========== D-09 / NFR-S8：防篡改校验 ========== */

  /** 在线校验审计链：回答"日志有没有被改过" */
  @CanCapability('audit')
  @Get('chain-verification')
  async verifyChain(
    @Query('limit') limit?: string
  ): Promise<AuditChainVerification> {
    const parsed = limit ? Number.parseInt(limit, 10) : undefined;
    return this.auditChainService.verify({
      limit: parsed === undefined || Number.isNaN(parsed) ? undefined : parsed,
    });
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
