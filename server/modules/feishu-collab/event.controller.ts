import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { Body, Controller, HttpCode, Post, UnauthorizedException } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { NeedLogin, Public, DRIZZLE_DATABASE, type PostgresJsDatabase } from '@server/platform';
import { FeishuContactService } from './contact.service';

@NeedLogin()
@Controller('api/feishu-event')
export class FeishuEventController {
  constructor(
    @Inject(DRIZZLE_DATABASE) private readonly db: PostgresJsDatabase,
    private readonly contact: FeishuContactService,
  ) {}

  @Public()
  @Post()
  @HttpCode(200)
  async receive(@Body() body: Record<string, unknown>): Promise<{ challenge?: string; ok?: boolean }> {
    const payload = this.unwrap(body);
    if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
      this.assertToken(payload.token);
      return { challenge: payload.challenge };
    }
    this.assertToken(payload.token);
    const header = (payload.header ?? {}) as { event_id?: string; event_type?: string };
    const eventId = header.event_id ?? '';
    if (!eventId) return { ok: true };
    const inserted = await this.db.execute(sql`
      insert into sys_feishu_event (event_id, event_type)
      values (${eventId}, ${header.event_type ?? ''})
      on conflict (event_id) do nothing
      returning event_id
    `);
    if (inserted.length === 0) return { ok: true };
    const eventType = header.event_type ?? '';
    if (eventType.startsWith('contact.')) {
      await this.contact.incrementalSync();
    }
    return { ok: true };
  }

  /**
   * 校验飞书事件来源。
   *
   * ⚠️ 历史实现在 FEISHU_VERIFICATION_TOKEN 未配置时**直接 return 放行**，
   * 等于把 /api/feishu-event 变成一个任何人都能打的公开接口 —— 而事件体里
   * `contact.*` 会真实触发通讯录全量同步，可被用来打放大攻击 / 注入脏数据。
   *
   * 现改为**默认拒绝（fail closed）**：只有显式设置
   * FEISHU_ALLOW_UNVERIFIED_EVENTS=true 时才跳过校验，且仅限本地联调使用。
   */
  private assertToken(token: unknown): void {
    const expected = process.env.FEISHU_VERIFICATION_TOKEN;
    if (!expected) {
      const escape =
        (process.env.FEISHU_ALLOW_UNVERIFIED_EVENTS ?? '').toLowerCase() ===
        'true';
      const isProd = process.env.NODE_ENV === 'production';
      // 逃逸开关仅允许非生产；生产环境永远 fail-closed
      if (escape && !isProd) {
        return;
      }
      throw new UnauthorizedException(
        '未配置 FEISHU_VERIFICATION_TOKEN，已拒绝事件（本地联调可设 FEISHU_ALLOW_UNVERIFIED_EVENTS=true）'
      );
    }
    if (typeof token !== 'string' || !this.tokenEquals(token, expected)) {
      throw new UnauthorizedException('飞书事件校验失败');
    }
  }

  private tokenEquals(actual: string, expected: string): boolean {
    const a = Buffer.from(actual);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private unwrap(body: Record<string, unknown>): Record<string, unknown> {
    const encrypted = body.encrypt;
    if (typeof encrypted !== 'string') return body;
    const key = process.env.FEISHU_ENCRYPT_KEY;
    if (!key) throw new UnauthorizedException('飞书事件加密密钥未配置');
    try {
      const buf = Buffer.from(encrypted, 'base64');
      const decipher = createDecipheriv('aes-256-cbc', createHash('sha256').update(key).digest(), buf.subarray(0, 16));
      const plain = Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString('utf8');
      return JSON.parse(plain) as Record<string, unknown>;
    } catch {
      throw new UnauthorizedException('飞书事件解密失败');
    }
  }
}
