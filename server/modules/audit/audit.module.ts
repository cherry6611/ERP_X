import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditChainService } from './audit-chain.service';
import { AuditInterceptor } from './audit.interceptor';

@Module({
  controllers: [AuditController],
  providers: [
    AuditService,
    // D-09 / NFR-S8：审计链校验（只追加约束 + 链式校验和）
    AuditChainService,
    {
      provide: APP_INTERCEPTOR,
      useClass: AuditInterceptor,
    },
  ],
  exports: [AuditService, AuditChainService],
})
export class AuditModule {}
