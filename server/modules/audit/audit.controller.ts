import { Controller, Get, Query } from '@nestjs/common';
import { CanCapability, NeedLogin } from '@server/platform';
import { AuditService } from './audit.service';
import type { AuditLog } from '@shared/api.interface';

@NeedLogin()
@Controller('api/audit')
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

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
}
