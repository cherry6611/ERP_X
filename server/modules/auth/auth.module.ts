import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { SessionCleanupAutomationTasksService } from './session-cleanup.automation';

@Module({
  controllers: [AuthController],
  providers: [AuthService, SessionCleanupAutomationTasksService],
  exports: [AuthService],
})
export class AuthModule {}
