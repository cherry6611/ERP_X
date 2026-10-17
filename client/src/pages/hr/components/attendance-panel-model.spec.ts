import {
  AMENDMENT_FORM_DEFAULTS,
  AMENDMENT_STATUS_LABELS,
  ATTENDANCE_FORM_DEFAULTS,
  LEAVE_FORM_DEFAULTS,
  amendmentSchema,
  attendanceSchema,
  balanceColumns,
  balanceFormDefaults,
  balanceSchema,
  leaveSchema,
} from './attendance-panel-model';
import {
  ATTENDANCE_STATUS_LABELS,
  LEAVE_STATUS_LABELS,
  LEAVE_TYPE_LABELS,
} from './HrStatusBadge';
import type {
  AttendanceAmendmentStatus,
  AttendanceStatus,
  CreateAttendanceAmendmentDto,
  CreateLeaveRequestDto,
  LeaveBalance,
  LeaveRequestStatus,
  LeaveType,
  SetLeaveBalanceDto,
  UpsertAttendanceDto,
} from '@shared/api.interface';

/**
 * 考勤/请假面板的声明式纯逻辑规格（§5.9 / F8）。
 *
 * ## 为什么这四块必须逐条断言
 *
 * 它们全是"界面上看不出来"的错误面：
 *
 * | 块 | 改错的后果 | 界面上看得出来吗 |
 * |---|---|---|
 * | `*Schema` 的必填与门槛 | 脏数据落库（0 天假、无员工的额度），报错只在提交瞬间以 toast 一闪 | 提交前完全看不出来 |
 * | 表单默认值 | 弹窗打开即红（默认天数 0），或初始值与提交后 `reset` 的值不一致 | 只有走到那一步才发现 |
 * | `AMENDMENT_STATUS_LABELS` | 缺 key → 表格显示英文 `approved`；两条 code 配同一中文 → 审批人分不清状态 | 只在补卡表格出现 |
 * | `balanceColumns` | 「已用（天）」与「剩余（天）」配错字段 —— 两列**都还是合理数字**（`已用 + 剩余 = 总额度`），HR 据此判断谁还有额度会直接判错 | 完全看不出来 |
 *
 * ## 三组"刻意不同步"的取值（本文件的重点）
 *
 * 1. **天数输入框的 `min={0.5}` ≠ schema 门槛**：schema 只要求 `> 0`（`positive()`），
 *    `min/step` 只是受控 input 的步进提示，不是校验。`0.1` 能通过 schema。
 * 2. **客户端额度门槛（> 0）≠ 服务端（`@Min(0)`）**：`SetLeaveBalanceDto.totalDays`
 *    在 `hr-core.controller.ts` 里是 `@Min(0)`，客户端更严是有意的。
 * 3. **`year` 只校验非空 ≠ 4 位数字**：格式闸门在服务端（`InitLeaveBalancesDto`
 *    有 `@Matches(/^\d{4}$/)`），本模块保持原行为。
 *
 * 断言里凡出现"登记现状"字样，含义都是：**这是原实现的真实行为，测试钉住它
 * 以免被顺手改掉**；要改必须先改这条断言并说明理由。
 */

/* ── 契约枚举的运行期镜像 ────────────────────────────────────────────────
 *
 * 写成 `Record<契约联合类型, true>` 而不是 `string[]`：契约里新增一个状态成员时
 * **本文件编译不过**，强制有人回来补断言。否则新状态会静默显示成英文 key。
 */
const ATTENDANCE_STATUSES: Record<AttendanceStatus, true> = {
  present: true,
  absent: true,
  late: true,
  leave: true,
};
const LEAVE_TYPES: Record<LeaveType, true> = {
  annual: true,
  sick: true,
  personal: true,
};
const LEAVE_STATUSES: Record<LeaveRequestStatus, true> = {
  pending: true,
  approved: true,
  rejected: true,
};
const AMENDMENT_STATUSES: Record<AttendanceAmendmentStatus, true> = {
  pending: true,
  approved: true,
  rejected: true,
};

/*
 * 表单 schema 的字段集必须与"提交时构造的 DTO"逐字段一致：
 * 多一个字段（用户填了却不发）或少一个（发出去是 undefined）都不会报错。
 * 这里用契约类型做键，契约改名时同样编译不过。
 */
const ATTENDANCE_DTO_KEYS: Record<keyof UpsertAttendanceDto, true> = {
  employeeId: true,
  workDate: true,
  status: true,
  remark: true,
};
const LEAVE_DTO_KEYS: Record<keyof CreateLeaveRequestDto, true> = {
  employeeId: true,
  leaveType: true,
  startDate: true,
  endDate: true,
  days: true,
  reason: true,
};
const BALANCE_DTO_KEYS: Record<keyof SetLeaveBalanceDto, true> = {
  employeeId: true,
  leaveType: true,
  year: true,
  totalDays: true,
};
const AMENDMENT_DTO_KEYS: Record<keyof CreateAttendanceAmendmentDto, true> = {
  workDate: true,
  reason: true,
};

const codes = (map: Record<string, true>): string[] => Object.keys(map);
const schemaKeys = (schema: { shape: Record<string, unknown> }): string[] =>
  Object.keys(schema.shape);

/** 取 zod 第一条报错文案（表单上显示的正是这一条） */
function firstMessage(result: { success: boolean; error?: { issues: Array<{ message: string }> } }): string {
  return result.error?.issues[0]?.message ?? '';
}

function messages(result: { success: boolean; error?: { issues: Array<{ message: string }> } }): string[] {
  return (result.error?.issues ?? []).map((issue) => issue.message);
}

describe('AMENDMENT_STATUS_LABELS（补卡状态文案）', () => {
  it('逐条钉死文案（改一个字就是改审批人看到的词）', () => {
    expect(AMENDMENT_STATUS_LABELS).toEqual({
      pending: '待审批',
      approved: '已通过',
      rejected: '已驳回',
    });
  });

  it('覆盖契约里的全部状态，且没有多余 key（缺一个就显示英文 key）', () => {
    for (const code of codes(AMENDMENT_STATUSES)) {
      expect(AMENDMENT_STATUS_LABELS[code]).toBeTruthy();
    }
    // 多余 key 通常是从别的字典（如工资单的 paid/voided）抄串了
    expect(Object.keys(AMENDMENT_STATUS_LABELS).sort()).toEqual(
      codes(AMENDMENT_STATUSES).sort(),
    );
  });

  it('每条文案都非空且**互不相同**（两条 code 同一中文会让审批人分不清）', () => {
    const labels = Object.values(AMENDMENT_STATUS_LABELS);
    for (const label of labels) {
      expect(typeof label).toBe('string');
      expect(label.length).toBeGreaterThan(0);
      expect(label).toBe(label.trim());
    }
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('与请假状态文案**有意不同**：approved 在补卡是「已通过」、在请假是「已批准」', () => {
    /*
     * 登记现状：两张表各自的行文在系统里已经固定。若有人"统一字典"把两者合并，
     * 补卡表格的中文文案会**静默变化** —— 这条断言让那次改动必须是有意识的。
     */
    expect(AMENDMENT_STATUS_LABELS.approved).toBe('已通过');
    expect(LEAVE_STATUS_LABELS.approved).toBe('已批准');
    expect(AMENDMENT_STATUS_LABELS.approved).not.toBe(LEAVE_STATUS_LABELS.approved);
    // 另两个状态两张表恰好一致，也一并钉住
    expect(AMENDMENT_STATUS_LABELS.pending).toBe(LEAVE_STATUS_LABELS.pending);
    expect(AMENDMENT_STATUS_LABELS.rejected).toBe(LEAVE_STATUS_LABELS.rejected);
  });
});

describe('attendanceSchema（登记考勤）', () => {
  const VALID = {
    employeeId: 'emp-1',
    workDate: '2026-10-16',
    status: 'present',
    remark: '',
  };

  it('字段集与 UpsertAttendanceDto 完全一致（多一个少一个都不会报错）', () => {
    expect(schemaKeys(attendanceSchema).sort()).toEqual(
      Object.keys(ATTENDANCE_DTO_KEYS).sort(),
    );
  });

  it('员工/日期/状态都是必填，报可读中文（remark 可为空）', () => {
    expect(firstMessage(attendanceSchema.safeParse({ ...VALID, employeeId: '' }))).toBe(
      '请选择员工',
    );
    expect(firstMessage(attendanceSchema.safeParse({ ...VALID, workDate: '' }))).toBe(
      '请选择日期',
    );
    expect(firstMessage(attendanceSchema.safeParse({ ...VALID, status: '' }))).toBe(
      '请选择状态',
    );
    expect(attendanceSchema.safeParse({ ...VALID, remark: '' }).success).toBe(true);
  });

  it('每个契约状态都能通过（枚举白名单在服务端，客户端只挡空值）', () => {
    for (const status of codes(ATTENDANCE_STATUSES)) {
      expect(attendanceSchema.safeParse({ ...VALID, status }).success).toBe(true);
    }
    /*
     * 登记现状：`status` 只是 `z.string().min(1)`，**不是** `z.enum([...])`。
     * 未知取值在客户端放行、由服务端 `UpsertAttendanceDto` 的
     * `@IsIn(['present','absent','late','leave'])` 拦下（400 + 可读中文）。
     * 这里把它写出来，是为了让"要不要在客户端也加枚举"成为一次有意识的决定。
     */
    expect(attendanceSchema.safeParse({ ...VALID, status: 'weird' }).success).toBe(true);
  });

  it('合法输入原样输出，不做 trim / 不改写用户填的备注', () => {
    const parsed = attendanceSchema.safeParse({
      ...VALID,
      workDate: '2026-10-16',
      status: 'late',
      remark: ' 地铁故障 迟到 10 分钟 ',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      employeeId: 'emp-1',
      workDate: '2026-10-16',
      status: 'late',
      remark: ' 地铁故障 迟到 10 分钟 ',
    });
  });
});

describe('leaveSchema（新建请假）', () => {
  const VALID = {
    employeeId: 'emp-1',
    leaveType: 'annual',
    startDate: '2026-10-16',
    endDate: '2026-10-17',
    days: 1,
    reason: '',
  };

  it('字段集与 CreateLeaveRequestDto 完全一致', () => {
    expect(schemaKeys(leaveSchema).sort()).toEqual(Object.keys(LEAVE_DTO_KEYS).sort());
  });

  it('员工/假别/开始/结束/天数都必填，报可读中文', () => {
    expect(firstMessage(leaveSchema.safeParse({ ...VALID, employeeId: '' }))).toBe('请选择员工');
    expect(firstMessage(leaveSchema.safeParse({ ...VALID, leaveType: '' }))).toBe('请选择假别');
    expect(firstMessage(leaveSchema.safeParse({ ...VALID, startDate: '' }))).toBe(
      '请选择开始日期',
    );
    expect(firstMessage(leaveSchema.safeParse({ ...VALID, endDate: '' }))).toBe(
      '请选择结束日期',
    );
  });

  it('天数门槛是 **> 0**：0 天假被拒，半天假放行', () => {
    expect(firstMessage(leaveSchema.safeParse({ ...VALID, days: 0 }))).toBe(
      '请假天数必须大于 0',
    );
    expect(leaveSchema.safeParse({ ...VALID, days: 0.5 }).success).toBe(true);
    expect(leaveSchema.safeParse({ ...VALID, days: -1 }).success).toBe(false);
  });

  it('天数的门槛**不是**输入框上的 0.5：`min={0.5}` 只是步进提示', () => {
    /*
     * 天数输入框是 `<Input type="number" min={0.5} step={0.5} value={String(field.value)}/>`，
     * 受控 `onChange` 不经过 RHF 的 `register`，因此 HTML 的 min **不参与校验**。
     * 于是 0.1 天能通过 schema —— 这是原行为，别把 UI 提示当成校验契约。
     */
    expect(leaveSchema.safeParse({ ...VALID, days: 0.1 }).success).toBe(true);
  });

  it('天数接受字符串（受控 number input 给的是字符串）并 coerce 成数字', () => {
    const parsed = leaveSchema.safeParse({ ...VALID, days: '2.5' });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.days).toBe(2.5);
    expect(typeof parsed.data?.days).toBe('number');
  });

  it('天数被清空（空串 → Number("") 为 0）时报中文错，而不是放行 0 天假', () => {
    expect(firstMessage(leaveSchema.safeParse({ ...VALID, days: '' }))).toBe(
      '请假天数必须大于 0',
    );
  });

  it('天数是非数字时走 zod 默认英文文案（登记现状；type=number 下该分支不可达）', () => {
    const result = leaveSchema.safeParse({ ...VALID, days: 'abc' });
    expect(result.success).toBe(false);
    expect(firstMessage(result)).toContain('expected number');
  });

  it('事由可留空；但**纯空格能通过**（登记现状：schema 不 trim）', () => {
    expect(leaveSchema.safeParse({ ...VALID, reason: '' }).success).toBe(true);
    /*
     * 登记现状：`reason` 是 `z.string()`，没有 `.trim().min(1)`；服务端
     * `CreateLeaveRequestDto.reason` 也只是 `@IsString() @IsOptional()`。
     * 因此"   "会被当成有效事由落库。要拦需要加 trim —— 那是行为变更，
     * 必须连同服务端一起决定，所以这里只登记不断言"应该拦"。
     */
    expect(leaveSchema.safeParse({ ...VALID, reason: '   ' }).success).toBe(true);
  });

  it('假别不做枚举白名单（同 status：白名单在服务端 @IsIn）', () => {
    for (const leaveType of codes(LEAVE_TYPES)) {
      expect(leaveSchema.safeParse({ ...VALID, leaveType }).success).toBe(true);
    }
    expect(leaveSchema.safeParse({ ...VALID, leaveType: 'weird' }).success).toBe(true);
  });
});

describe('balanceSchema（请假额度设置）', () => {
  const VALID = {
    employeeId: 'emp-1',
    leaveType: 'annual',
    year: '2026',
    totalDays: 5,
  };

  it('字段集与 SetLeaveBalanceDto 完全一致', () => {
    expect(schemaKeys(balanceSchema).sort()).toEqual(Object.keys(BALANCE_DTO_KEYS).sort());
  });

  it('员工/假别/年度必填，报可读中文', () => {
    expect(firstMessage(balanceSchema.safeParse({ ...VALID, employeeId: '' }))).toBe(
      '请选择员工',
    );
    expect(firstMessage(balanceSchema.safeParse({ ...VALID, leaveType: '' }))).toBe(
      '请选择假别',
    );
    expect(firstMessage(balanceSchema.safeParse({ ...VALID, year: '' }))).toBe('请填写年份');
  });

  it('额度天数门槛是 **> 0**，且**比服务端更严**', () => {
    /*
     * 服务端 `SetLeaveBalanceDto.totalDays` 是 `@Min(0)`（`hr-core.controller.ts`）
     * —— 0 天额度在服务端是合法的，客户端却拦。客户端更严是安全的，
     * 这条断言的作用是：有人为了"和服务端对齐"把 0 放进来时，测试会红。
     */
    expect(firstMessage(balanceSchema.safeParse({ ...VALID, totalDays: 0 }))).toBe(
      '额度天数必须大于 0',
    );
    expect(balanceSchema.safeParse({ ...VALID, totalDays: 0.5 }).success).toBe(true);
  });

  it('额度天数的报错文案与请假天数的**不同**（复制粘贴会串）', () => {
    const balanceMsg = firstMessage(balanceSchema.safeParse({ ...VALID, totalDays: 0 }));
    const leaveMsg = firstMessage(
      leaveSchema.safeParse({
        employeeId: 'e',
        leaveType: 'annual',
        startDate: '2026-10-16',
        endDate: '2026-10-17',
        days: 0,
        reason: '',
      }),
    );
    expect(balanceMsg).toBe('额度天数必须大于 0');
    expect(leaveMsg).toBe('请假天数必须大于 0');
    expect(balanceMsg).not.toBe(leaveMsg);
  });

  it('额度天数接受字符串并 coerce（含小数余额）', () => {
    const parsed = balanceSchema.safeParse({ ...VALID, totalDays: '5.5' });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.totalDays).toBe(5.5);
  });

  it('year 只校验非空、**不做 4 位数字格式校验**（登记现状）', () => {
    /*
     * 登记现状：`year` 是 `z.string().min(1)`。
     * 服务端两处口径也不同：`SetLeaveBalanceDto.year` 只有 `@MinLength(4)`，
     * 而 `InitLeaveBalancesDto.year` 才是 `@Matches(/^\d{4}$/)`。
     * 也就是说 '26'/'2026年' 这类输入客户端放行、由服务端兜（或落库）。
     * 加正则属于行为变更（会新增一类前端报错），故此处只登记。
     */
    expect(balanceSchema.safeParse({ ...VALID, year: 'x' }).success).toBe(true);
    expect(balanceSchema.safeParse({ ...VALID, year: '26' }).success).toBe(true);
    // 但空串必须被挡：空 year 会在 hr_leave_balance 里建一行"无年份"额度
    expect(balanceSchema.safeParse({ ...VALID, year: '' }).success).toBe(false);
  });
});

describe('amendmentSchema（补卡申请）', () => {
  const VALID = { workDate: '2026-10-16', reason: '忘打卡，实际出勤' };

  it('字段集与 CreateAttendanceAmendmentDto 完全一致（**没有** employeeId）', () => {
    /*
     * 补卡不带员工：后端按当前登录账号绑定的员工落库（面板上也写着
     * "按当前登录账号绑定的员工提交"）。若这里冒出 employeeId，
     * 用户就能给**别人**补卡 —— 而界面不会有任何提示。
     */
    expect(schemaKeys(amendmentSchema).sort()).toEqual(
      Object.keys(AMENDMENT_DTO_KEYS).sort(),
    );
    expect(schemaKeys(amendmentSchema)).not.toContain('employeeId');
  });

  it('日期与补卡原因必填，报可读中文', () => {
    expect(firstMessage(amendmentSchema.safeParse({ ...VALID, workDate: '' }))).toBe(
      '请选择日期',
    );
    expect(firstMessage(amendmentSchema.safeParse({ ...VALID, reason: '' }))).toBe(
      '请填写补卡原因',
    );
    expect(amendmentSchema.safeParse(VALID).success).toBe(true);
  });

  it('补卡原因**纯空格能通过**（登记现状：不 trim，空白原因会进审批流）', () => {
    expect(amendmentSchema.safeParse({ ...VALID, reason: '   ' }).success).toBe(true);
  });
});

describe('表单默认值', () => {
  it('考勤默认值逐字段固定（状态预设「正常出勤」）', () => {
    expect(ATTENDANCE_FORM_DEFAULTS).toEqual({
      employeeId: '',
      workDate: '',
      status: 'present',
      remark: '',
    });
  });

  it('考勤默认状态是契约合法值且有中文文案', () => {
    expect(Object.keys(ATTENDANCE_STATUSES)).toContain(ATTENDANCE_FORM_DEFAULTS.status);
    expect(ATTENDANCE_STATUS_LABELS[ATTENDANCE_FORM_DEFAULTS.status]).toBe('正常出勤');
  });

  it('考勤默认值**只**缺员工与日期（其余字段不会让弹窗一打开就报错）', () => {
    const result = attendanceSchema.safeParse(ATTENDANCE_FORM_DEFAULTS);
    expect(result.success).toBe(false);
    // 恰好两条：员工、日期。若默认状态被清空，这里会多出「请选择状态」
    expect(messages(result)).toEqual(['请选择员工', '请选择日期']);
  });

  it('请假默认值逐字段固定（天数默认 1、假别默认年假）', () => {
    expect(LEAVE_FORM_DEFAULTS).toEqual({
      employeeId: '',
      leaveType: 'annual',
      startDate: '',
      endDate: '',
      days: 1,
      reason: '',
    });
  });

  it('请假默认天数必须通过自己的 schema 门槛（默认 0 会让弹窗打开即红）', () => {
    expect(
      leaveSchema.safeParse({ ...LEAVE_FORM_DEFAULTS, employeeId: 'e', startDate: 'a', endDate: 'b' })
        .success,
    ).toBe(true);
    // 反例防线：默认天数是 0 的话，上面那条会失败 —— 先证明 0 真的会被拒
    expect(leaveSchema.safeParse({ ...LEAVE_FORM_DEFAULTS, days: 0 }).success).toBe(false);
  });

  it('请假默认假别有中文文案（否则下拉框首项显示英文 code）', () => {
    expect(LEAVE_TYPE_LABELS[LEAVE_FORM_DEFAULTS.leaveType]).toBe('年假');
  });

  it('额度默认值逐字段固定，且年度**跟随入参**而不是硬编码', () => {
    expect(balanceFormDefaults('2025')).toEqual({
      employeeId: '',
      leaveType: 'annual',
      year: '2025',
      totalDays: 5,
    });
    // 换个年度必须跟着变：额度按 (员工, 假别, 年) 唯一，年度写错会给错的年份建额度
    expect(balanceFormDefaults('2026').year).toBe('2026');
    expect(balanceFormDefaults('2031').year).toBe('2031');
  });

  it('额度默认天数是 5 且通过 schema 门槛', () => {
    const defaults = balanceFormDefaults('2026');
    expect(defaults.totalDays).toBe(5);
    /*
     * 打开弹窗时未选员工，所以整体必失败 —— 但失败的原因必须**只有**这一条。
     * 若默认额度被改成 0，这里会多出「额度天数必须大于 0」，弹窗一打开就是红的。
     */
    expect(messages(balanceSchema.safeParse(defaults))).toEqual(['请选择员工']);
    expect(balanceSchema.safeParse({ ...defaults, employeeId: 'e' }).success).toBe(true);
  });

  it('补卡默认值逐字段固定，且默认原因不是合法值（必须先说明原因）', () => {
    expect(AMENDMENT_FORM_DEFAULTS).toEqual({ workDate: '', reason: '' });
    expect(amendmentSchema.safeParse(AMENDMENT_FORM_DEFAULTS).success).toBe(false);
    expect(firstMessage(amendmentSchema.safeParse(AMENDMENT_FORM_DEFAULTS))).toBe('请选择日期');
  });
});

describe('balanceColumns（请假余额表格列）', () => {
  /** 互不相同的取值：总额度 31 / 已用 12 / 剩余 19 —— 取错字段也会是"合理数字" */
  const ROW: LeaveBalance = {
    id: 'lb-1',
    employeeId: 'emp-1',
    employeeName: '张三',
    leaveType: 'annual',
    year: '2026',
    totalDays: 31,
    usedDays: 12,
    remainingDays: 19,
  };

  /*
   * `TableColumnsType<T>` 是 `(ColumnGroupType<T> | ColumnType<T>)[]` 的联合，
   * 而 `ColumnGroupType`（分组列）**没有** `dataIndex` —— 本表的 6 列全是叶子列，
   * 故在这里收窄成一个只含叶子列的视图，才能逐列断言字段映射。
   */
  type LeafColumn = {
    title?: string;
    dataIndex?: string;
    width?: number;
    fixed?: string | boolean;
    render?: (value: unknown, record: LeaveBalance, index: number) => unknown;
  };
  const columns = balanceColumns as LeafColumn[];

  function columnOf(title: string): LeafColumn {
    const column = columns.find((c) => c.title === title);
    if (!column) throw new Error(`列「${title}」不存在`);
    return column;
  }

  /** 模拟 antd 的取值规则：有 render 用它，否则取 `row[dataIndex]` */
  function cell(row: LeaveBalance, title: string): unknown {
    const column = columnOf(title);
    const raw = (row as unknown as Record<string, unknown>)[String(column.dataIndex)];
    return column.render ? column.render(raw, row, 0) : raw;
  }

  it('列头与列序固定', () => {
    expect(columns.map((c) => c.title)).toEqual([
      '员工',
      '类型',
      '年度',
      '总额度（天）',
      '已用（天）',
      '剩余（天）',
    ]);
  });

  it('列的字段映射与宽度逐列固定（已用/剩余不许互换）', () => {
    expect(
      columns.map((c) => ({
        title: c.title,
        dataIndex: c.dataIndex,
        width: c.width,
        fixed: c.fixed,
      })),
    ).toEqual([
      { title: '员工', dataIndex: 'employeeName', width: 130, fixed: 'left' },
      { title: '类型', dataIndex: 'leaveType', width: 90, fixed: undefined },
      { title: '年度', dataIndex: 'year', width: 80, fixed: undefined },
      { title: '总额度（天）', dataIndex: 'totalDays', width: 110, fixed: undefined },
      { title: '已用（天）', dataIndex: 'usedDays', width: 100, fixed: undefined },
      { title: '剩余（天）', dataIndex: 'remainingDays', width: 100, fixed: undefined },
    ]);
  });

  it('每列显示对应字段的值（已用 ≠ 剩余）', () => {
    expect(cell(ROW, '员工')).toBe('张三');
    expect(cell(ROW, '年度')).toBe('2026');
    expect(cell(ROW, '总额度（天）')).toBe(31);
    expect(cell(ROW, '已用（天）')).toBe(12);
    expect(cell(ROW, '剩余（天）')).toBe(19);
    // 反例防线：若两列配到同一个字段，这里必然相等
    expect(cell(ROW, '已用（天）')).not.toBe(cell(ROW, '剩余（天）'));
    // 「已用 + 剩余 = 总额度」使取错字段也看着合理 —— 这正是要逐列断言的原因
    expect(ROW.usedDays + ROW.remainingDays).toBe(ROW.totalDays);
  });

  it('「类型」列走字典文案，未知取值原样透出（不留空白格）', () => {
    expect(cell(ROW, '类型')).toBe(LEAVE_TYPE_LABELS.annual);
    expect(cell({ ...ROW, leaveType: 'sick' }, '类型')).toBe(LEAVE_TYPE_LABELS.sick);
    expect(cell({ ...ROW, leaveType: 'personal' }, '类型')).toBe(LEAVE_TYPE_LABELS.personal);
    /*
     * 契约外的取值（后端新增假别、历史数据）必须原样显示：
     * 显示成空白会让 HR 分不清"没有假别"与"数据丢了"。
     */
    expect(cell({ ...ROW, leaveType: 'weird' } as unknown as LeaveBalance, '类型')).toBe('weird');
  });

  it('「类型」列为 null 时兜底仍是 null（`?? v` 救不了 null）—— 登记现状', () => {
    /*
     * 登记现状：`LEAVE_TYPE_LABELS[v] ?? v` 的兜底是**原值本身**，所以 v 为 null
     * 时结果就是 null（antd 渲染成空格）。契约 `LeaveBalance.leaveType` 非空，
     * 故这是脏数据路径；要改成空串是行为变更，先在此登记。
     */
    expect(cell({ ...ROW, leaveType: null } as unknown as LeaveBalance, '类型')).toBeNull();
  });

  it('「员工」列固定在左侧（横向滚动时姓名不离场）', () => {
    expect(columnOf('员工').fixed).toBe('left');
    expect(columns.filter((c) => c.fixed).length).toBe(1);
  });

  it('每个 dataIndex 都是契约字段名（字段改名后列会永远空白）', () => {
    for (const column of columns) {
      expect(Object.keys(ROW)).toContain(String(column.dataIndex));
    }
  });
});

describe('面板依赖的字典闭包（契约状态 → 中文文案）', () => {
  it('每个考勤状态都有文案（表格 Badge 与状态下拉都靠它）', () => {
    for (const status of codes(ATTENDANCE_STATUSES)) {
      expect(ATTENDANCE_STATUS_LABELS[status]).toBeTruthy();
    }
    expect(Object.keys(ATTENDANCE_STATUS_LABELS).sort()).toEqual(
      codes(ATTENDANCE_STATUSES).sort(),
    );
    expect(new Set(Object.values(ATTENDANCE_STATUS_LABELS)).size).toBe(4);
  });

  it('每个假别都有文案（新建请假/额度设置的下拉都不许漏项）', () => {
    for (const leaveType of codes(LEAVE_TYPES)) {
      expect(LEAVE_TYPE_LABELS[leaveType]).toBeTruthy();
    }
    expect(Object.keys(LEAVE_TYPE_LABELS).sort()).toEqual(codes(LEAVE_TYPES).sort());
    expect(new Set(Object.values(LEAVE_TYPE_LABELS)).size).toBe(3);
  });

  it('每个请假状态都有文案（筛选下拉由 Object.entries(LEAVE_STATUS_LABELS) 生成）', () => {
    for (const status of codes(LEAVE_STATUSES)) {
      expect(LEAVE_STATUS_LABELS[status]).toBeTruthy();
    }
    expect(Object.keys(LEAVE_STATUS_LABELS).sort()).toEqual(codes(LEAVE_STATUSES).sort());
  });
});
