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
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * 里程碑权重法挣值计算：
 * EV = Σ(已达成里程碑权重)/100 × BAC，PV = Σ(baselineDate≤今天的权重)/100 × BAC，
 * AC = 已归集实际成本，SPI=EV/PV，CPI=EV/AC，EAC=BAC/CPI。
 * 无加权里程碑或分母为 0 时对应指标为 null。
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
    if (m.baselineDate !== null && m.baselineDate <= today) {
      dueWeight += weight;
    }
  }
  if (totalWeight <= 0 || budget <= 0) {
    return { spi: null, cpi: null, eac: null };
  }
  const ev = (reachedWeight / 100) * budget;
  const pv = (dueWeight / 100) * budget;
  const spi = pv > 0 ? round2(ev / pv) : null;
  const cpi = actualCost > 0 ? round2(ev / actualCost) : null;
  const eac = cpi !== null && cpi > 0 ? round2(budget / cpi) : null;
  return { spi, cpi, eac };
}
