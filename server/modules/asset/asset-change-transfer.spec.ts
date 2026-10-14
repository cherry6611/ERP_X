import {
  applyMigrationChain,
  createDrizzle,
  createPglite,
  loadMigrations,
  queryRows,
} from '@server/test/integration/pglite-harness';
import { AssetService } from '@server/modules/asset/asset.service';
import type { PostgresJsDatabase } from '@server/platform';

const CHAIN_TIMEOUT_MS = 120_000;
const PREFIX = '[API_TEST]';

/**
 * D-08 回归：**转交必须真正改变资产归属**。
 *
 * ## 为什么专门测这个
 *
 * 需求书的"现状与差距"原文点名这个缺陷：**「`ast_change` 存在但 transfer 不落归属」**。
 * 实测确认原先 approve 分支只处理 `receive` / `scrap`，
 * 于是转交单审批通过后**什么都不发生** —— `ast_asset.department_id` 一点没变，
 * 资产仍挂在原部门，折旧分摊与部门成本归集全部错位。
 *
 * 这类缺陷比"功能缺失"更危险：**它表现为成功**。审批通过、单据状态变绿，
 * 只有等到部门成本对不上时才会被发现，而那时往往已跨了多个期间。
 * 因此这里的断言必须落在**资产的归属字段真的变了**，而不是"接口返回 200"。
 */
describe('D-08 资产转交落归属', () => {
  let db: Awaited<ReturnType<typeof createPglite>>;
  let service: AssetService;
  let deptA = '';
  let deptB = '';
  let projectB = '';

  /** 生成格式合法的测试 UUID（第 3 段须以 4 开头、第 4 段以 8 开头） */
  const uid = (n: number) =>
    `d0800000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  beforeAll(async () => {
    db = await createPglite();
    await applyMigrationChain(db, loadMigrations());
    service = new AssetService(
      createDrizzle(db) as unknown as PostgresJsDatabase
    );

    // 两个部门 + 一个项目（资产归属指向 hr_department，与 AssetService 的 join 一致）
    const depts = [
      { id: uid(1), name: `${PREFIX}部门A` },
      { id: uid(2), name: `${PREFIX}部门B` },
    ];
    for (const d of depts) {
      await db.query(
        `INSERT INTO hr_department (id, code, name) VALUES ($1,$2,$3)
         ON CONFLICT (id) DO NOTHING`,
        [d.id, `${PREFIX}D${d.id.slice(-1)}`, d.name]
      );
    }
    deptA = depts[0].id;
    deptB = depts[1].id;

    await db.query(
      `INSERT INTO erp_project (id, code, name, status)
       VALUES ($1,$2,$3,'executing') ON CONFLICT (id) DO NOTHING`,
      [uid(3), `${PREFIX}PJ`, `${PREFIX}项目B`]
    );
    projectB = uid(3);
  }, CHAIN_TIMEOUT_MS);

  afterAll(async () => {
    await db?.close();
  });

  /** 建一张挂在部门A 的资产，返回 id */
  const createAsset = async (code: string): Promise<string> => {
    const asset = await service.createAsset({
      name: `${PREFIX}资产${code}`,
      category: 'other',
      originalValue: 12_000,
      purchaseDate: '2026-10-01',
      usefulMonths: 36,
      departmentId: deptA,
    });
    return asset.id;
  };

  const deptOf = async (assetId: string): Promise<string | null> => {
    const rows = await queryRows<{ department_id: string | null }>(
      db,
      `SELECT department_id FROM ast_asset WHERE id = '${assetId}'`
    );
    return rows[0]?.department_id ?? null;
  };

  const projectOf = async (assetId: string): Promise<string | null> => {
    const rows = await queryRows<{ project_id: string | null }>(
      db,
      `SELECT project_id FROM ast_asset WHERE id = '${assetId}'`
    );
    return rows[0]?.project_id ?? null;
  };

  it('未指定目标部门与项目的转交 → 被拒绝（而不是"看起来成功"）', async () => {
    const assetId = await createAsset('CHG-REJ');
    await expect(
      service.createChange({
        assetId,
        changeType: 'transfer',
      })
    ).rejects.toThrow(/必须指定目标部门或目标项目/);
  });

  it('目标部门不存在 → 创建时即拒绝（不留到审批阶段才失败）', async () => {
    const assetId = await createAsset('CHG-BAD');
    await expect(
      service.createChange({
        assetId,
        changeType: 'transfer',
        targetDepartmentId: uid(99),
      })
    ).rejects.toThrow(/目标部门不存在/);
  });

  it('关键回归：转交审批通过后，资产归属真的变了', async () => {
    const assetId = await createAsset('CHG-OK');
    // 前置：资产当前在部门A
    expect(await deptOf(assetId)).toBe(deptA);

    const change = await service.createChange({
      assetId,
      changeType: 'transfer',
      targetDepartmentId: deptB,
      targetProjectId: projectB,
    });

    // 审批前：归属**不应**变化（变更单未生效）
    expect(await deptOf(assetId)).toBe(deptA);

    await service.changeAction(change.id, 'approve');

    // ✅ 这正是原实现缺失的一步
    expect(await deptOf(assetId)).toBe(deptB);
    expect(await projectOf(assetId)).toBe(projectB);
  });

  it('只转部门（不传项目）→ 部门变化、项目保持原值', async () => {
    const assetId = await createAsset('CHG-DEPT');
    const projectBefore = await projectOf(assetId);

    const change = await service.createChange({
      assetId,
      changeType: 'transfer',
      targetDepartmentId: deptB,
    });
    await service.changeAction(change.id, 'approve');

    expect(await deptOf(assetId)).toBe(deptB);
    // 未提供项目 → 不应被清空（避免"只转部门"顺手清掉项目归属）
    expect(await projectOf(assetId)).toBe(projectBefore);
  });

  it('只转项目（不传部门）→ 项目变化、部门保持原值', async () => {
    const assetId = await createAsset('CHG-PRJ');

    const change = await service.createChange({
      assetId,
      changeType: 'transfer',
      targetProjectId: projectB,
    });
    await service.changeAction(change.id, 'approve');

    expect(await projectOf(assetId)).toBe(projectB);
    expect(await deptOf(assetId)).toBe(deptA);
  });

  it('驳回转交 → 归属不变（不能因为走了流程就动数据）', async () => {
    const assetId = await createAsset('CHG-REJ2');
    const change = await service.createChange({
      assetId,
      changeType: 'transfer',
      targetDepartmentId: deptB,
    });
    await service.changeAction(change.id, 'reject');

    expect(await deptOf(assetId)).toBe(deptA);
  });

  it('变更单返回结构化目标与中文名（供界面直接展示，无需解析文本）', async () => {
    const assetId = await createAsset('CHG-NAME');
    const change = await service.createChange({
      assetId,
      changeType: 'transfer',
      targetDepartmentId: deptB,
      targetProjectId: projectB,
    });
    expect(change.targetDepartmentId).toBe(deptB);
    expect(change.targetDepartmentName).toBe(`${PREFIX}部门B`);
    expect(change.targetProjectId).toBe(projectB);
    expect(change.targetProjectName).toBe(`${PREFIX}项目B`);
  });

  it('已处理的变更单不能重复审批（既有约束未被破坏）', async () => {
    const assetId = await createAsset('CHG-ONCE');
    const change = await service.createChange({
      assetId,
      changeType: 'transfer',
      targetDepartmentId: deptB,
    });
    await service.changeAction(change.id, 'approve');
    await expect(service.changeAction(change.id, 'approve')).rejects.toThrow(
      /已处理/
    );
  });
});
