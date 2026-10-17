// 统一取整口径（与全仓金额一致），避免同一仓多份 round2 语义漂移
import { round2 } from './number';

export interface EvmMilestoneInput {
  status: string | null;
  weightPct: string | number | null;
  baselineDate: string | null;
  forecastDate?: string | null;
}

export interface EvmResult {
  spi: number | null;
  cpi: number | null;
  eac: number | null;
  /**
   * B3：里程碑权重合计（仅计权重 > 0 的里程碑）。
   *
   * 暴露出来是为了让预警能**单独告警"权重未配平"** —— 见 `balanced` 的说明。
   */
  totalWeight: number;
  /**
   * B3：权重是否配平（|Σ权重 − 100| ≤ 0.01）。
   *
   * `false` 时 SPI/CPI 仍会算出数值，但**分母口径是归一化后的权重**，
   * 与"权重和 = 100"的直觉口径不同；调用方（如 `delivery_warning_weekly`、
   * BI 健康度）必须据此提示"进度基准未配平"，否则 `spi` 看起来正常而实际
   * 只完成了很小一部分工作量。
   */
  balanced: boolean;
}

/**
 * 里程碑权重法挣值计算：
 *
 *   EV = Σ(已达成里程碑权重) / Σ(全部权重) × BAC
 *   PV = Σ(baselineDate ≤ 今天的权重) / Σ(全部权重) × BAC
 *   AC = 已归集实际成本，SPI = EV/PV，CPI = EV/AC，EAC = BAC/CPI
 *
 * ## B3 修正：分母必须是 `totalWeight`，不是硬编码的 100
 *
 * 原实现把 `totalWeight` **只当作"有没有权重"的开关**，而 EV/PV 用**硬编码 `/100`**。
 * 于是一个只填了 1 个里程碑、权重 30 的项目会得到：
 *   PV = 0.3 × BAC，EV = 0.3 × BAC → **SPI = 1.00**，
 * 而实际可能只完成了 30% 的工作量 —— 报表显示"进度成本双达标"，
 * `delivery-warning.automation.ts` 的 `spi < 0.9` 门限与 BI 健康度**全部失明**。
 *
 * 反向（权重和 > 100）更荒谬：合计 150% 时 `EV = 1.5 × BAC` ——
 * **挣值超过完工预算**，物理上不可能，CPI 会 > 1 而显示"成本节约"。
 *
 * 归一化后两侧都回到 [0, 1] 区间；同时返回 `balanced` 让调用方能把
 * "权重未配平"作为**独立告警**暴露出来，而不是让一个看起来正常的 SPI 掩盖它。
 *
 * ## 附带修正：PV 的基准日期优先取 `forecastDate`
 *
 * 原实现用 `baselineDate <= today` 算 `dueWeight`，**完全忽略 `forecastDate`**。
 * 而 `erp_project_milestone` 明确有 `baseline_date / forecast_date` 两个字段。
 * 后果：一个已延期到明年的里程碑，只要基线日期已过就仍然计入 PV ——
 * **逾期可以被"洗白"**为 SPI 正常。因此 PV 用 `forecastDate ?? baselineDate`：
 * 预测日期才是"当前承诺的完成时点"。
 */
export function computeEvm(
  budget: number,
  actualCost: number,
  milestones: EvmMilestoneInput[],
  today: string
): EvmResult {
  let reachedWeight = 0;
  let dueWeight = 0;
  let totalWeight = 0;
  for (const m of milestones) {
    const weight: number = Number(m.weightPct ?? 0);
    if (weight <= 0) continue;
    totalWeight += weight;
    if ((m.status ?? 'pending') === 'reached') {
      reachedWeight += weight;
    }
    // B3：基准日期优先取预测日期（延期后的承诺时点），否则退回基线日期
    const dueBasis = m.forecastDate ?? m.baselineDate;
    if (dueBasis !== null && dueBasis !== undefined && dueBasis <= today) {
      dueWeight += weight;
    }
  }
  const balanced: boolean = Math.abs(totalWeight - 100) <= 0.01;
  if (totalWeight <= 0 || budget <= 0) {
    return { spi: null, cpi: null, eac: null, totalWeight, balanced };
  }
  // 归一化：分母用 totalWeight 而非 100（见上方 B3 说明）
  const ev = (reachedWeight / totalWeight) * budget;
  const pv = (dueWeight / totalWeight) * budget;
  const spi = pv > 0 ? round2(ev / pv) : null;
  const cpi = actualCost > 0 ? round2(ev / actualCost) : null;
  const eac = cpi !== null && cpi > 0 ? round2(budget / cpi) : null;
  return { spi, cpi, eac, totalWeight, balanced };
}
