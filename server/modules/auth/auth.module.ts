import { Module } from '@nestjs/common';
import { IdentityModule } from '@server/modules/identity/identity.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { LoginSecurityService } from './login-security.service';
import { SessionCleanupAutomationTasksService } from './session-cleanup.automation';
import { AuthSecurityAutomationTasksService } from './auth-security.automation';

@Module({
  imports: [IdentityModule],
  controllers: [AuthController],
  providers: [
    AuthService,
    LoginSecurityService,
    SessionCleanupAutomationTasksService,
    AuthSecurityAutomationTasksService,
  ],
  exports: [AuthService, LoginSecurityService],
})
export class AuthModule {}
