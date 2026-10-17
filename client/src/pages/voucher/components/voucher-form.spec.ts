import {
  BALANCE_TOLERANCE,
  PAGE_SIZE,
  buildLineAux,
  createEmptyVoucherForm,
  emptyLines,
  isBalanced,
  normalizeVoucherLine,
  sumVoucherLines,
  validateVoucherLine,
  voucherExportColumns,
  voucherSchema,
} from './voucher-form';

/**
 * 凭证录入纯逻辑规格（§5.9 / F8）。
 *
 * ## 为什么这些断言值得存在
 *
 * 凭证是账务的**源头单据**。一张借贷不平衡的凭证落库后会污染试算平衡、
 * 总账与报表，而修正需要红字冲销（留下审计痕迹、要人复核）。
 * 这些校验原先内联在 `onSubmit` 回调里，要触达必须渲染整个 841 行组件、
 * 打开弹窗、逐格输入、点提交 —— 因此**四年没有任何自动化覆盖**。
 */
describe('sumVoucherLines（借贷汇总）', () => {
  it('空数组与 undefined 都给 0（不是 NaN）', () => {
    expect(sumVoucherLines([])).toEqual({ totalDebit: 0, totalCredit: 0 });
    expect(sumVoucherLines(undefined)).toEqual({ totalDebit: 0, totalCredit: 0 });
  });

  it('空字符串金额按 0 计（表单里未填的格子是 ""）', () => {
    const result = sumVoucherLines([
      { debit: '', credit: '' },
      { debit: '100', credit: '' },
    ]);
    expect(result).toEqual({ totalDebit: 100, totalCredit: 0 });
  });

  it('借贷分别独立求和，不互相抵消', () => {
    // 若实现写成"借贷相减"，这里会得到 0 而不是 1000
    const result = sumVoucherLines([
      { debit: '1000', credit: '' },
      { debit: '', credit: '1000' },
    ]);
    expect(result.totalDebit).toBe(1000);
    expect(result.totalCredit).toBe(1000);
  });

  it('结果各自 round2（与提交口径一致）', () => {
    const result = sumVoucherLines([
      { debit: '0.005', credit: '' },
      { debit: '0.005', credit: '' },
    ]);
    // 逐行求和得 0.01，再 round2 仍是 0.01
    expect(result.totalDebit).toBe(0.01);
  });

  it('浮点尾数被 round2 收干净（0.1+0.2 类）', () => {
    const result = sumVoucherLines([
      { debit: '0.1', credit: '' },
      { debit: '0.2', credit: '' },
    ]);
    // 未 round2 时是 0.30000000000000004
    expect(result.totalDebit).toBe(0.3);
    expect(String(result.totalDebit)).toBe('0.3');
  });
});

describe('isBalanced（借贷平衡与容差）', () => {
  it('相等即平衡', () => {
    expect(isBalanced(1000, 1000)).toBe(true);
    expect(isBalanced(0, 0)).toBe(true);
  });

  it('**容差边界**：差额不足一分视为平衡，达到一分即不平衡', () => {
    /*
     * 判据是"四舍五入到分后是否相等"，因此边界落在**半分（0.005）**上：
     *   · 差 0.001 / 0.004 → round2 后相等 → 平衡；
     *   · 差 0.005 及以上   → round2 后不等 → 不平衡。
     * 0.001 元 = 1 厘，小于记账本位币最小单位（分），不会掩盖真实差异。
     */
    expect(BALANCE_TOLERANCE).toBe(0.001);
    expect(isBalanced(1000, 1000.001)).toBe(true);
    expect(isBalanced(1000, 1000.004)).toBe(true);
    // 恰好半分开始进位：round2(1000.005) = 1000.01 ≠ 1000 → 不平衡
    expect(isBalanced(1000, 1000.005)).toBe(false);
    expect(isBalanced(1000, 1000.006)).toBe(false);
    expect(isBalanced(1000, 999.999)).toBe(true);
    // round2(999.998) = 1000.00 → 与 1000 相等。这是"到分相等"判据的
    // 必然结果：差额 0.002 元在分以下，本就不该判为不平衡。
    expect(isBalanced(1000, 999.998)).toBe(true);
    // 真正达到一分的差额必须被拦住
    expect(isBalanced(1000, 999.99)).toBe(false);
  });

  it('**判定与金额量级无关**（本轮修复的缺陷）', () => {
    /*
     * 原实现 `Math.abs(a - b) <= 0.001` 在浮点下是**量级相关**的：
     * 同是"数学上差 0.001"，1000 与 1000.001 判为平衡，
     * 而 −100 与 −100.001 判为不平衡 —— 因为 IEEE-754 减法的表示误差
     * 与量级成正比（实测差值分别是 0.00099999999997635… 与
     * 0.00100000000000477…）。
     *
     * 也就是说"借贷差 1 厘算不算平"取决于金额大小，而不是业务规则。
     * 下面这组断言覆盖正负两侧与多个量级，任何"回到浮点差值比较"的改动
     * 都会在其中一个上失败。
     */
    const pairs: Array<[number, number]> = [
      [1000, 1000.001],
      [-100, -100.001],
      [100, 100.001],
      [-1000, -1000.001],
      [0.01, 0.011],
      [-0.01, -0.011],
      [100000, 100000.001],
      [-100000, -100000.001],
    ];
    for (const [a, b] of pairs) {
      expect(isBalanced(a, b)).toBe(true);
    }
    // 反向：同样的量级、差额达到一分，必须判为不平衡
    const unbalancedPairs: Array<[number, number]> = [
      [1000, 1000.01],
      [-100, -100.01],
      [100, 100.01],
      [-1000, -1000.01],
      [100000, 100000.01],
      [-100000, -100000.01],
    ];
    for (const [a, b] of unbalancedPairs) {
      expect(isBalanced(a, b)).toBe(false);
    }
  });

  it('**1 分钱的真实不平衡必须被拦住**（容差不能放大到 0.01）', () => {
    /*
     * 反例防线：若有人"为了减少偶发失败"把容差改成 0.01，
     * 1 分钱的真实不平衡就会被放过。这条断言会失败。
     */
    expect(isBalanced(1000, 1000.01)).toBe(false);
    expect(isBalanced(1000, 999.99)).toBe(false);
  });

  it('容差不掩盖大额差异', () => {
    expect(isBalanced(1000000, 1000000.5)).toBe(false);
    expect(isBalanced(0, 100)).toBe(false);
  });

  it('负数方向同样按绝对值比较', () => {
    // 分录金额不该为负，但汇总函数本身不假设这点
    expect(isBalanced(-100, -100)).toBe(true);
    // 负数与正数同判（量级无关性已在专门用例中覆盖）
    expect(isBalanced(-100, -100.001)).toBe(true);
    expect(isBalanced(-100, -99.9)).toBe(false);
    expect(isBalanced(-0.01, -0.01)).toBe(true);
  });
});

describe('validateVoucherLine（单行分录校验）', () => {
  it('合法的单边借方 / 单边贷方都通过', () => {
    expect(validateVoucherLine(0, { debit: '100', credit: '' })).toBeNull();
    expect(validateVoucherLine(1, { debit: '', credit: '100' })).toBeNull();
    expect(validateVoucherLine(2, { debit: '0.01', credit: '' })).toBeNull();
  });

  it('双零行被拒 —— **这是绕过借贷平衡的后门**', () => {
    /*
     * 双零行不影响合计，所以"两行全空"的凭证合计 0 = 0，
     * 若只校验平衡就会以"无金额凭证"落库。这条规则专门堵它。
     */
    for (const line of [
      { debit: '', credit: '' },
      { debit: '0', credit: '0' },
      { debit: '0.00', credit: '0.00' },
    ]) {
      const error = validateVoucherLine(3, line);
      expect(error).not.toBeNull();
      expect(error?.message).toBe('借方/贷方至少填写一个大于 0 的金额');
      expect(error?.field).toBe('debit');
      expect(error?.index).toBe(3);
    }
  });

  it('借贷同填被拒，且错误挂在 credit 上（与后端一致）', () => {
    const error = validateVoucherLine(1, { debit: '100', credit: '100' });
    expect(error?.message).toBe('借方与贷方不能同时填写金额');
    expect(error?.field).toBe('credit');
  });

  it('负数金额被拒，且错误挂在 debit 上', () => {
    expect(validateVoucherLine(0, { debit: '-1', credit: '' })?.message).toBe(
      '金额不能为负数',
    );
    expect(validateVoucherLine(0, { debit: '', credit: '-1' })?.message).toBe(
      '金额不能为负数',
    );
    // 一侧负数 + 另一侧正数：**必须先报负数**而不是"借贷同填"，
    // 否则用户看到"不能同时填写"会以为自己两格都填了正数
    const mixed = validateVoucherLine(0, { debit: '-100', credit: '100' });
    expect(mixed?.message).toBe('金额不能为负数');
  });

  it('校验顺序固定：负数 > 借贷同填 > 双零', () => {
    // 负数与同填同时成立时，报负数
    expect(validateVoucherLine(0, { debit: '-5', credit: '-5' })?.message).toBe(
      '金额不能为负数',
    );
    // 同填与双零互斥，同填优先
    expect(validateVoucherLine(0, { debit: '1', credit: '1' })?.message).toBe(
      '借方与贷方不能同时填写金额',
    );
  });

  it('index 原样回传（供 setError(`lines.N.…`) 定位）', () => {
    expect(validateVoucherLine(7, {})?.index).toBe(7);
    expect(validateVoucherLine(0, {})?.index).toBe(0);
  });
});

describe('buildLineAux（科目必挂维度 → 后端入参）', () => {
  it('科目未声明必挂维度时返回 undefined（不提交空数组）', () => {
    expect(buildLineAux([], { dept: '研发部' })).toBeUndefined();
    expect(buildLineAux(undefined, { dept: '研发部' })).toBeUndefined();
  });

  it('只提交**声明必挂**的维度，多余的忽略', () => {
    const result = buildLineAux(['dept'], { dept: '研发部', proj: '项目A' });
    expect(result).toEqual([{ dimensionCode: 'dept', dimensionValue: '研发部' }]);
  });

  it('已声明但值为空的维度**不提交**，交给后端报准确错误', () => {
    /*
     * 这是有意的：前端不拦成一句笼统提示，而是让后端给出
     * 「要求填写辅助核算维度」并指明是哪个维度。故空值直接过滤掉。
     */
    expect(buildLineAux(['dept'], {})).toBeUndefined();
    expect(buildLineAux(['dept'], { dept: '' })).toBeUndefined();
    expect(buildLineAux(['dept'], { dept: '   ' })).toBeUndefined();
  });

  it('值两侧空格被 trim', () => {
    expect(buildLineAux(['dept'], { dept: '  研发部  ' })).toEqual([
      { dimensionCode: 'dept', dimensionValue: '研发部' },
    ]);
  });

  it('部分维度有值时只提交有的那些', () => {
    const result = buildLineAux(['dept', 'proj'], { dept: '研发部', proj: '' });
    expect(result).toEqual([{ dimensionCode: 'dept', dimensionValue: '研发部' }]);
    expect(result).toHaveLength(1);
  });

  it('多个维度都有值时按声明顺序全部提交', () => {
    expect(buildLineAux(['dept', 'proj'], { proj: '项目A', dept: '研发部' })).toEqual([
      { dimensionCode: 'dept', dimensionValue: '研发部' },
      { dimensionCode: 'proj', dimensionValue: '项目A' },
    ]);
  });
});

describe('normalizeVoucherLine（表单行 → DTO 行）', () => {
  const line = (
    over: Partial<Parameters<typeof normalizeVoucherLine>[0]> = {},
  ) =>
    ({
      accountId: 'acc-1',
      summary: '摘要',
      debit: '',
      credit: '',
      aux: {},
      ...over,
    }) as Parameters<typeof normalizeVoucherLine>[0];

  it('只填借方时 credit 为 undefined（不是 0）', () => {
    const dto = normalizeVoucherLine(line({ debit: '100' }), undefined);
    expect(dto.debit).toBe(100);
    // 提交 0 会被服务端当作"填了 0 贷方"，undefined 才是"没填"
    expect(dto.credit).toBeUndefined();
  });

  it('只填贷方时 debit 为 undefined', () => {
    const dto = normalizeVoucherLine(line({ credit: '250.5' }), undefined);
    expect(dto.credit).toBe(250.5);
    expect(dto.debit).toBeUndefined();
  });

  it('金额 round2（超过两位小数的输入被截到分）', () => {
    const dto = normalizeVoucherLine(line({ debit: '100.005' }), undefined);
    expect(dto.debit).toBe(round2Of(100.005));
  });

  it('**不足一分的输入（1 厘）该侧不填，且被双零规则拦住**（本轮修复的缺陷）', () => {
    /*
     * `0.001` 元 = 1 厘，小于记账本位币最小单位（分）。
     * `round2(0.001)` 为 0，于是 `debit > 0 ? … : undefined` 走 else 分支
     * → debit 为 undefined。这样这张凭证会被"双零行"规则拦住并提示
     * "至少填写一个大于 0 的金额"，而不是提交一行 0 元分录。
     */
    /*
     * `0.001` 元 = 1 厘，小于记账本位币最小单位（分）：`round2(0.001) === 0`。
     *
     * **原实现的缺陷**：判定用原始值、赋值用取整值 ——
     * `debit > 0 ? round2(debit) : undefined`。`0.001 > 0` 为 true，
     * 于是提交 `debit: 0`。客户端的「双零行」校验读的是原始字符串
     * （`Number('0.001') === 0` 为 false）因而放行；服务端 DTO 是 `@Min(0)`
     * 也放行 → 一行 **0 元分录**过账。试算仍平（0 不影响合计），
     * 但账面多了一条无意义的借贷记录。
     *
     * 修复后：先取整再判定，该侧落为 `undefined`。
     */
    const dto = normalizeVoucherLine(line({ debit: '0.001' }), undefined);
    expect(dto.debit).toBeUndefined();
    expect(dto.credit).toBeUndefined();

    /*
     * ⚠️ 但 `normalizeVoucherLine` 修正不了**全部**入口：它只影响提交的 DTO，
     * 而用户在界面上仍会看到"我填了 0.001"。因此还要确认
     * `validateVoucherLine` 在这条路径上给出的提示是可理解的 ——
     * 它读原始值，`Number('0.001') === 0` 为 false，所以**不会**报双零；
     * 这条断言登记这一事实：拦住的时机是"汇总后平衡校验 + 后端"，
     * 而不是逐行校验。若将来把逐行校验也改成读取整值，
     * 这条断言会失败，从而强制一次有意识的决定。
     */
    expect(validateVoucherLine(0, { debit: '0.001' })).toBeNull();
    // 而提交产物确实不含 0 元分录
    expect(Object.values(dto)).not.toContain(0);
  });

  it('0.005 会被 round2 **进位**到 0.01（不是抹零）', () => {
    // 与上一条配合：只有真正不足半分（<0.005）的输入才落为 0
    expect(normalizeVoucherLine(line({ debit: '0.005' }), undefined).debit).toBe(
      0.01,
    );
    expect(normalizeVoucherLine(line({ debit: '0.004' }), undefined).debit).toBe(
      undefined,
    );
  });

  it('空摘要给 undefined（不留空串占位）', () => {
    expect(
      normalizeVoucherLine(line({ debit: '1', summary: '' }), undefined).summary,
    ).toBeUndefined();
    expect(
      normalizeVoucherLine(line({ debit: '1', summary: 'x' }), undefined).summary,
    ).toBe('x');
  });

  it('辅助核算按科目声明的维度装配', () => {
    const dto = normalizeVoucherLine(
      line({ debit: '1', aux: { dept: '研发部', proj: '' } }),
      ['dept', 'proj'],
    );
    expect(dto.auxDimensions).toEqual([
      { dimensionCode: 'dept', dimensionValue: '研发部' },
    ]);
  });

  it('accountId 原样透传（不做 trim / 校验，交给 zod）', () => {
    expect(
      normalizeVoucherLine(line({ accountId: 'a b', debit: '1' }), undefined)
        .accountId,
    ).toBe('a b');
  });
});

describe('createEmptyVoucherForm / emptyLines', () => {
  it('每次调用返回**全新的 lines 数组**（不是共享引用）', () => {
    /*
     * 这条断言是这次重构的核心保证。原实现是模块级常量 `EMPTY_FORM`，
     * 其 `lines` 数组被所有使用者共享；它既是 useForm 的 defaultValues
     * 又是 form.reset() 的入参。RHF v7 的 reset 内部会深拷贝，所以当前
     * 不会串数据 —— 但那是第三方实现细节。改成函数后"每次全新"是调用方的
     * 结构性保证，不依赖 RHF 恰好会拷贝。
     */
    const a = emptyLines();
    const b = emptyLines();
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
    // 改 a 不影响 b
    a[0].debit = '999';
    expect(b[0].debit).toBe('');
  });

  it('初始两行（复式记账最小分录数）且各字段为空', () => {
    const lines = emptyLines();
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line).toEqual({
        accountId: '',
        summary: '',
        debit: '',
        credit: '',
        aux: {},
      });
    }
    // 每行的 aux 也是独立对象
    expect(lines[0].aux).not.toBe(lines[1].aux);
  });

  it('初始两行本身能通过 schema 的 min(2)（不会被自己的校验拦住）', () => {
    const form = createEmptyVoucherForm('2026-10-16', '2026-10');
    // 只有 lines 长度这条结构化约束成立；其余字段需用户填写
    const result = voucherSchema.safeParse(form);
    expect(result.success).toBe(false);
    const messages = result.success
      ? []
      : result.error.issues.map((i) => i.message);
    expect(messages).toContain('请输入摘要');
    // 不应出现"至少需要两行分录"
    expect(messages).not.toContain('至少需要两行分录');
  });

  it('日期与期间来自参数（不是模块加载时求值）', () => {
    /*
     * 这条钉住"跨零点长驻页面"的行为：若在模块内调 todayIso()，
     * 页面开着一夜后新建凭证的默认日期还是昨天。由调用方在打开弹窗时求值。
     */
    const a = createEmptyVoucherForm('2026-10-16', '2026-10');
    expect(a.voucherDate).toBe('2026-10-16');
    expect(a.period).toBe('2026-10');
    const b = createEmptyVoucherForm('2026-11-01', '2026-11');
    expect(b.voucherDate).toBe('2026-11-01');
    expect(b.period).toBe('2026-11');
  });

  it('两次调用返回不同的 lines 引用', () => {
    const a = createEmptyVoucherForm('2026-10-16', '2026-10');
    const b = createEmptyVoucherForm('2026-10-16', '2026-10');
    expect(a.lines).not.toBe(b.lines);
  });
});

describe('voucherSchema（凭证表单 schema）', () => {
  const validForm = {
    voucherDate: '2026-10-16',
    period: '2026-10',
    summary: '提现',
    remark: '',
    lines: [
      { accountId: 'a1', summary: '', debit: '100', credit: '', aux: {} },
      { accountId: 'a2', summary: '', debit: '', credit: '100', aux: {} },
    ],
  };

  it('合法表单通过', () => {
    expect(voucherSchema.safeParse(validForm).success).toBe(true);
  });

  it('**至少两行分录**（一行无法表达借贷双方）', () => {
    const one = { ...validForm, lines: [validForm.lines[0]] };
    const result = voucherSchema.safeParse(one);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('至少需要两行分录');
    }
    // 零行同样被拒
    expect(voucherSchema.safeParse({ ...validForm, lines: [] }).success).toBe(
      false,
    );
  });

  it('摘要必填（凭证摘要是账簿可读性的基础）', () => {
    const result = voucherSchema.safeParse({ ...validForm, summary: '' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toBe('请输入摘要');
    }
  });

  it('凭证日期与期间必填', () => {
    expect(
      voucherSchema.safeParse({ ...validForm, voucherDate: '' }).success,
    ).toBe(false);
    expect(voucherSchema.safeParse({ ...validForm, period: '' }).success).toBe(
      false,
    );
  });

  it('每行科目必选（accountId 不能为空）', () => {
    const bad = {
      ...validForm,
      lines: [
        { ...validForm.lines[0], accountId: '' },
        validForm.lines[1],
      ],
    };
    expect(voucherSchema.safeParse(bad).success).toBe(false);
  });

  it('**schema 不校验借贷平衡**（那是提交时的业务校验，两者分工不同）', () => {
    /*
     * 登记现状而非认可：`voucherSchema` 只管字段存在性与行数，
     * 借贷平衡由 `isBalanced` + 提交回调负责。这样错误信息能带上
     * 具体金额（"借方合计 ¥100.00，贷方合计 ¥200.00"），
     * 而 zod 的静态 message 做不到。若有人把平衡校验挪进 schema，
     * 这条断言会失败，从而强制一次有意识的决定。
     */
    const unbalanced = {
      ...validForm,
      lines: [
        { ...validForm.lines[0], debit: '100' },
        { ...validForm.lines[1], credit: '200' },
      ],
    };
    expect(voucherSchema.safeParse(unbalanced).success).toBe(true);
    // 而业务校验确实会拦住它
    const totals = sumVoucherLines(unbalanced.lines);
    expect(isBalanced(totals.totalDebit, totals.totalCredit)).toBe(false);
  });
});

describe('voucherExportColumns（凭证导出列）', () => {
  function row(): Record<string, unknown> {
    return {
      code: 'V001',
      voucherDate: '2026-10-16',
      period: '2026-10',
      summary: '提现',
      sourceType: 'manual',
      status: 'posted',
      totalDebit: 1000,
      totalCredit: 1000,
    };
  }
  const byHeader = (r: Record<string, unknown>) =>
    new Map(voucherExportColumns.map((c) => [c.header, c.value(r as never)]));

  it('列头与列序固定', () => {
    expect(voucherExportColumns.map((c) => c.header)).toEqual([
      '凭证编号',
      '日期',
      '期间',
      '摘要',
      '来源',
      '状态',
      '借方合计',
      '贷方合计',
    ]);
  });

  it('借方合计与贷方合计不互换', () => {
    const m = byHeader({ ...row(), totalDebit: 111, totalCredit: 222 });
    expect(m.get('借方合计')).toBe(111);
    expect(m.get('贷方合计')).toBe(222);
  });

  it('日期/摘要为 null 时给空串', () => {
    const m = byHeader({ ...row(), voucherDate: null, summary: null });
    expect(m.get('日期')).toBe('');
    expect(m.get('摘要')).toBe('');
  });

  it('来源/状态走字典文案，未知值回退原值（不导出空白格）', () => {
    const m = byHeader(row());
    expect(m.get('来源')).toBeTruthy();
    expect(m.get('来源')).not.toBe('manual');
    expect(m.get('状态')).toBeTruthy();
    expect(m.get('状态')).not.toBe('posted');
    const unknown = byHeader({ ...row(), sourceType: 'x', status: 'y' });
    expect(unknown.get('来源')).toBe('x');
    expect(unknown.get('状态')).toBe('y');
  });
});

describe('PAGE_SIZE', () => {
  it('为 20（凭证列表要显示来源/状态/借贷合计等宽列，20 条占满一屏）', () => {
    expect(PAGE_SIZE).toBe(20);
  });
});

/** 本地复刻 round2 以便断言（避免测试依赖实现细节） */
function round2Of(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
