import { Global, MiddlewareConsumer, Module, type NestModule, type DynamicModule } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthorizationSDK } from './authorization-sdk';
import { CapabilityService } from './capability.service';
import { openDatabase, type DatabaseHandle } from './database';
import { LoginGuard, RolesGuard } from './guards';
import { JobScheduler } from './scheduler';
import { SessionMiddleware } from './session.middleware';
import { SessionStore } from './session-store';
import { AccountLifecycleService } from './account-lifecycle';
import { DRIZZLE_DATABASE, PG_CLIENT, RAW_DATABASE } from './tokens';

const DB_HANDLE = 'DB_HANDLE';

@Global()
@Module({})
export class PlatformModule implements NestModule {
  static forRoot(): DynamicModule {
    return {
      module: PlatformModule,
      global: true,
      imports: [DiscoveryModule, ScheduleModule.forRoot()],
      providers: [
        {
          provide: DB_HANDLE,
          useFactory: (): DatabaseHandle => {
            const url = process.env.DATABASE_URL;
            if (!url) throw new Error('缺少环境变量 DATABASE_URL');
            return openDatabase(url);
          },
        },
        { provide: DRIZZLE_DATABASE, inject: [DB_HANDLE], useFactory: (h: DatabaseHandle) => h.db },
        { provide: RAW_DATABASE, inject: [DB_HANDLE], useFactory: (h: DatabaseHandle) => h.raw },
        { provide: PG_CLIENT, inject: [DB_HANDLE], useFactory: (h: DatabaseHandle) => h.client },
        SessionMiddleware,
        SessionStore,
        AccountLifecycleService,
        LoginGuard,
        RolesGuard,
        { provide: APP_GUARD, useClass: LoginGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        AuthorizationSDK,
        CapabilityService,
        JobScheduler,
      ],
      exports: [DRIZZLE_DATABASE, RAW_DATABASE, PG_CLIENT, AuthorizationSDK, CapabilityService, SessionStore, AccountLifecycleService],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SessionMiddleware).forRoutes('*');
  }
}

export async function configureApp(): Promise<void> {
  return;
}
