import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { UpdateDatasetDto } from './data-asset.controller';

/**
 * `UpdateDatasetDto.contractId` 的**校验闸门**测试（需求 ① 的自动化证据）。
 *
 * ## 为什么这组测试必须存在
 *
 * `contractId` 在 PATCH 上是"可空外键"，装饰器写法
 * `@IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID()` 有三个容易出错的点，
 * 而它们**都不会被 `tsc` 发现**：
 *
 * 1. 少了 `@ValidateIf` → `null` 仍被放行（`@IsOptional` 已短路），
 *    但语义上就说不清"为什么允许 null"，且一旦有人改成 `@IsUUID()` 不带
 *    `@IsOptional`，`null` 与 `undefined` 会**双双 400** —— 客户端"不传该字段"
 *    这种最普通的 PATCH 会直接失败；
 * 2. 少了 `@IsOptional` → `undefined`（不传）会 400，同样打爆普通 PATCH；
 * 3. 写成 `@IsOptional() @IsUUID()` 而漏 `@ValidateIf`，虽然行为恰好正确，
 *    但一旦后续有人去掉 `@IsOptional` 就静默变味。
 *
 * 更关键的是仓库里有个**相反的断言**：`projects.dto.ts` 的文件头注释称
 * `@IsOptional() @ValidateIf((_, v) => v !== null) @IsUUID()` "等于不校验字符串"。
 * 本组测试用真实行为回答这个问题 —— 若那条注释成立，下面的"畸形字符串必须被拒"
 * 会立刻失败。实测结论：**该组合是有效的**，非 null 字符串确实会走 `@IsUUID()`。
 *
 * 端到端的证据（真实 HTTP 400/200）见报告中 `node dist/server/main.js` 的四步验证；
 * 本文件保证的是**回归时不用起服务也能发现**。
 */
async function errorsOf(payload: Record<string, unknown>): Promise<string[]> {
  const instance = plainToInstance(UpdateDatasetDto, payload);
  const errors = await validate(instance, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return errors.map((e) => e.property);
}

describe('UpdateDatasetDto#contractId 校验闸门', () => {
  const UUID = '11111111-1111-4111-8111-111111111111';

  it('传合法 UUID → 通过', async () => {
    expect(await errorsOf({ contractId: UUID })).toEqual([]);
  });

  it('传 null → 通过（解除关联；这正是 @ValidateIf 存在的理由）', async () => {
    expect(await errorsOf({ contractId: null })).toEqual([]);
  });

  it('完全不传 contractId → 通过（PATCH「不动」语义）', async () => {
    expect(await errorsOf({})).toEqual([]);
    expect(await errorsOf({ name: '只改名字' })).toEqual([]);
  });

  it('传畸形的非 null 值 → 被拒（证明 @IsUUID 真的生效了）', async () => {
    // 这一条就是 projects.dto.ts 那句注释的反例：
    // 若该组合真的"短路成不校验"，下面三行会全部拿到空数组而失败。
    expect(await errorsOf({ contractId: 'not-a-uuid' })).toContain('contractId');
    expect(await errorsOf({ contractId: 123 })).toContain('contractId');
    expect(await errorsOf({ contractId: '' })).toContain('contractId');
  });

  it('契约里没有的字段被拒（whitelist + forbidNonWhitelisted 的实际行为）', async () => {
    /*
     * 这条记录的是**同一模块内两种失败方式的差别**：
     * · 契约里没有 → 400（可见，好排查）；
     * · 契约里有但 service 不 patch → 静默丢弃（危险）。
     * `contractId` 原先属第一种，补契约后又可能滑向第二种 ——
     * service 侧的 patch 由 `dataset-patch.spec.ts` 守。
     */
    expect(await errorsOf({ contractIds: UUID })).toContain('contractIds');
  });

  it('其余字段不受影响（回归：name/source/maskLevel/status/remark）', async () => {
    expect(
      await errorsOf({
        name: '数据集',
        source: '',
        maskLevel: 'L2',
        status: 'offline',
        remark: '',
        contractId: null,
      })
    ).toEqual([]);
  });
});
