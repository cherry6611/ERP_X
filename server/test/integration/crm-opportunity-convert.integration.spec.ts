/**
 * 商机 → 合同：**同名查重 + 幂等收口**（本轮走查实测的缺陷，落成回归锁）。
 *
 * ## 为什么必须有这个规格
 *
 * 浏览器走查实测到的事实（修复前，跑的是当时的构建）：
 *
 * | 场景 | 报价转合同 | 商机转合同 |
 * |---|---|---|
 * | 同一单据重复转换 | 被拒（400） | 被拒（400） |
 * | **同名**单据再转一次 | **被拒（409）** | **静默生成第二份同名合同** |
 *
 * 两份同名合同不是"重复一点点"：它们各自可立项、各自确认收入、各自开票
 * → **同一笔生意在账上变成两笔**。`CrmService.convertToContract` 原先只检查
 * 自己的 `contractId`，完全没有同名查重，与报价侧口径分叉。
 *
 * ## 为什么用真库（pglite）而不是 mock
 *
 * 本缺陷的要害在 **SQL 谓词与事务边界**（`FOR UPDATE` 重读、同名 `SELECT`、
 * `WHERE contract_id IS NULL` 的 CAS），mock 掉 db 就只剩"调用过某个方法"
 * 这一条断言 —— 而那正是修复前也能通过的东西。
 *
 * ## 边界（诚实声明）
 *
 * - 数据库用 pglite（WASM PostgreSQL）内存库 + 全量迁移链，不连开发库；
 * - 用**真实 `CrmService` 实例**（含真实 `TaxResolverService`），只把注入的 db
 *   换成 pglite 驱动；
 * - **并发**在 pglite 单连接下无法制造真正的行锁竞争，故并发那条断言退化为
 *   "串行重复调用也只产生 1 份合同"；真正的行锁竞争由报价侧同构实现
 *   （`QuotationService.convert`，浏览器里连点两次已验证只出 1 份合同）承担；
 * - 不覆盖 Nest HTTP 层（DTO 管道 / `@NeedLogin` / `@CanCapability`）。
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { CrmService } from '@server/modules/crm/crm.service';
import { TaxResolverService } from '@server/modules/tax/tax-resolver.service';
import type { PostgresJsDatabase } from '@server/platform';
import { createHarness, type Harness } from './pglite-harness';

const FLOW_TIMEOUT_MS = 180_000;
const PREFIX = '[API_TEST]';

const UUID = {
  taxEntity: 'a1111111-1111-4111-8111-222222222222',
  customer: 'b2222222-2222-4222-8222-222222222222',
  oppWon: 'c3333333-3333-4333-8333-222222222222',
  oppSameName: 'c3333333-3333-4333-8333-333333333333',
  oppDraftStage: 'c3333333-3333-4333-8333-444444444444',
  oppRace: 'c3333333-3333-4333-8333-555555555555',
} as const;

/** 同名查重的主键：两个商机**共用同一个标题** */
const SAME_TITLE = `${PREFIX} 数据中台建设`;

let harness: Harness;
let service: CrmService;

async function seed(): Promise<void> {
  const db = harness.db;
  await db.exec(`
    INSERT INTO md_tax_entity (id, code, name, taxpayer_type, default_output_rate, default_input_rate)
    VALUES ('${UUID.taxEntity}', '${PREFIX}-TE', '${PREFIX} 测试主体', 'general', 6, 6);

    INSERT INTO md_customer (id, code, name, terms_days, tax_entity_id)
    VALUES ('${UUID.customer}', '${PREFIX}-C1', '${PREFIX} 测试客户', 30, '${UUID.taxEntity}');

    INSERT INTO crm_opportunity (id, code, customer_id, title, stage, amount, win_rate)
    VALUES
      ('${UUID.oppWon}', '${PREFIX}-OPP1', '${UUID.customer}', '${SAME_TITLE}', 'won', 100000, 100),
      ('${UUID.oppSameName}', '${PREFIX}-OPP2', '${UUID.customer}', '${SAME_TITLE}', 'won', 50000, 100),
      ('${UUID.oppDraftStage}', '${PREFIX}-OPP3', '${UUID.customer}', '${PREFIX} 未赢单商机', 'following', 1000, 30),
      ('${UUID.oppRace}', '${PREFIX}-OPP4', '${UUID.customer}', '${PREFIX} 并发商机', 'won', 8888, 100);
  `);
}

async function contractsNamed(name: string): Promise<Array<{ id: string; code: string }>> {
  const rows = await harness.db.query<{ id: string; code: string }>(
    `SELECT id, code FROM erp_contract WHERE name = $1`,
    [name]
  );
  return rows.rows;
}

async function opportunityContractId(id: string): Promise<string | null> {
  const rows = await harness.db.query<{ contract_id: string | null }>(
    `SELECT contract_id FROM crm_opportunity WHERE id = $1`,
    [id]
  );
  return rows.rows[0]?.contract_id ?? null;
}

beforeAll(async () => {
  harness = await createHarness();
  await seed();
  const orm = harness.orm as unknown as PostgresJsDatabase;
  service = new CrmService(orm, new TaxResolverService(orm));
}, FLOW_TIMEOUT_MS);

describe('商机转合同 —— 同名查重与幂等', () => {
  it('已赢单商机转合同：落库 1 份，并回写商机 contractId', async () => {
    const contract = await service.convertToContract(UUID.oppWon);
    expect(contract.name).toBe(SAME_TITLE);
    expect(contract.status).toBe('draft');
    expect(contract.amount).toBe(100000);

    const rows = await contractsNamed(SAME_TITLE);
    expect(rows).toHaveLength(1);
    expect(rows[0].code).toBe(contract.code);
    expect(await opportunityContractId(UUID.oppWon)).toBe(contract.id);
  }, FLOW_TIMEOUT_MS);

  it('同一商机重复转换被拒（可读中文），且不会多出合同', async () => {
    await expect(service.convertToContract(UUID.oppWon)).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(service.convertToContract(UUID.oppWon)).rejects.toThrow(
      '该商机已生成合同，请勿重复转换'
    );
    expect(await contractsNamed(SAME_TITLE)).toHaveLength(1);
  }, FLOW_TIMEOUT_MS);

  it('**同名**的另一商机转换被 409 拒绝，并给出可执行的下一步', async () => {
    await expect(
      service.convertToContract(UUID.oppSameName)
    ).rejects.toBeInstanceOf(ConflictException);

    let message = '';
    try {
      await service.convertToContract(UUID.oppSameName);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('已存在同名合同');
    expect(message).toContain(SAME_TITLE);
    expect(message).toContain('请确认后再转换');
    // 关键：拒绝之后**不能**留下第二份同名合同
    expect(await contractsNamed(SAME_TITLE)).toHaveLength(1);
    expect(await opportunityContractId(UUID.oppSameName)).toBeNull();
  }, FLOW_TIMEOUT_MS);

  it('未赢单商机被拒（状态机前置），提示可读', async () => {
    await expect(
      service.convertToContract(UUID.oppDraftStage)
    ).rejects.toThrow('只有已赢单的商机可以转合同');
    expect(await contractsNamed(`${PREFIX} 未赢单商机`)).toHaveLength(0);
  }, FLOW_TIMEOUT_MS);

  it('重复调用（模拟双击/重放）也只产生 1 份合同 —— 幂等', async () => {
    const results = await Promise.allSettled([
      service.convertToContract(UUID.oppRace),
      service.convertToContract(UUID.oppRace),
      service.convertToContract(UUID.oppRace),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(await contractsNamed(`${PREFIX} 并发商机`)).toHaveLength(1);
    // 失败的那些必须是"已生成合同"，不能是别的错误
    for (const r of results) {
      if (r.status === 'rejected') {
        expect(String((r.reason as Error).message)).toMatch(
          /已生成合同|已被转换/
        );
      }
    }
  }, FLOW_TIMEOUT_MS);
});
