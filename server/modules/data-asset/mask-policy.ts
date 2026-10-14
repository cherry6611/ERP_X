/**
 * C-13：数据资产脱敏等级与授权回收审计。
 *
 * ## 为什么要单独抽一层纯函数
 *
 * `da_dataset.mask_level` 在既有实现里只是一个**自由字符串**（前端下拉可填任意值），
 * 没有任何地方真正按它脱敏。这带来两个真实风险：
 * 1. 业务方以为"设了脱敏等级就安全了"，实际导出的仍是明文；
 * 2. 等级口径不统一（`L2` / `level2` / `中` 混用），无法审计。
 *
 * 因此这里把等级做成**封闭枚举 + 明确的字段级规则**，并让脱敏成为可单测的纯函数：
 * 规则错了测试会失败，而不是等到数据泄露才发现。
 *
 * ## 等级口径（需合规确认）
 *
 * | 等级 | 名称 | 典型内容 | 处理方式 |
 * |---|---|---|---|
 * | L1 | 公开 | 已脱敏的统计结果、公开数据集 | 原样交付 |
 * | L2 | 内部 | 含联系方式、单位名称 | 手机/邮箱/身份证/银行账号掩码 |
 * | L3 | 敏感 | 含个人标识、金额明细 | L2 + 姓名/地址掩码，金额按区间化 |
 * | L4 | 核心 | 含身份证号、完整银行账号、精确定位 | L3 + 全部标识字段不可导出，仅可现场查看 |
 *
 * 「不可导出」表达为 `MASK_BLOCKED`：调用方**不得**把该字段写入导出文件，
 * 而不是写入后再遮掩 —— 后者仍有中间明文落盘的风险。
 */

/** 封闭的脱敏等级 */
export const MASK_LEVELS = ['L1', 'L2', 'L3', 'L4'] as const;
export type MaskLevel = (typeof MASK_LEVELS)[number];

export const MASK_LEVEL_LABELS: Record<MaskLevel, string> = {
  L1: 'L1 公开',
  L2: 'L2 内部',
  L3: 'L3 敏感',
  L4: 'L4 核心',
};

/** 等级说明，用于前端下拉与审计报告 */
export const MASK_LEVEL_DESCRIPTIONS: Record<MaskLevel, string> = {
  L1: '不含个人或商业敏感信息（统计结果、公开数据），可原样交付',
  L2: '含联系方式与单位名称（手机、邮箱、单位），需掩码后交付',
  L3: '含个人标识与金额明细，姓名/地址掩码、金额区间化后交付',
  L4: '含身份证号/完整银行账号/精确定位，标识字段禁止导出，仅可现场查看',
};

/** 等级排序（用于"只能收紧不能放松"的比较） */
export function maskLevelRank(level: string): number {
  const index = MASK_LEVELS.indexOf(level as MaskLevel);
  return index < 0 ? 0 : index + 1;
}

/** 是否为已登记的合法等级 */
export function isMaskLevel(value: unknown): value is MaskLevel {
  return typeof value === 'string' && (MASK_LEVELS as readonly string[]).includes(value);
}

/** 归一化：把历史自由字符串收敛到封闭枚举（未知值按最保守的 L4 处理） */
export function normalizeMaskLevel(value: string | null | undefined): MaskLevel {
  if (isMaskLevel(value)) return value;
  if (!value) return 'L4';
  const upper = value.trim().toUpperCase();
  if (isMaskLevel(upper)) return upper;
  // 兼容 "level2" / "lv2" / "2" 之类写法
  const digits = upper.match(/(\d)/);
  if (digits) {
    const candidate = `L${digits[1]}`;
    if (isMaskLevel(candidate)) return candidate;
  }
  // 未知值 → 最严格，避免"填了个看不懂的值就等于不脱敏"
  return 'L4';
}

/** 字段语义分类：决定该字段在各等级下如何处理 */
export const SENSITIVE_FIELD_KINDS = [
  'name',
  'phone',
  'email',
  'id_card',
  'bank_account',
  'address',
  'amount',
  'location',
  'other',
] as const;
export type SensitiveFieldKind = (typeof SENSITIVE_FIELD_KINDS)[number];

/** 禁止导出的标记：调用方必须跳过该字段，而不是写空串 */
export const MASK_BLOCKED = Symbol('MASK_BLOCKED');

export type MaskResult = string | typeof MASK_BLOCKED;

/**
 * 字段级脱敏规则。
 *
 * 返回 `MASK_BLOCKED` 表示**该等级下此字段不允许出现在导出物中**。
 * 所有掩码都保留首尾若干字符以便业务核对（例如手机保留前 3 后 4），
 * 但绝不可逆推完整值。
 */
export function maskFieldValue(
  kind: SensitiveFieldKind,
  value: string | null | undefined,
  level: MaskLevel
): MaskResult {
  if (value === null || value === undefined || value === '') return '';
  const text = String(value);

  // L1：原样
  if (level === 'L1') return text;

  switch (kind) {
    case 'name':
      // L2 不处理姓名（内部使用需要区分同名），L3/L4 掩码
      if (level === 'L2') return text;
      return maskKeepEdges(text, 1, 0);

    case 'phone':
      return maskKeepEdges(text, 3, 4);

    case 'email': {
      const at = text.indexOf('@');
      if (at <= 0) return maskKeepEdges(text, 1, 0);
      const local = text.slice(0, at);
      const domain = text.slice(at);
      return `${maskKeepEdges(local, 1, 0)}${domain}`;
    }

    case 'id_card':
      // L4 下身份证号禁止导出（可逆风险最高）
      if (level === 'L4') return MASK_BLOCKED;
      return maskKeepEdges(text, 4, 3);

    case 'bank_account':
      if (level === 'L4') return MASK_BLOCKED;
      return maskKeepEdges(text, 4, 4);

    case 'address':
      if (level === 'L2') return text;
      // 只保留到区/县一级（前 6 个字符通常是"省市区"）
      return text.length <= 6 ? maskKeepEdges(text, 2, 0) : `${text.slice(0, 6)}***`;

    case 'location':
      if (level === 'L4') return MASK_BLOCKED;
      // 精确定位降级为"城市级"：只保留前两段
      return text.split(/[,，]/).slice(0, 2).join(',');

    case 'amount': {
      // L3/L4 金额区间化：避免通过金额反推具体客户/合同
      if (level === 'L2') return text;
      const num = Number(text.replace(/[,\s¥￥]/g, ''));
      if (!Number.isFinite(num)) return '***';
      const bucket = amountBucket(num);
      return bucket;
    }

    case 'other':
    default:
      return level === 'L4' ? maskKeepEdges(text, 0, 0) : text;
  }
}

/** 保留首 head 个与末 tail 个字符，中间替换为 *（长度不足则整体掩码） */
export function maskKeepEdges(text: string, head: number, tail: number): string {
  if (head + tail >= text.length) return '*'.repeat(Math.max(text.length, 3));
  const middle = text.length - head - tail;
  return `${text.slice(0, head)}${'*'.repeat(middle)}${tail > 0 ? text.slice(-tail) : ''}`;
}

/**
 * 金额区间化（量级分档）。
 * 分档边界取业务上常见的量级，避免"1234.56"这种可回溯的精确值。
 */
export function amountBucket(value: number): string {
  const abs = Math.abs(value);
  if (abs === 0) return '0';
  if (abs < 1_000) return '<1千';
  if (abs < 10_000) return '1千~1万';
  if (abs < 100_000) return '1万~10万';
  if (abs < 1_000_000) return '10万~100万';
  if (abs < 10_000_000) return '100万~1000万';
  return '≥1000万';
}

/**
 * 按行脱敏整张表。
 *
 * @param rows 原始行
 * @param fieldKinds 列名 → 字段语义；**未登记的列按 `other` 处理**，
 *                   L4 下会被整体掩码（保守优先，避免新增列悄悄绕过脱敏）
 * @returns 脱敏后的行，以及被禁止导出的列名清单（供审计留痕）
 */
export function maskRows(
  rows: Array<Record<string, unknown>>,
  fieldKinds: Record<string, SensitiveFieldKind>,
  level: MaskLevel
): { rows: Array<Record<string, unknown>>; blockedColumns: string[] } {
  const blocked = new Set<string>();
  const masked = rows.map((row) => {
    const next: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(row)) {
      const kind = fieldKinds[key] ?? 'other';
      // 非字符串字段（数字/布尔/日期/对象）不做文本掩码，
      // 但 L4 下未登记的列一并阻断，防止 JSON 字段夹带敏感内容
      if (typeof raw !== 'string') {
        if (level === 'L4' && !(key in fieldKinds)) {
          blocked.add(key);
          continue;
        }
        if (kind === 'amount' && typeof raw === 'number' && level !== 'L1' && level !== 'L2') {
          next[key] = amountBucket(raw);
          continue;
        }
        next[key] = raw;
        continue;
      }
      const result = maskFieldValue(kind, raw, level);
      if (result === MASK_BLOCKED) {
        blocked.add(key);
        continue;
      }
      next[key] = result;
    }
    return next;
  });
  return { rows: masked, blockedColumns: [...blocked].sort() };
}

/* ========== 授权回收审计 ========== */

/** 回收原因分类（封闭枚举，便于统计"为什么被回收"） */
export const GRANT_REVOKE_REASONS = [
  'expired', // 到期自动回收
  'manual', // 人工主动回收
  'contract_terminated', // 合同终止
  'violation', // 违规使用
  'project_closed', // 项目结项
] as const;
export type GrantRevokeReason = (typeof GRANT_REVOKE_REASONS)[number];

export const GRANT_REVOKE_REASON_LABELS: Record<GrantRevokeReason, string> = {
  expired: '到期自动回收',
  manual: '人工主动回收',
  contract_terminated: '合同终止',
  violation: '违规使用',
  project_closed: '项目结项',
};

/**
 * L4 核心数据的授权回收需要**双人确认 + 销毁副本**。
 *
 * 这条规则的意义：核心数据的授权一旦放开，接收方可能已经落盘。
 * 单纯改数据库状态不等于风险解除，因此要求：
 * ① 记录销毁凭证（`destructionProof`）；② 由他人复核（`reviewedBy ≠ operator`）。
 */
export function requiresDestructionProof(level: MaskLevel): boolean {
  return level === 'L4';
}

export interface RevokeGuardInput {
  /** 数据集脱敏等级（未登记时传原始字符串，内部会归一化） */
  maskLevel: string | null | undefined;
  reason: GrantRevokeReason;
  operator: string;
  /** 复核人；L4 必填且必须与操作人不同 */
  reviewedBy?: string | null;
  /** 销毁凭证（L4 必填），例如对方出具的删除确认函编号 */
  destructionProof?: string | null;
}

/**
 * 校验回收动作是否满足审计要求。
 * 返回错误消息数组；为空表示通过。
 *
 * 之所以做成纯函数：这类合规校验最容易在重构中悄悄失效，
 * 抽成纯函数后可以用单测逐条钉住。
 */
export function validateRevoke(input: RevokeGuardInput): string[] {
  const errors: string[] = [];
  const level = normalizeMaskLevel(input.maskLevel);

  if (input.reason === 'violation' && !input.destructionProof) {
    errors.push('违规回收必须登记销毁凭证（说明已要求接收方删除副本）');
  }

  if (requiresDestructionProof(level)) {
    if (!input.reviewedBy) {
      errors.push(`${MASK_LEVEL_LABELS[level]} 数据回收必须由他人复核（reviewedBy 不能为空）`);
    } else if (input.reviewedBy === input.operator) {
      errors.push('复核人不能与操作人相同（双人确认要求）');
    }
    if (!input.destructionProof) {
      errors.push(`${MASK_LEVEL_LABELS[level]} 数据回收必须登记销毁凭证（destructionProof）`);
    }
  }

  return errors;
}
