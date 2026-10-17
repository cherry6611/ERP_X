/**
 * 工资净额按**工时占比**分摊到项目（从 `hr-pay.service.ts` 抽出，§5.9）。
 *
 * ## 为什么这段必须能单测
 *
 * 项目成本是按分摊额写进 `erp_project_cost` 的，所以分摊额一旦有 1 分误差，
 * 会沿着成本口径一路传下去（项目毛利、BI 健康度、完工外推全部受影响）。
 * 而这段代码是**"按比例 + 尾差找平"**——最容易写错、又最难在界面上看出来的一类算术：
 *
 * | 写错的方式 | 后果 |
 * |---|---|
 * | 忘记找平 | `Σ分摊额 ≠ 净额`，差几分钱，界面上每行数字都"看起来对" |
 * | 找平用了非对称取整 | 找平行可能是负数；`Math.round` 对负数**向 +∞**、`round2` **远离零**，在 `-x.xx5` 上差 1 分，找平就不再精确 |
 * | 红冲方向取整不一致 | **原分摊 + 红冲分摊 ≠ 0**，账上留下残值，且借贷仍平、报表仍平 |
 *
 * ## 为什么用 `round2` 而不是内联 `Math.round(x*100)/100`
 *
 * 见 `shared/number.ts`：`round2` 是十进制字符串实现、**对负数对称**，
 * 因此 `round2(x) + round2(-x) === 0` 恒成立。上面的第三个坑正是靠这条性质闭合的。
 */

import { round2 } from '@server/common/utils/number';

export interface HourRow {
  projectId: string | null;
  totalHours: number | string | null | undefined;
}

export interface AllocatedItem {
  projectId: string;
  amount: number;
}

/**
 * 按工时占比把 `net` 分摊到各项目；**最后一行吸收尾差**，保证 `Σ === net`。
 *
 * - `projectId` 为空或工时 ≤ 0 的行被**过滤**（不参与分摊，也不占一行）；
 * - 总工时为 0（或全部被过滤）→ 返回空数组；
 * - 只有一行 → 该行拿全额（不走比例，避免 `net × 1` 再取整引入误差）。
 */
export function allocateByHours(net: number, rows: readonly HourRow[]): AllocatedItem[] {
  const valid = rows.filter(
    (row) => row.projectId !== null && Number(row.totalHours) > 0,
  ) as Array<{ projectId: string; totalHours: number | string }>;

  const totalHours = valid.reduce((acc, row) => acc + Number(row.totalHours), 0);
  if (!(totalHours > 0)) return [];

  const n = Number(net) || 0;

  /* 单行：直接拿全额（避免 net × 1 取整带来的无意义舍入） */
  if (valid.length === 1) {
    return [{ projectId: valid[0].projectId, amount: round2(n) }];
  }

  const items: AllocatedItem[] = valid.map((row) => ({
    projectId: row.projectId,
    amount: round2(n * (Number(row.totalHours) / totalHours)),
  }));

  /*
   * 尾差找平：最后一行 = 净额 − 前 n−1 行之和。
   * `round2` 对负数对称，所以红冲（n 为负）时这一行同样精确。
   */
  const allocated = items.slice(0, -1).reduce((acc, item) => acc + item.amount, 0);
  items[items.length - 1].amount = round2(n - allocated);

  return items;
}
