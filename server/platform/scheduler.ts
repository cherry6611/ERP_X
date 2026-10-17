import { Inject, Injectable, Logger, OnModuleInit, SetMetadata } from '@nestjs/common';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { CronJob } from 'cron';
import { SchedulerRegistry } from '@nestjs/schedule';
import type { Sql } from 'postgres';
import { todayInShanghai } from '@server/common/utils/biz-date';
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
    // 本地开发时 8 个定时任务会真实触发（如 feishu_contact_incremental 每 15 分钟一次），
    // 在飞书配置未就绪的情况下会持续刷错误日志。用 ENABLE_SCHEDULER=false 可整体关闭。
    if ((process.env.ENABLE_SCHEDULER ?? 'true').toLowerCase() === 'false') {
      this.logger.warn('ENABLE_SCHEDULER=false，已跳过全部定时任务注册');
      return;
    }
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
            ).catch((error: unknown) => {
              // 兜底：避免 unhandledRejection 在 abortOnError 下拖死进程
              this.logger.error(
                `定时任务 ${meta.trigger} 执行失败`,
                error instanceof Error ? error.stack : String(error),
              );
            });
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

  /**
   * S8（§6.6）：**事务外执行 handler**，互斥改用会话级 advisory lock。
   *
   * ## 原缺陷
   *
   * 原实现是：
   * ```ts
   * await this.client.begin(async (tx) => {
   *   const rows = await tx`select pg_try_advisory_xact_lock(...)`;
   *   if (!rows[0]?.locked) return;
   *   await handler();          // ← 整个 cron handler 在事务里
   * });
   * ```
   * 而多个 cron handler 会调用 `notifications.service` 的飞书插件（**真实 HTTP**）。
   * 这违反 `AGENTS.md:46`「新增外部 IO 必须在事务外」，实际代价是：
   *   · 责任人 30 人时，推送一批通知的事务持锁可达 **9 秒以上**；
   *   · 期间一直占用连接与事务级 advisory lock；
   *   · 一旦 HTTP 超时，事务会一直挂着（直到驱动超时），把连接池拖干。
   *
   * ## 为什么不能"简单地把 begin 去掉"
   *
   * 事务级锁（`pg_try_advisory_xact_lock`）**随事务结束自动释放**。如果只是把
   * `begin` 去掉，锁会立刻释放，多实例互斥就**失效**了 —— 两个实例会同时跑同一个
   * 任务，重复推送、重复同步。所以必须换成**会话级锁**：
   *   `pg_try_advisory_lock` 获取 → handler 全程持有 → `finally` 里
   *   `pg_advisory_unlock` 显式释放。
   *
   * ## 连接亲和性是这里的关键
   *
   * 会话级锁挂在**某一条连接**上，因此获取、执行、释放必须落在**同一条连接**。
   * postgres-js 的 `sql.reserve()` 给的就是一条独占连接，用它保证亲和性。
   *
   * ## 副作用（有意为之，且是修复的一部分）
   *
   * 用 `reserve()` 会**临时多占一条连接**（任务期间）。这是必要代价：
   * 换来的是一致性（互斥有效）+ 不长期占用事务。池 `max: 20` 下最多同时有
   * 一个定时任务持连接（advisory lock 已保证互斥），影响可忽略。
   */
  /**
   * B13（§7.2）：**日粒度幂等** —— 抢到今天的台账行才执行。
   *
   * ## 为什么 advisory lock 不够
   *
   * `runExclusive` 的会话级 advisory lock 解决的是**多实例同时执行**（横向重复）。
   * 它挡不住"同一天跑第二次"：
   *   · 运维手工触发一次（排查问题、补发通知）；
   *   · 任务失败后立即重试；
   *   · 进程重启后 cron 补跑（按"下一次触发时间"算，已过点可能立即执行）；
   *   · 两实例 cron 命中时刻错开 1 分钟（A 跑完释放锁，B 随后命中）。
   *
   * 后果是**同一个责任人当天收到两封一模一样的催办** ——
   * 对使用者而言这是"系统在刷我"，比不提醒更糟（真实提醒会被无视）。
   *
   * ## 判据
   *
   * `INSERT ... ON CONFLICT DO NOTHING RETURNING id`：
   * 抢到行 → 本实例是今天的第一次 → 执行；
   * 没抢到 → 今天已跑过 → 跳过并记一条 log（让"为什么没跑"在日志里可查）。
   *
   * 日期取 `todayInShanghai()`，与 cron 的 `timeZone: 'Asia/Shanghai'` 一致 ——
   * 用 UTC 日期会把"北京时间早上 8 点跑的任务"记到前一天，于是**当天仍会重复**。
   *
   * ## 执行结论回写
   *
   * 成功/失败都回写台账（`status` / `error_message` / `detail`）。
   * 这让"这个任务今天跑没跑、结果如何"无需翻日志即可查证 ——
   * 原先这个信息在系统里**完全不存在**。
   *
   * ⚠️ 有意**不**在失败后自动删除台账行（那会变成"失败就能无限重试"，
   * 而重试正是要防的重复来源）。需要当天重跑时由人显式删除该行 ——
   * 这个动作留下痕迹，比隐式重试可控。
   */
  private async claimDailyRun(taskKey: string): Promise<boolean> {
    const runDate = todayInShanghai();
    const rows = await this.client<{ id: string }[]>`
      insert into comp_automation_run (task_key, run_date, status)
      values (${taskKey}, ${runDate}::date, 'running')
      on conflict (task_key, run_date) do nothing
      returning id
    `;
    return rows.length > 0;
  }

  private async finishDailyRun(
    taskKey: string,
    status: 'success' | 'failed',
    error?: unknown,
    detail?: string,
  ): Promise<void> {
    try {
      await this.client`
        update comp_automation_run
        set status = ${status},
            error_message = ${
              status === 'failed'
                ? error instanceof Error
                  ? error.message
                  : String(error)
                : null
            },
            detail = ${detail ?? null}
        where task_key = ${taskKey} and run_date = ${todayInShanghai()}::date
      `;
    } catch (writeError: unknown) {
      /*
       * 回写失败不能影响任务本身的结论（任务已经跑完了）。
       * 但要留 error 级日志：台账不更新会让"今天跑没跑"看起来是 running，
       * 而 running 行**会阻止当天的后续执行** —— 排障时必须知道这一点。
       */
      this.logger.error(
        `任务 ${taskKey} 的执行台账回写失败（任务本身已结束）：${
          writeError instanceof Error ? writeError.message : String(writeError)
        }；该行状态会停留在 running，当天不会再次执行`,
      );
    }
  }

  private async runExclusive(trigger: string, handler: () => Promise<void>): Promise<void> {
    const conn = await this.client.reserve();
    let locked = false;
    try {
      const rows = await conn<{ locked: boolean }[]>`
        select pg_try_advisory_lock(hashtext(${trigger})) as locked
      `;
      locked = Boolean(rows[0]?.locked);
      if (!locked) {
        this.logger.log(`任务 ${trigger} 已在其他实例运行，跳过`);
        return;
      }
      /*
       * §6.10 (6) 关联修复：**清理会话 GUC，避免污染审计归属**。
       *
       * `app.user_id` 是迁移中 167 处审计列 DEFAULT 的来源
       * （`_created_by` / `_updated_by` 读它）。HTTP 路径每请求会 set + reset，
       * 但 cron 路径**从不设置它** —— 于是如果这条连接恰好被上一个 HTTP 请求
       * 用过且重置失败，cron 写入的业务行会把 `_created_by` 盖上**上一个用户**的 id。
       *
       * 这里显式置空：让审计列落 NULL（= 系统作业），而不是某个无辜用户的 id。
       * 归因为"系统"是正确的语义，归因为某个用户是**错误的合规记录**。
       *
       * 注意顺序：`claimDailyRun` 必须在 GUC 清理**之后**调用 ——
       * 台账行的写入同样属于系统作业，不该带上任何用户 id。
       */
      await conn`select set_config('app.user_id', '', false)`;

      /*
       * B13：advisory lock 之上再加一道**日粒度幂等**闸门。
       *
       * 两道闸门的分工必须说清，否则容易被当成重复实现而删掉其中一个：
       *   · advisory lock（外层）：防**多实例并发** —— 锁是瞬时的，跑完即释放；
       *   · 台账（内层）：防**当天重复** —— 记录是持久的，当天不再跑第二次。
       * 只有外层时，A 实例跑完释放锁、B 实例 1 分钟后命中同一个 cron 就会再跑一遍。
       */
      const claimed = await this.claimDailyRun(trigger);
      if (!claimed) {
        this.logger.log(
          `任务 ${trigger} 今日已执行过（见 comp_automation_run），跳过以避免重复通知`,
        );
        return;
      }

      // 事务外执行：handler 里的外部 IO（飞书 HTTP）不再拖长事务
      try {
        await handler();
        await this.finishDailyRun(trigger, 'success');
      } catch (error: unknown) {
        await this.finishDailyRun(trigger, 'failed', error);
        throw error;
      }
    } finally {
      // 会话级锁必须显式释放；释放失败时**销毁连接**（见下）
      if (locked) {
        try {
          await conn`select pg_advisory_unlock(hashtext(${trigger}))`;
        } catch (error: unknown) {
          // 释放失败意味着锁可能仍挂在这条连接上；若把连接归还池中，
          // 后续任何一次同 trigger 的执行都会被"自己的旧锁"挡住 —— 任务静默停摆。
          // postgres-js 的 ReservedSql.release() 不接受参数，无法显式 destroy；
          this.logger.error(
            `任务 ${trigger} advisory lock 释放失败；连接照常归还，` +
              `但若随后出现任务静默停摆，请检查是否残留同 trigger 的会话锁`,
            error instanceof Error ? error.stack : String(error),
          );
          // 这里照常归还，但把'锁可能泄漏'写进日志以便排障。
          conn.release();
          return;
        }
      }
      try {
        conn.release();
      } catch {
        /* 已归还或异常时忽略 */
      }
    }
  }
}
