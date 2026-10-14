import {
  ROLE_CODES,
  hasCapability,
  hasWriteCapability,
  type Capability,
} from '@shared/rbac';

/**
 * B-01：前端读写显隐的**语义边界**（回归锁）。
 *
 * ## 为什么需要这组测试
 *
 * `CanCapability` 走 `hasCapability`（矩阵中 `r` 或 `rw` 都通过），
 * `CanCapabilityWrite` 走 `hasWriteCapability`（**必须是 `rw`**）。
 * 用错组件不会报错，只会让只读角色**看到点了必然被后端拒绝的按钮**
 * （B-01 验收标准②要求前端与后端口径一致）。
 *
 * 实测存在这类差异的能力码：`tax_entity` / `pur_asset` ——
 * 它们在 `route-capability.ts` 中是 `write: null`（写接口沿用读能力码），
 * 矩阵里 `finance_viewer` / `project_manager` 拿到 `r`。
 * 也就是说：**"能力码看起来像读的"不代表它只用于读**。
 *
 * 这组测试把"哪些码会出现读写差异"固定下来：
 * - 若将来 MATRIX 给某个写能力码授予 `r`，这里会失败并提醒检查前端；
 * - 若清单变化，也强制有人重新审视前端显隐口径。
 */
describe('B-01 能力码读写语义', () => {
  it('以 _write 结尾的能力码：非 admin 角色绝不应只拿到 r（否则 CanCapability 会漏出写按钮）', () => {
    // 这些码在前端被 CanCapabilityWrite 使用；若矩阵给某角色 r，
    // hasCapability 会为 true 而 hasWriteCapability 为 false —— 正是危险情形。
    const writeCodes: Capability[] = [
      'crm_write',
      'projects_write',
      'finance_write',
      'hr_write',
      'drive_write',
    ];
    const offenders: string[] = [];
    for (const capability of writeCodes) {
      for (const role of ROLE_CODES) {
        if (role === 'admin') continue;
        const read = hasCapability([role], capability);
        const write = hasWriteCapability([role], capability);
        if (read && !write) {
          offenders.push(`${capability} / ${role}: hasCapability=true 但 hasWriteCapability=false`);
        }
      }
    }
    // 当前 MATRIX 中 _write 码只给 admin，因此 offenders 为空。
    // 若未来出现差异，这里失败是**有意的**：必须重新审视前端是否用错组件。
    expect(offenders).toEqual([]);
  });

  it('"读写同码"能力（route-capability 中 write:null）确实存在读写差异', () => {
    // 这组断言不是"要求差异存在"，而是**记录事实**：
    // 这些码只有 admin 可写，但其他角色可读，因此前端写按钮必须用
    // CanCapabilityWrite。若哪天它们变成只给 admin，这里会失败，
    // 提醒去掉 check-frontend-rbac.mjs 里相应的 WRITE_ONLY 条目。
    const observed: string[] = [];
    for (const capability of ['tax_entity', 'pur_asset'] as Capability[]) {
      for (const role of ROLE_CODES) {
        if (hasCapability([role], capability) && !hasWriteCapability([role], capability)) {
          observed.push(`${capability}/${role}`);
        }
      }
    }
    expect(observed).toContain('tax_entity/finance_viewer');
    expect(observed).toContain('pur_asset/finance_viewer');
  });

  it('admin 对任何能力码都是读写皆可（前端不该把 admin 挡在外面）', () => {
    const sample: Capability[] = [
      'dashboard',
      'crm',
      'crm_write',
      'finance',
      'finance_write',
      'tax_entity',
      'pur_asset',
      'admin_ops',
      'audit',
      'identity',
      'drive',
      'drive_write',
      'hr',
      'hr_write',
      'projects',
      'projects_write',
    ];
    const blocked = sample.filter(
      (capability) => !(hasCapability(['admin'], capability) && hasWriteCapability(['admin'], capability))
    );
    expect(blocked).toEqual([]);
  });

  it('未登录（空角色）不获得任何写能力', () => {
    const writeCodes: Capability[] = [
      'crm_write',
      'projects_write',
      'finance_write',
      'hr_write',
      'drive_write',
      'admin_ops',
      'audit',
      'identity',
      'tax_entity',
      'pur_asset',
    ];
    const granted = writeCodes.filter((capability) =>
      hasWriteCapability([], capability)
    );
    expect(granted).toEqual([]);
  });

  it('写能力判定严格强于读能力判定（write ⇒ read）', () => {
    // 这是前端"用 CanCapability 判写按钮"之所以危险的根因：
    // 它比写判定宽松。若哪天 write 不再蕴含 read，整个模型都要重新设计。
    const all: Capability[] = [
      'dashboard', 'crm', 'crm_write', 'tax_entity', 'projects', 'projects_write',
      'pur_asset', 'finance', 'finance_write', 'hr', 'hr_write', 'identity',
      'admin_ops', 'audit', 'drive', 'drive_write',
    ];
    const violations: string[] = [];
    for (const capability of all) {
      for (const role of ROLE_CODES) {
        if (hasWriteCapability([role], capability) && !hasCapability([role], capability)) {
          violations.push(`${capability}/${role}: 可写但不可读`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
