/**
 * D-02：票据备查簿深化的规则内核。
 *
 * ## 为什么备查簿需要独立的规则层
 *
 * C-04 已经实现了票据状态机与单张票的贴现息计算，但**备查簿**是另一个视角：
 * 它要回答的是"这一叠票整体健康不健康"，而《票据管理实施办法》对备查簿有
 * 两项硬要求，都不能靠"列出所有票"满足：
 *
 * 1. **缺号 / 重号检查**：备查簿须连续登记。缺号可能是漏登记（票丢了不知道），
 *    重号必然是重复登记（同一张票抵扣两次）。这两类都必须能被**主动发现**，
 *    而不是等审计来问。
 * 2. **贴现成本可解释**：多张票分批贴现时，"这批票一共付了多少贴现息、
 *    平均成本率多少"是资金成本分析的基础数据。单张票的息算得对，
 *    不代表能回答整体成本问题。
 *
 * 此外还需要**到期结构**（账龄分桶）：一张 6 个月后到期的票和一张 3 天后
 * 到期的票，现金流含义完全不同；备查簿按到期日分桶才能看出流动性压力。
 */

import {
  NOTE_STATUS_LABELS,
  type NoteStatus,
} from '@server/common/tax/note-rules';

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function toNumber(value: number | string | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/* ==================== ① 票号连续性检查 ==================== */

export interface NoteNoCheckRow {
  code: string;
  noteNo: string;
  noteType: string;
  status: string;
  amount: number;
}

export interface NoteNoGap {
  /** 缺口前一票号 */
  before: string;
  /** 缺口后一票号 */
  after: string;
  /** 缺失的票号数量 */
  missing: number;
}

export interface NoteNoDuplicate {
  noteNo: string;
  /** 重复登记的票据编号（含内部 code，便于定位） */
  codes: string[];
  amount: number;
  /** 是否全部为已作废（全作废不算风险，可能是重开后作废） */
  allVoided: boolean;
}

export interface NoteNoCheckResult {
  totalNotes: number;
  /** 实际取到的票号数量（无票号的票不计入连续性检查） */
  numberedNotes: number;
  /** 无票号的票数（票号必填，非 0 说明数据有缺口） */
  missingNoteNoCount: number;
  gaps: NoteNoGap[];
  duplicates: NoteNoDuplicate[];
  /** 连续性是否通过（不考虑重复，只看缺号） */
  continuous: boolean;
  /** 是否存在需要处理的问题（缺号或重复） */
  hasIssues: boolean;
  message: string;
}

/** 票号中的数字部分（与 tax-risk 的发票号检测同口径，取后 8 位） */
function noteNoDigits(noteNo: string): number | null {
  const digits = (noteNo ?? '').replace(/\D/g, '');
  if (digits.length === 0) return null;
  const parsed = Number(digits.slice(-8));
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * 票号连续性检查。
 *
 * 口径说明（**需财务确认**）：
 * - **重号**：同一票号出现在多张登记上 → 高风险（可能重复入账）。
 *   但**全部为已作废**时降级：可能是"作废后重开"的正常操作，
 *   此时只在重复清单里标注 `allVoided`，由人工判断。
 * - **缺号**：只报缺口 ≤ 1000 的情况（差太大说明票号体系不同，
 *   例如银行承兑与商业承兑的号段独立），且每次只在每个类型内报前 5 处，
 *   避免一张表刷出几十条。
 * - 销项（收到的）与进项（开出的）票据号段体系不同，**分别检查**。
 */
export function checkNoteNumbering(rows: NoteNoCheckRow[]): NoteNoCheckResult {
  const withNo = rows.filter((row) => (row.noteNo ?? '').trim().length > 0);
  const missingNoteNoCount = rows.length - withNo.length;

  /* --- 重号 --- */
  const byNo = new Map<string, NoteNoCheckRow[]>();
  for (const row of withNo) {
    const key = row.noteNo.trim();
    const list = byNo.get(key) ?? [];
    list.push(row);
    byNo.set(key, list);
  }
  const duplicates: NoteNoDuplicate[] = [];
  for (const [noteNo, list] of byNo) {
    if (list.length <= 1) continue;
    duplicates.push({
      noteNo,
      codes: list.map((row) => row.code),
      amount: round2(list.reduce((sum, row) => sum + toNumber(row.amount), 0)),
      allVoided: list.every((row) => row.status === 'voided'),
    });
  }

  /* --- 缺号（按票据类型分别检查） --- */
  const gaps: NoteNoGap[] = [];
  const types = [...new Set(withNo.map((row) => row.noteType))];
  for (const type of types) {
    const sorted = withNo
      .filter((row) => row.noteType === type)
      .map((row) => ({ row, value: noteNoDigits(row.noteNo) }))
      .filter(
        (item): item is { row: NoteNoCheckRow; value: number } =>
          item.value !== null
      )
      .sort((a, b) => a.value - b.value);
    let reported = 0;
    for (let index = 1; index < sorted.length && reported < 5; index += 1) {
      const gap = sorted[index].value - sorted[index - 1].value;
      if (gap > 1 && gap <= 1000) {
        gaps.push({
          before: sorted[index - 1].row.noteNo,
          after: sorted[index].row.noteNo,
          missing: gap - 1,
        });
        reported += 1;
      }
    }
  }

  // 缺票号本身也是问题：票号是必填项，备查簿不允许存在"无号票"。
  // 这里曾漏掉它，导致"有票号缺失"时仍报"连续性检查通过" ——
  // 一份声称通过但实际缺数据的报告，比不提供报告更危险。
  const hasIssues =
    gaps.length > 0 || duplicates.length > 0 || missingNoteNoCount > 0;
  const messages: string[] = [];
  if (gaps.length > 0) {
    const totalMissing = gaps.reduce((sum, gap) => sum + gap.missing, 0);
    messages.push(`票号存在 ${gaps.length} 处缺口，共缺 ${totalMissing} 个票号`);
  }
  if (duplicates.length > 0) {
    const risky = duplicates.filter((item) => !item.allVoided).length;
    messages.push(
      `票号重复 ${duplicates.length} 处` +
        (risky > 0
          ? `（其中 ${risky} 处含未作废票据，需立即核查是否重复入账）`
          : '（全部为已作废票据，可能是作废后重开）')
    );
  }
  if (missingNoteNoCount > 0) {
    messages.push(`${missingNoteNoCount} 张票据缺票号`);
  }

  return {
    totalNotes: rows.length,
    numberedNotes: withNo.length,
    missingNoteNoCount,
    gaps,
    duplicates: duplicates.sort((a, b) => b.amount - a.amount),
    continuous: gaps.length === 0,
    hasIssues,
    message: hasIssues
      ? messages.join('；')
      : `备查簿连续性检查通过（${withNo.length} 张票据票号无缺口、无重复）`,
  };
}

/* ==================== ② 到期结构（账龄分桶） ==================== */

/** 到期分桶：已逾期 / 7 天内 / 30 天内 / 90 天内 / 90 天以上 */
export const NOTE_DUE_BUCKETS = [
  'overdue',
  'within7',
  'within30',
  'within90',
  'beyond90',
] as const;
export type NoteDueBucket = (typeof NOTE_DUE_BUCKETS)[number];

export const NOTE_DUE_BUCKET_LABELS: Record<NoteDueBucket, string> = {
  overdue: '已逾期',
  within7: '7 天内到期',
  within30: '8~30 天到期',
  within90: '31~90 天到期',
  beyond90: '90 天以上',
};

export function bucketOfDaysLeft(daysLeft: number): NoteDueBucket {
  if (daysLeft < 0) return 'overdue';
  if (daysLeft <= 7) return 'within7';
  if (daysLeft <= 30) return 'within30';
  if (daysLeft <= 90) return 'within90';
  return 'beyond90';
}

export interface NoteDueStructureResult {
  buckets: Array<{
    bucket: NoteDueBucket;
    label: string;
    count: number;
    amount: number;
    /** 占未结清总额的百分比 */
    share: number;
  }>;
  /** 未结清总额（排除已结清与已拒付） */
  outstandingAmount: number;
  outstandingCount: number;
  /** 已逾期金额（流动性风险的直接指标） */
  overdueAmount: number;
}

/**
 * 按到期日分桶统计未结清票据。
 *
 * 已结清/已拒付的票不参与（它们不再产生未来现金流）。
 * 已逾期单独成桶并被计为风险 —— 逾期票可能进入追索流程，
 * 与"还有 3 个月到期"是完全不同的处境。
 */
export function buildDueStructure(
  rows: Array<{ status: string; amount: number; daysLeft: number }>
): NoteDueStructureResult {
  const outstanding = rows.filter(
    (row) => row.status !== 'settled' && row.status !== 'dishonored'
  );
  const outstandingAmount = round2(
    outstanding.reduce((sum, row) => sum + toNumber(row.amount), 0)
  );
  const buckets = NOTE_DUE_BUCKETS.map((bucket) => {
    const matched = outstanding.filter(
      (row) => bucketOfDaysLeft(row.daysLeft) === bucket
    );
    const amount = round2(matched.reduce((sum, row) => sum + toNumber(row.amount), 0));
    return {
      bucket,
      label: NOTE_DUE_BUCKET_LABELS[bucket],
      count: matched.length,
      amount,
      share: outstandingAmount === 0 ? 0 : round2((amount / outstandingAmount) * 100),
    };
  });
  return {
    buckets,
    outstandingAmount,
    outstandingCount: outstanding.length,
    overdueAmount: buckets.find((item) => item.bucket === 'overdue')?.amount ?? 0,
  };
}

/* ==================== ③ 贴现成本分析 ==================== */

export interface DiscountedNoteRow {
  code: string;
  noteNo: string;
  noteType: string;
  /** 票面金额 */
  amount: number;
  /** 贴现息 */
  discountInterest: number | null;
  /** 贴现率（%） */
  discountRate: number | null;
  /** 实际计息天数 */
  days: number | null;
}

export interface DiscountCostResult {
  /** 贴现票据张数 */
  count: number;
  /** 贴现金额合计（票面） */
  amount: number;
  /** 贴现息合计 */
  interest: number;
  /** 实际到账合计 */
  netProceeds: number;
  /**
   * 综合贴现成本率（%）= 贴现息合计 / 贴现金额合计 × 100。
   *
   * 注意这是**加权综合率**，不是各张票贴现率的算术平均 ——
   * 后者会被一张小额高息票严重扭曲。加权综合率才是资金成本的真实反映。
   */
  weightedRate: number;
  /** 按票据类型分组（银行承兑通常成本更低，便于对比议价空间） */
  byType: Array<{
    noteType: string;
    count: number;
    amount: number;
    interest: number;
    weightedRate: number;
  }>;
  /** 年化成本率（%）：按实际计息天数的加权平均年化 */
  annualizedRate: number;
  /** 数据不完整（缺息或缺天数）的票据编号，提示需补录 */
  incompleteCodes: string[];
}

/**
 * 贴现成本分析。
 *
 * 年化口径：`Σ(息 / 票面 × 360 / 天数 × 票面) / Σ票面`
 * 化简后 = `Σ(息 × 360 / 天数) / Σ票面 × 100`。
 * 天数缺失或为 0 的票**不参与年化**（否则会除零或产生无穷大），
 * 但计入金额与息的合计，并在 `incompleteCodes` 里列出。
 */
export function analyzeDiscountCost(
  rows: DiscountedNoteRow[]
): DiscountCostResult {
  const valid = rows.filter((row) => toNumber(row.amount) > 0);
  const amount = round2(valid.reduce((sum, row) => sum + toNumber(row.amount), 0));
  const interest = round2(
    valid.reduce((sum, row) => sum + toNumber(row.discountInterest), 0)
  );
  const netProceeds = round2(amount - interest);
  const weightedRate =
    amount === 0 ? 0 : round2((interest / amount) * 100);

  const byTypeMap = new Map<
    string,
    { count: number; amount: number; interest: number }
  >();
  for (const row of valid) {
    const key = row.noteType || 'unknown';
    const entry = byTypeMap.get(key) ?? { count: 0, amount: 0, interest: 0 };
    entry.count += 1;
    entry.amount = round2(entry.amount + toNumber(row.amount));
    entry.interest = round2(entry.interest + toNumber(row.discountInterest));
    byTypeMap.set(key, entry);
  }

  const incompleteCodes: string[] = [];
  let annualizedNumerator = 0;
  let annualizedDenominator = 0;
  for (const row of valid) {
    const days = row.days === null ? null : toNumber(row.days);
    if (
      row.discountInterest === null ||
      days === null ||
      days <= 0
    ) {
      incompleteCodes.push(row.code);
      continue;
    }
    // 息 × 360 / 天数 = 按该票规模与天数折算的年化息额
    annualizedNumerator += (toNumber(row.discountInterest) * 360) / days;
    annualizedDenominator += toNumber(row.amount);
  }
  const annualizedRate =
    annualizedDenominator === 0
      ? 0
      : round2((annualizedNumerator / annualizedDenominator) * 100);

  return {
    count: valid.length,
    amount,
    interest,
    netProceeds,
    weightedRate,
    byType: [...byTypeMap.entries()]
      .map(([noteType, entry]) => ({
        noteType,
        count: entry.count,
        amount: entry.amount,
        interest: entry.interest,
        weightedRate:
          entry.amount === 0 ? 0 : round2((entry.interest / entry.amount) * 100),
      }))
      .sort((a, b) => b.amount - a.amount),
    annualizedRate,
    incompleteCodes,
  };
}

/* ==================== ④ 备查簿汇总 ==================== */

export interface NoteRegisterInput {
  id: string;
  code: string;
  noteNo: string;
  noteType: string;
  status: string;
  amount: number;
  drawer: string | null;
  dueDate: string;
  daysLeft: number;
  discountInterest: number | null;
  discountRate: number | null;
  /**
   * 贴现**计息天数**（贴现日 → 到期日，算头不算尾）。
   *
   * 为什么需要单独一个字段而不是从 `daysLeft` 推算：`daysLeft` 是"距今天数"，
   * 随查询时间变化；贴现天数在贴现那一刻就固定了。拿 `daysLeft` 当贴现天数
   * 会算出一个"每天看起来都不一样"的年化率 —— 这种数字比没有更糟。
   * 由调用方从 `settled_date` 与 `due_date` 反推或直接读库列。
   */
  discountDays: number | null;
}

export interface NoteRegisterDeepResult {
  generatedAt: string;
  total: { count: number; amount: number };
  byStatus: Array<{
    status: NoteStatus | string;
    label: string;
    count: number;
    amount: number;
  }>;
  dueStructure: NoteDueStructureResult;
  numbering: NoteNoCheckResult;
  discountCost: DiscountCostResult;
  /** 需要关注的票据（逾期 + 临期），按紧迫度排序 */
  attention: Array<{
    code: string;
    noteNo: string;
    amount: number;
    dueDate: string;
    daysLeft: number;
    status: string;
  }>;
}

/**
 * 备查簿汇总（D-02）。
 *
 * 把"连续性 / 到期结构 / 贴现成本 / 需关注清单"四块拼成一份可直接打印给
 * 税务或审计的备查簿摘要。四块都来自同一份数据，避免各页面口径不一致。
 */
export function buildNoteRegister(
  rows: NoteRegisterInput[],
  today: string
): NoteRegisterDeepResult {
  void today;
  const totalAmount = round2(rows.reduce((sum, row) => sum + toNumber(row.amount), 0));

  const statusOrder: NoteStatus[] = [
    'received',
    'held',
    'endorsed',
    'discounted',
    'settled',
    'dishonored',
  ];
  const byStatus = statusOrder.map((status) => {
    const matched = rows.filter((row) => row.status === status);
    return {
      status,
      label: NOTE_STATUS_LABELS[status],
      count: matched.length,
      amount: round2(matched.reduce((sum, row) => sum + toNumber(row.amount), 0)),
    };
  });

  const discounted = rows.filter((row) => row.status === 'discounted');
  const attention = rows
    .filter(
      (row) =>
        row.status !== 'settled' &&
        row.status !== 'dishonored' &&
        row.daysLeft <= 15
    )
    .map((row) => ({
      code: row.code,
      noteNo: row.noteNo,
      amount: round2(toNumber(row.amount)),
      dueDate: row.dueDate,
      daysLeft: row.daysLeft,
      status: row.status,
    }))
    .sort((a, b) => a.daysLeft - b.daysLeft);

  return {
    generatedAt: new Date().toISOString(),
    total: { count: rows.length, amount: totalAmount },
    byStatus,
    dueStructure: buildDueStructure(
      rows.map((row) => ({
        status: row.status,
        amount: toNumber(row.amount),
        daysLeft: row.daysLeft,
      }))
    ),
    numbering: checkNoteNumbering(
      rows.map((row) => ({
        code: row.code,
        noteNo: row.noteNo,
        noteType: row.noteType,
        status: row.status,
        amount: toNumber(row.amount),
      }))
    ),
    discountCost: analyzeDiscountCost(
      discounted.map((row) => ({
        code: row.code,
        noteNo: row.noteNo,
        noteType: row.noteType,
        amount: toNumber(row.amount),
        discountInterest:
          row.discountInterest === null ? null : toNumber(row.discountInterest),
        discountRate: row.discountRate === null ? null : toNumber(row.discountRate),
        days: row.discountDays,
      }))
    ),
    attention,
  };
}
