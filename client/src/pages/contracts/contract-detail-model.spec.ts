import {
  CALLOFF_FORM_DEFAULTS,
  CHANGE_FORM_DEFAULTS,
  EMPTY_ITEM_DRAFT,
  MILESTONE_FORM_DEFAULTS,
  MILESTONE_STATUS_LABELS,
  STATUS_ACTIONS,
  buildCalloffPayload,
  buildChangePayload,
  buildMilestonePayload,
  calloffColumns,
  calloffSchema,
  changeSchema,
  createItemDraft,
  itemRateOptions,
  milestoneSchema,
  pickTaxEntity,
  resolveItemTaxRate,
  statusActionsFor,
} from './contract-detail-model';
import { coerceTaxRate, defaultTaxRate } from '@client/src/utils/tax-rate-options';
import { formatMoney } from '@client/src/utils/format';
import { VAT_RATES } from '@shared/tax';
import type {
  Calloff,
  ContractStatus,
  ContractStatusAction,
  MilestoneStatus,
  TaxEntity,
} from '@shared/api.interface';

/**
 * 合同详情弹窗纯逻辑规格（§5.9 / F8）。
 *
 * ## 为什么这些断言值得存在
 *
 * 本文件钉住的都是**改坏了也照样能跑、界面上还看不出来**的地方：
 *
 * · **Call-off 列定义**：「金额」列取到 `seq`、「下单日期」取到 `remark` 这类
 *   串位不会报错，页面上也只是"数字看起来不太对"（框架单里序号 7 与 ¥7.00
 *   同时成立），所以这里按列头逐列断言取值，并额外钉住 `dataIndex` 序列。
 * · **状态机按钮表**：漏一个 action 的后果是按钮**静默消失**（用户点不了却查不出
 *   原因）；多一个（例如给终态 `closed` 配上 `approve`）则放行了非法流转。
 * · **三个 schema 的门槛**：金额 0 / 0.99 / 1 的区别、「空串被 coerce 成 0」
 *   这类行为改错一位就是放进脏数据或让合法单据提交不进来。
 * · **明细默认税率**：本轮的修复点 —— 保证"下拉里一定选得中、提交的一定是合法
 *   数字"，见下面 `resolveItemTaxRate` 一节。
 *
 * 断言全部针对**行为**（取值、门槛、返回值），不针对实现写法。
 */

/* ── 测试夹具 ────────────────────────────────────────────────────────────── */

/**
 * 完整构造 `Calloff`（**不用** `as unknown as` 跳过检查）：所有字段互不相同，
 * 任何一列取错字段都会让断言失败。
 */
function calloff(overrides: Partial<Calloff> = {}): Calloff {
  return {
    id: 'co1',
    code: 'CO-2026-0007',
    contractId: 'ct1',
    seq: 7,
    projectId: 'pj1',
    projectName: '项目甲',
    amount: 111.11,
    quantity: 1,
    unitPrice: 111.11,
    orderDate: '2026-10-16',
    remark: '备注甲',
    ...overrides,
  };
}

/** 完整构造 `TaxEntity`（`taxpayerType` 决定可选档位，是本组用力的地方） */
function entity(overrides: Partial<TaxEntity> = {}): TaxEntity {
  return {
    id: 'te-general',
    code: 'TE-001',
    name: '主体甲',
    uscc: '91310000MA1K3QXX0A',
    taxpayerType: 'general',
    defaultOutputRate: 6,
    defaultInputRate: 6,
    invoiceTitle: '主体甲',
    invoiceAddress: null,
    invoicePhone: null,
    invoiceBank: null,
    invoiceAccount: null,
    isDefault: true,
    status: 'active',
    remark: null,
    ...overrides,
  };
}

/** 一般纳税人主体（`ALLOWED_RATES.general = [0,5,6,9,13]`，**不含 1/3**） */
const GENERAL = entity();
/** 小规模主体（`ALLOWED_RATES.small = [0,1,3,5]`，**不含 6**） */
const SMALL = entity({
  id: 'te-small',
  code: 'TE-002',
  name: '主体乙',
  taxpayerType: 'small',
  defaultOutputRate: 3,
  defaultInputRate: 3,
  isDefault: false,
});

/* ── Call-off 列定义 ─────────────────────────────────────────────────────── */

/** 只取出断言需要的部分：`title` / `dataIndex` / `render` */
type ColumnProbe = {
  title?: unknown;
  dataIndex?: unknown;
  render?: (value: unknown, record: Calloff) => unknown;
};

const columns = calloffColumns as unknown as ColumnProbe[];

const headers = (): string[] => columns.map((c) => String(c.title));
const dataIndexes = (): string[] => columns.map((c) => String(c.dataIndex));

/**
 * 按列头取值：模拟 antd 的 render 调用（`render(value, record, index)`），
 * 没有 `render` 的列直接取 `dataIndex` 对应的原始值。
 */
const valueOf = (row: Calloff, title: string): string => {
  const col = columns.find((c) => String(c.title) === title);
  if (!col) throw new Error(`列「${title}」不存在`);
  const key = String(col.dataIndex);
  const raw = (row as unknown as Record<string, unknown>)[key];
  const out = col.render ? col.render(raw, row) : raw;
  return out === null || out === undefined ? '' : String(out);
};

const rowValues = (row: Calloff): string[] =>
  headers().map((title) => valueOf(row, title));

describe('Call-off 表格列定义（calloffColumns）', () => {
  it('列头与列序固定（列序错 = 整张表错位）', () => {
    expect(headers()).toEqual([
      '下单编号',
      '序号',
      '关联项目',
      '金额',
      '下单日期',
      '备注',
    ]);
  });

  it('每列绑定到不同的字段（同一字段被读两次 = 有一列永远是空的/重复的）', () => {
    expect(dataIndexes()).toEqual([
      'code',
      'seq',
      'projectName',
      'amount',
      'orderDate',
      'remark',
    ]);
    // 反例防线：六个 dataIndex 互不相同
    expect(new Set(dataIndexes()).size).toBe(6);
  });

  it('每列取到对应字段（金额不会被渲染成序号，日期不会取到备注）', () => {
    const row = calloff();
    expect(valueOf(row, '下单编号')).toBe('CO-2026-0007');
    expect(valueOf(row, '序号')).toBe('7');
    expect(valueOf(row, '关联项目')).toBe('项目甲');
    expect(valueOf(row, '金额')).toBe(formatMoney(111.11));
    expect(valueOf(row, '下单日期')).toBe('2026-10-16');
    expect(valueOf(row, '备注')).toBe('备注甲');
    /*
     * 整行一次断言：六个取值**互不相同**，任何"两列取到同一字段"的改动
     * （例如金额列误用 `seq`）都会让这一行失败。
     */
    expect(rowValues(row)).toEqual([
      'CO-2026-0007',
      '7',
      '项目甲',
      '¥111.11',
      '2026-10-16',
      '备注甲',
    ]);
    expect(new Set(rowValues(row)).size).toBe(6);
  });

  it('金额列走 formatMoney（不是裸数字）：千分位与两位小数是导出/打印的前提', () => {
    const row = calloff({ amount: 1234.5 });
    expect(valueOf(row, '金额')).toBe(formatMoney(1234.5));
    expect(valueOf(row, '金额')).toContain('1,234.50');
    // 反例防线：若金额列退化成裸值，这里会是 '1234.5'
    expect(valueOf(row, '金额')).not.toBe('1234.5');
  });

  it('可空字段 null → "-"（不是 "null" 字符串，也不是空白格）', () => {
    const row = calloff({
      projectName: null,
      orderDate: null,
      remark: null,
    });
    expect(valueOf(row, '关联项目')).toBe('-');
    expect(valueOf(row, '下单日期')).toBe('-');
    expect(valueOf(row, '备注')).toBe('-');
    expect(valueOf(row, '备注')).not.toBe('null');
    // 同一行的非空字段不受影响 —— 反例防线：整列被写成常量 '-'
    expect(valueOf(row, '下单编号')).toBe('CO-2026-0007');
  });

  it('金额列**不**做 null → "-" 的回退，而是 0.00（`Calloff.amount` 非空且 ≥0.01）', () => {
    /*
     * 登记这处不对称：文本列用 `v ?? '-'`，金额列用 `formatMoney(v)` ——
     * 后者对 `null` 会给出 `¥0.00`。契约（`shared/api.interface.ts` 的
     * `Calloff.amount: number`）与服务端 DTO（`@Min(0.01)`）都保证金额非空，
     * 因此这不是漏写；若有人"统一"成 `v ?? '-'`，这条会失败并强制一次有意识的决定。
     */
    const row = calloff({ amount: null as unknown as number });
    expect(valueOf(row, '金额')).toBe(formatMoney(0));
    expect(valueOf(row, '金额')).not.toBe('-');
  });
});

/* ── 里程碑状态文案 ──────────────────────────────────────────────────────── */

describe('里程碑状态文案（MILESTONE_STATUS_LABELS）', () => {
  const ALL_MILESTONE_STATUSES: Record<MilestoneStatus, true> = {
    pending: true,
    reached: true,
  };

  it('覆盖契约全部里程碑状态，且文案不重复、不为空', () => {
    expect(Object.keys(MILESTONE_STATUS_LABELS).sort()).toEqual(
      Object.keys(ALL_MILESTONE_STATUSES).sort(),
    );
    expect(MILESTONE_STATUS_LABELS.pending).toBe('未达成');
    expect(MILESTONE_STATUS_LABELS.reached).toBe('已达成');
    // 两个状态文案若被写成同一个，表格里就分不清"未达成"与"已达成"
    expect(MILESTONE_STATUS_LABELS.pending).not.toBe(
      MILESTONE_STATUS_LABELS.reached,
    );
    for (const status of Object.keys(ALL_MILESTONE_STATUSES)) {
      expect(MILESTONE_STATUS_LABELS[status]).toBeTruthy();
    }
  });

  it('字典外取值查不到（StatusBadge 据此回退成原样显示 key，而不是空白）', () => {
    /*
     * 组件用法是 `<StatusBadge status={s} labels={MILESTONE_STATUS_LABELS} />`，
     * 而 StatusBadge 内部是 `labels[status] ?? status`。这里钉住"未知键返回
     * undefined"这个前提：若有人给 Record 换成带兜底的 Proxy/函数，
     * 历史脏数据的状态列会整列显示成同一个兜底文案。
     */
    expect(MILESTONE_STATUS_LABELS.weird).toBeUndefined();
    expect(MILESTONE_STATUS_LABELS['']).toBeUndefined();
  });
});

/* ── 状态机按钮表 ────────────────────────────────────────────────────────── */

describe('合同状态机按钮（STATUS_ACTIONS / statusActionsFor）', () => {
  const ALL_STATUSES: Record<ContractStatus, true> = {
    draft: true,
    approving: true,
    active: true,
    performing: true,
    completed: true,
    closed: true,
    terminated: true,
  };

  // 漏一个成员这里编译就报错 —— "动作码是否都在契约联合类型内"是编译期保证
  const ALL_ACTIONS: Record<ContractStatusAction, true> = {
    submit: true,
    approve: true,
    reject: true,
    start: true,
    complete: true,
    close: true,
    terminate: true,
  };

  it('每个非终态的动作与文案逐字固定（顺序 = 按钮顺序）', () => {
    expect(STATUS_ACTIONS.draft).toEqual([
      { action: 'submit', label: '提交审批' },
    ]);
    expect(STATUS_ACTIONS.approving).toEqual([
      { action: 'approve', label: '审批通过' },
      { action: 'reject', label: '驳回' },
    ]);
    expect(STATUS_ACTIONS.active).toEqual([
      { action: 'start', label: '开始履约' },
      { action: 'terminate', label: '终止合同' },
    ]);
    expect(STATUS_ACTIONS.performing).toEqual([
      { action: 'complete', label: '履约完成' },
      { action: 'terminate', label: '终止合同' },
    ]);
    expect(STATUS_ACTIONS.completed).toEqual([
      { action: 'close', label: '关闭合同' },
    ]);
  });

  it('只登记 5 个非终态；closed / terminated 没有后续动作', () => {
    /*
     * 终态缺席是**有意**的（Partial 映射）：给已关闭/已终止的合同配上按钮，
     * 等于在后端状态机之外放行非法流转。这条同时挡住"顺手补全 7 个键"的改动。
     */
    expect(Object.keys(STATUS_ACTIONS).sort()).toEqual([
      'active',
      'approving',
      'completed',
      'draft',
      'performing',
    ]);
    expect(statusActionsFor('closed')).toEqual([]);
    expect(statusActionsFor('terminated')).toEqual([]);
  });

  it('动作码全部落在 ContractStatusAction 内，文案都是非空中文', () => {
    for (const status of Object.keys(ALL_STATUSES)) {
      for (const item of statusActionsFor(status)) {
        expect(ALL_ACTIONS[item.action]).toBe(true);
        expect(item.label).toMatch(/[\u4e00-\u9fa5]/u);
      }
    }
  });

  it('「驳回」只出现在 approving（组件按 `action === "reject"` 渲染红色按钮）', () => {
    const statusesWithReject = Object.keys(ALL_STATUSES).filter((status) =>
      statusActionsFor(status).some((item) => item.action === 'reject'),
    );
    expect(statusesWithReject).toEqual(['approving']);
  });

  it('「终止合同」在 active 与 performing 两个状态都可点（同一个动作、两条入口）', () => {
    /*
     * 登记现状：`terminate` 在两个状态下文案相同。若有人把这两处"去重"成
     * 单一状态，正在履约的合同就没法终止了 —— 这条会失败。
     */
    const terminateStatuses = Object.keys(ALL_STATUSES).filter((status) =>
      statusActionsFor(status).some((item) => item.action === 'terminate'),
    );
    expect(terminateStatuses).toEqual(['active', 'performing']);
  });

  it('详情未加载（undefined）与未知状态都返回空数组（不是 undefined）', () => {
    expect(statusActionsFor(undefined)).toEqual([]);
    expect(statusActionsFor('weird')).toEqual([]);
    // 反例防线：返回 undefined 会让 `actions.map(...)` 直接抛错
    expect(statusActionsFor('weird')).not.toBeUndefined();
  });
});

/* ── 里程碑表单 schema ───────────────────────────────────────────────────── */

describe('里程碑表单 schema（milestoneSchema）', () => {
  const base = { name: '首付款', amount: 100, dueCondition: '合同签订' };

  it('名称必填，文案固定', () => {
    const parsed = milestoneSchema.safeParse({ ...base, name: '' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(['name']);
      expect(parsed.error.issues[0]?.message).toBe('里程碑名称不能为空');
    }
    expect(milestoneSchema.safeParse(base).success).toBe(true);
  });

  it('名称只校验"长度 ≥ 1"，**不 trim**：单个空格能过（服务端 @IsNotEmpty 同样放行）', () => {
    /*
     * 登记现状而不是认可它：客户端 `z.string().min(1)` 与服务端
     * `CreateMilestoneDto.name`（`@IsNotEmpty()`，`contracts.dto.ts:45-47`）
     * 都不去空白，两侧**一致** —— 所以这不是"前端放行、后端 400"的缺陷，
     * 只是一条可以被填入空格名称的路径。若将来任一侧加了 trim，这条会失败。
     */
    expect(milestoneSchema.safeParse({ ...base, name: ' ' }).success).toBe(true);
  });

  it('金额门槛是 0：负数拒绝、0 与 0.01 都接受（与服务端 @Min(0) 一致）', () => {
    expect(milestoneSchema.safeParse({ ...base, amount: -0.01 }).success).toBe(
      false,
    );
    expect(milestoneSchema.safeParse({ ...base, amount: 0 }).success).toBe(true);
    expect(milestoneSchema.safeParse({ ...base, amount: 0.01 }).success).toBe(
      true,
    );
  });

  it('金额是 coerce：字符串 "100.5" 通过并变成数字，空串变成 0 且仍然合法', () => {
    const parsed = milestoneSchema.safeParse({ ...base, amount: '100.5' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.amount).toBe(100.5);
    /*
     * 输入框被清空时受控值是 `''` → `Number('') === 0` → 门槛 `min(0)` 放行，
     * 于是"没填金额"落库成 0 元里程碑。这不是本轮引入的（原实现即
     * `z.coerce.number().min(0)`），且服务端 `@Min(0)` 一致，故登记不改。
     */
    const empty = milestoneSchema.safeParse({ ...base, amount: '' });
    expect(empty.success).toBe(true);
    if (empty.success) expect(empty.data.amount).toBe(0);
  });

  it('dueCondition 必须**存在**（可为空串），dueDate 可以缺失 —— 两者有意不同', () => {
    expect(
      milestoneSchema.safeParse({ ...base, dueCondition: '' }).success,
    ).toBe(true);
    const missingCondition = milestoneSchema.safeParse({
      name: '首付款',
      amount: 100,
    });
    expect(missingCondition.success).toBe(false);
    if (!missingCondition.success) {
      expect(missingCondition.error.issues[0]?.path).toEqual(['dueCondition']);
    }
    // dueDate 是可选的，且**不做格式校验**（弹窗里没有日期输入，写入方只有 API）
    expect(milestoneSchema.safeParse(base).success).toBe(true);
    expect(
      milestoneSchema.safeParse({ ...base, dueDate: '2026-10-16' }).success,
    ).toBe(true);
    expect(milestoneSchema.safeParse({ ...base, dueDate: 'x' }).success).toBe(
      true,
    );
  });

  it('默认表单不可提交（名称必填）', () => {
    const parsed = milestoneSchema.safeParse(MILESTONE_FORM_DEFAULTS);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.path.join('.'))).toContain('name');
    }
  });
});

/* ── 下单表单 schema ─────────────────────────────────────────────────────── */

describe('框架下单表单 schema（calloffSchema）', () => {
  const base = { amount: 1000, remark: '第一批' };

  it('金额门槛是 1：0.99 拒绝、1 接受（边界两侧都钉住）', () => {
    expect(calloffSchema.safeParse({ ...base, amount: 0.99 }).success).toBe(
      false,
    );
    expect(calloffSchema.safeParse({ ...base, amount: 1 }).success).toBe(true);
    expect(calloffSchema.safeParse({ ...base, amount: 1.01 }).success).toBe(
      true,
    );
    expect(calloffSchema.safeParse({ ...base, amount: 0 }).success).toBe(false);
    const parsed = calloffSchema.safeParse({ ...base, amount: 0 });
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe('下单金额必须大于 0');
    }
  });

  it('客户端门槛是 1，**不是**服务端的 0.01 —— 有意更严（登记，不改）', () => {
    /*
     * 服务端 `CreateCalloffDto.amount` 是
     * `@Min(0.01, { message: '叫料金额必须大于 0' })`
     * （`server/modules/contracts/contracts.dto.ts:104-106`）。
     * 客户端门槛（1）比它**严 100 倍**，方向是安全的 —— 不可能出现
     * "前端放行、后端 400"；代价是 0.5 元的下单在前端就被拦下，
     * 而文案写的是"必须大于 0"。
     * 若有人把这里对齐成 `min(0.01)`（或把服务端放宽），下面 0.01 / 0.5
     * 两条会失败，从而强制一次有意识的决定 —— 本次拆分**不改**这个门槛。
     */
    for (const tiny of [0.01, 0.5, 0.99]) {
      expect(calloffSchema.safeParse({ ...base, amount: tiny }).success).toBe(
        false,
      );
    }
    expect(calloffSchema.safeParse({ ...base, amount: 1 }).success).toBe(true);
    expect(calloffSchema.safeParse({ ...base, amount: 1.5 }).success).toBe(
      true,
    );
  });

  it('金额空串被 coerce 成 0 → 被门槛拦下（不是静默提交 0 元下单）', () => {
    const parsed = calloffSchema.safeParse({ ...base, amount: '' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(['amount']);
    }
  });

  it('备注可为空串但字段必须存在', () => {
    expect(calloffSchema.safeParse({ ...base, remark: '' }).success).toBe(true);
    expect(
      calloffSchema.safeParse({ amount: 1000 }).success,
    ).toBe(false);
  });

  it('默认表单不可提交（金额 0 未达门槛）', () => {
    const parsed = calloffSchema.safeParse(CALLOFF_FORM_DEFAULTS);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.path.join('.'))).toContain(
        'amount',
      );
    }
  });
});

/* ── 变更表单 schema ─────────────────────────────────────────────────────── */

describe('合同变更表单 schema（changeSchema）', () => {
  const base = { changeLog: '增补一期实施', newAmount: 5000 };

  it('变更说明必填（空串与缺失都被拦），文案固定', () => {
    const parsed = changeSchema.safeParse({ ...base, changeLog: '' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.path).toEqual(['changeLog']);
      expect(parsed.error.issues[0]?.message).toBe('请填写变更说明');
    }
    // 与服务端 `@IsNotEmpty()` 一致：单个空格同样放行（登记，不改）
    expect(changeSchema.safeParse({ ...base, changeLog: ' ' }).success).toBe(
      true,
    );
  });

  it('变更后金额门槛是 0：接受 0、拒绝 -0.01（0 = 金额不变，见 buildChangePayload）', () => {
    expect(changeSchema.safeParse({ ...base, newAmount: 0 }).success).toBe(true);
    expect(changeSchema.safeParse({ ...base, newAmount: -0.01 }).success).toBe(
      false,
    );
  });

  it('默认表单不可提交（变更说明为空）', () => {
    const parsed = changeSchema.safeParse(CHANGE_FORM_DEFAULTS);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.path.join('.'))).toContain(
        'changeLog',
      );
    }
  });
});

/* ── 默认值常量 ──────────────────────────────────────────────────────────── */

describe('表单默认值（原先在 defaultValues 与 reset 各写一遍）', () => {
  it('三张表单的默认值逐字固定（初始值与提交后重置值必须同源）', () => {
    expect(MILESTONE_FORM_DEFAULTS).toEqual({
      name: '',
      amount: 0,
      dueCondition: '',
    });
    expect(CALLOFF_FORM_DEFAULTS).toEqual({ amount: 0, remark: '' });
    expect(CHANGE_FORM_DEFAULTS).toEqual({ changeLog: '', newAmount: 0 });
  });

  it('明细草稿初值是"1 件 × 0 元 × 6%"，且 6 只是主体未知时的起点', () => {
    expect(EMPTY_ITEM_DRAFT).toEqual({
      itemName: '',
      quantity: 1,
      unitPrice: 0,
      taxRate: 6,
    });
    // 数量默认 1 而不是 0：0 会让"保存"直接跳过（服务端 quantity 有 @Min(0.0001)）
    expect(EMPTY_ITEM_DRAFT.quantity).toBe(1);
  });
});

/* ── 提交入参拼装 ────────────────────────────────────────────────────────── */

describe('提交入参拼装（buildMilestonePayload / buildCalloffPayload / buildChangePayload）', () => {
  it('里程碑：空触发条件转 undefined，金额 0 **保留**为 0', () => {
    expect(
      buildMilestonePayload({
        name: '尾款',
        amount: 0,
        dueCondition: '',
        dueDate: undefined,
      }),
    ).toEqual({
      name: '尾款',
      amount: 0,
      dueCondition: undefined,
      dueDate: undefined,
    });
    expect(
      buildMilestonePayload({
        name: '尾款',
        amount: 100,
        dueCondition: '验收通过',
        dueDate: '2026-10-16',
      }),
    ).toEqual({
      name: '尾款',
      amount: 100,
      dueCondition: '验收通过',
      dueDate: '2026-10-16',
    });
  });

  it('里程碑金额 0 不被丢弃（与变更金额 0 的处理**有意不同**）', () => {
    /*
     * `buildMilestonePayload` 原样透传 `amount`（0 元里程碑是合法的，
     * schema 门槛也是 0），而 `buildChangePayload` 会把 `newAmount` 的 0
     * 变成 `undefined`（= 金额不变）。两处都是既定语义，不要"统一"。
     */
    const payload = buildMilestonePayload({
      name: '质保金',
      amount: 0,
      dueCondition: '',
      dueDate: undefined,
    });
    expect(payload.amount).toBe(0);
    expect(payload.amount).not.toBeUndefined();
  });

  it('下单：空备注转 undefined，金额原样', () => {
    expect(buildCalloffPayload({ amount: 1200, remark: '' })).toEqual({
      amount: 1200,
      remark: undefined,
    });
    expect(buildCalloffPayload({ amount: 1200, remark: '第一批' })).toEqual({
      amount: 1200,
      remark: '第一批',
    });
  });

  it('变更：`newAmount` 为 0 时变成 undefined（0 = 金额不变），非 0 原样保留', () => {
    /*
     * 标签写的就是"变更后金额（元，不变可填 0）"：填 0 → `newAmount || undefined`
     * → 服务端 `contracts.service.ts` 的 `dto.newAmount ?? oldAmount` 沿用原金额。
     * 因此 0 **永远**不会把合同金额改成 0 元。0.01 这类极小但非 0 的值必须保留。
     */
    expect(buildChangePayload({ changeLog: '补签', newAmount: 0 })).toEqual({
      changeLog: '补签',
      newAmount: undefined,
    });
    expect(buildChangePayload({ changeLog: '补签', newAmount: 0.01 })).toEqual({
      changeLog: '补签',
      newAmount: 0.01,
    });
    expect(buildChangePayload({ changeLog: '补签', newAmount: 5000 })).toEqual({
      changeLog: '补签',
      newAmount: 5000,
    });
  });
});

/* ── 纳税主体选择 ────────────────────────────────────────────────────────── */

describe('明细弹窗的主体选择（pickTaxEntity）', () => {
  it('优先级：显式 taxEntityId → isDefault → 第一个', () => {
    const explicit = entity({ id: 'te-explicit', isDefault: false });
    const list = [explicit, GENERAL, SMALL];
    expect(pickTaxEntity(list, 'te-explicit')?.id).toBe('te-explicit');
    expect(pickTaxEntity(list, 'not-exists')?.id).toBe(GENERAL.id);
    expect(pickTaxEntity(list, null)?.id).toBe(GENERAL.id);
    expect(pickTaxEntity(list, undefined)?.id).toBe(GENERAL.id);
  });

  it('没有默认主体时取第一个；主体列表为空时返回 undefined（不抛错）', () => {
    const a = entity({ id: 'te-a', isDefault: false });
    const b = entity({ id: 'te-b', isDefault: false });
    expect(pickTaxEntity([a, b], undefined)?.id).toBe('te-a');
    expect(pickTaxEntity([], 'te-a')).toBeUndefined();
  });

  it('**不**看主体状态：已停用的显式主体仍被选中（登记现状，与后端不同）', () => {
    /*
     * 后端 `TaxResolverService.resolveEntity` 对显式主体会校验 `status === 'active'`
     * 并在停用时抛 400（`tax-resolver.service.ts:110-113`），前端这条链不看状态 ——
     * 于是下拉里会出现一个"能选、保存却被拒"的主体。这是**已登记的口径分歧**，
     * 本次拆分不改（改它要动主体选择策略，属于另一个决定）。
     */
    const inactive = entity({
      id: 'te-inactive',
      status: 'inactive',
      isDefault: false,
    });
    expect(pickTaxEntity([inactive, GENERAL], 'te-inactive')?.id).toBe(
      'te-inactive',
    );
  });

  it('**不**看客户绑定主体：只按显式 id / 默认 / 第一个找（后端还会插一级）', () => {
    /*
     * 后端链条是「显式 taxEntityId → 客户/供应商绑定主体 → 默认主体」
     * （`tax-resolver.service.ts:101-149`）。本函数没有"客户绑定"这一级，
     * 因为 `ContractDetail` 不返回客户的绑定主体（要另发一次请求才能拿到）。
     * 后果：此处选中的主体可能与服务端当初计算税率用的主体**不同** ——
     * 这正是 `resolveItemTaxRate` 必须做兜底（而不是把 null 交给请求体）的原因。
     */
    const list = [GENERAL, SMALL];
    // 合同未显式指定主体 → 取默认（一般纳税人），而不是小规模客户绑定的主体
    expect(pickTaxEntity(list, null)?.id).toBe(GENERAL.id);
    expect(pickTaxEntity(list, null)?.taxpayerType).toBe('general');
  });
});

/* ── 明细默认税率（本轮修复点） ──────────────────────────────────────────── */

describe('明细默认税率（itemRateOptions / resolveItemTaxRate）', () => {
  it('下拉可选项按主体类型给出（小规模没有 6%、一般纳税人没有 1%/3%）', () => {
    expect(itemRateOptions([GENERAL], 'te-general')).toEqual([0, 5, 6, 9, 13]);
    expect(itemRateOptions([SMALL], 'te-small')).toEqual([0, 1, 3, 5]);
    // 主体列表为空 → 给全字典（原实现即 `resolveRateOptions(undefined)`）
    expect(itemRateOptions([], undefined)).toEqual([...VAT_RATES]);
  });

  it('税率合法时**原样保留**（含 0%：不能被 `|| 6` 之类的写法当成"没填"）', () => {
    expect(resolveItemTaxRate(6, [GENERAL], 'te-general')).toBe(6);
    expect(resolveItemTaxRate(3, [SMALL], 'te-small')).toBe(3);
    expect(resolveItemTaxRate(0, [GENERAL], 'te-general')).toBe(0);
    expect(resolveItemTaxRate(0, [SMALL], 'te-small')).toBe(0);
    expect(resolveItemTaxRate(13, [GENERAL], 'te-general')).toBe(13);
  });

  it('证据：缺陷成立 —— `coerceTaxRate` 在"小规模主体 + 合同税率 6"上确实返回 null', () => {
    /*
     * 这一条把"缺陷确实存在"变成**可执行**的：原实现把 `coerceTaxRate` 的返回值
     * 直接放进 `taxRate`，所以下面两个 `null` 就是当年真正被送进请求体的值。
     */
    expect(coerceTaxRate(6, SMALL)).toBeNull();
    expect(coerceTaxRate(3, GENERAL)).toBeNull();
    expect(coerceTaxRate(6, GENERAL)).toBe(6);
    // 修复后的入口不再把这个 null 交出去
    expect(resolveItemTaxRate(6, [SMALL], 'te-small')).toBe(5);
  });

  it('⚠️ 本轮修复：主体不适用的税率 → 该主体的合法默认档位，**永远不是 null**', () => {
    /*
     * 原实现是 `coerceTaxRate(...)` 直接放进 `taxRate`，越界时得到 `null`：
     *   · `<select value={null}>` 依旧空白（P0-3 注释说要修掉的症状）；
     *   · 点保存时 `taxRate: null` 进请求体 —— `ContractItemBodyDto.taxRate`
     *     是 `@IsNumber()`（`contracts.dto.ts:261-263`）→ 必然 400，
     *     即使绕过 DTO 也会被 `contract-items.service.ts:224` 的
     *     `isVatRate` 拦下。
     * 命中的正是"小规模主体 + 合同税率 6"（`ALLOWED_RATES.small = [0,1,3,5]`）。
     */
    expect(resolveItemTaxRate(6, [SMALL], 'te-small')).toBe(
      defaultTaxRate(SMALL),
    );
    expect(resolveItemTaxRate(6, [SMALL], 'te-small')).toBe(5);
    expect(resolveItemTaxRate(3, [GENERAL], 'te-general')).toBe(
      defaultTaxRate(GENERAL),
    );
    expect(resolveItemTaxRate(3, [GENERAL], 'te-general')).not.toBeNull();
    // 非法（不在全量档位内）的税率同样被兜底，例如 7 或负数
    expect(resolveItemTaxRate(7, [GENERAL], 'te-general')).not.toBeNull();
    expect(resolveItemTaxRate(-1, [], undefined)).toBe(defaultTaxRate(null));
  });

  it('兜底值一定出现在同一个下拉的选项里（否则又是"空白 + 400"）', () => {
    /*
     * 这是修复的**结构性**保证：兜底走 `defaultTaxRate(entity)`，而选项走
     * `resolveRateOptions(entity)` —— 同一个主体、同一个档位字典。
     * 这里对"每个主体 × 每个可能被送进来的税率"逐一验证这条不变式。
     */
    const cases: Array<[TaxEntity[], string | undefined]> = [
      [[GENERAL], 'te-general'],
      [[SMALL], 'te-small'],
      [[GENERAL, SMALL], undefined],
      [[], undefined],
    ];
    for (const [list, id] of cases) {
      const options = itemRateOptions(list, id) as readonly number[];
      for (const rate of [0, 1, 3, 5, 6, 9, 13, 7, -1, 100.5]) {
        const picked = resolveItemTaxRate(rate, list, id);
        expect(options).toContain(picked);
        expect(Number.isFinite(picked)).toBe(true);
      }
    }
  });
});

/* ── 明细草稿 ────────────────────────────────────────────────────────────── */

describe('明细草稿（createItemDraft）', () => {
  it('四个字段固定：空名称、数量 1、单价 0、税率按主体校正', () => {
    expect(createItemDraft(6, [GENERAL], 'te-general')).toEqual({
      itemName: '',
      quantity: 1,
      unitPrice: 0,
      taxRate: 6,
    });
  });

  it('合同税率 0 被保留（`?? 6` 而不是 `|| 6` —— 0% 是合法档位）', () => {
    expect(createItemDraft(0, [GENERAL], 'te-general').taxRate).toBe(0);
    expect(createItemDraft(0, [SMALL], 'te-small').taxRate).toBe(0);
    // 反例防线：若写成 `|| 6`，上面两条会得到 6
    expect(createItemDraft(0, [GENERAL], 'te-general').taxRate).not.toBe(6);
  });

  it('合同税率缺失/为 null → 先按 6 兜底，再按主体校正（小规模 → 5）', () => {
    expect(createItemDraft(null, [GENERAL], 'te-general').taxRate).toBe(6);
    expect(createItemDraft(undefined, [GENERAL], 'te-general').taxRate).toBe(6);
    expect(createItemDraft(null, [SMALL], 'te-small').taxRate).toBe(
      defaultTaxRate(SMALL),
    );
  });

  it('主体不适用的合同税率 → 落到该主体的合法档位，绝不会是 null', () => {
    const draft = createItemDraft(6, [SMALL], 'te-small');
    expect(draft.taxRate).toBe(5);
    expect(draft.taxRate).not.toBeNull();
    expect(itemRateOptions([SMALL], 'te-small') as readonly number[]).toContain(
      draft.taxRate,
    );
  });
});
