import { Module } from '@nestjs/common';
import { CacheModule } from '@nestjs/cache-manager';
import { AutomationConfigService } from './automation-config.service';

@Module({
  imports: [CacheModule.register()],
  providers: [AutomationConfigService],
  exports: [AutomationConfigService],
})
export class AutomationConfigModule {}
