import { Inject, Injectable, Logger, OnModuleInit, SetMetadata } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { CronJob } from 'cron';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Sql } from 'postgres';
import { CRON_BY_TRIGGER } from './cron-map';
import { PG_CLIENT } from './tokens';

export const AUTOMATION_METADATA_KEY = 'automation:controller';
export const BIND_ACTION_METADATA_KEY = 'automation:action';

export const Automation = (): ClassDecorator => SetMetadata(AUTOMATION_METADATA_KEY, true);

export const BindTrigger = (trigger: string): MethodDecorator =>
  SetMetadata(BIND_ACTION_METADATA_KEY, {
    trigger,
    cron: CRON_BY_TRIGGER[trigger] ?? '0 9 * * *',
  });

interface TriggerMeta {
  trigger: string;
  cron: string;
}

@Injectable()
export class JobScheduler implements OnModuleInit {
  private readonly logger = new Logger(JobScheduler.name);

  constructor(
    private readonly discovery: DiscoveryService,
    private readonly scanner: MetadataScanner,
    private readonly reflector: Reflector,
    private readonly registry: SchedulerRegistry,
    @Inject(PG_CLIENT) private readonly client: Sql,
  ) {}

  onModuleInit(): void {
    for (const wrapper of this.discovery.getProviders()) {
      const instance = wrapper.instance as object | null;
      if (!instance || typeof instance !== 'object') continue;
      const prototype = Object.getPrototypeOf(instance) as object;
      this.scanner.scanFromPrototype(instance, prototype, (methodName) => {
        const method = (instance as Record<string, unknown>)[methodName];
        if (typeof method !== 'function') return;
        const meta = this.reflector.get<TriggerMeta | undefined>(BIND_ACTION_METADATA_KEY, method);
        if (!meta?.trigger) return;
        const job = new CronJob(
          meta.cron,
          () => {
            void this.runExclusive(meta.trigger, () =>
              (method as () => Promise<void>).call(instance),
            );
          },
          null,
          false,
          'Asia/Shanghai',
        );
        this.registry.addCronJob(meta.trigger, job);
        job.start();
        this.logger.log(`已注册定时任务 ${meta.trigger} ${meta.cron}`);
      });
    }
  }

  private async runExclusive(trigger: string, handler: () => Promise<void>): Promise<void> {
    await this.client.begin(async (tx) => {
      const rows = await tx<{ locked: boolean }[]>`
        select pg_try_advisory_xact_lock(hashtext(${trigger})) as locked
      `;
      if (!rows[0]?.locked) {
        this.logger.log(`任务 ${trigger} 已在其他实例运行，跳过`);
        return;
      }
      await handler();
    });
  }
}
