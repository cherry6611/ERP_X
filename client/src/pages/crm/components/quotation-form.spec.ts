import { round2 } from '@shared/number';
import {
  EMPTY_ITEM,
  MARGIN_RED_LINE,
  applySelectChange,
  buildQuotationPayload,
  computeQuotationTotals,
  isBelowMarginLine,
  quoteSchema,
  toNum,
  withRowKey,
  type QuotationItemRow,
  type QuotationRow,
} from './quotation-form';

/**
 * 报价单表单纯逻辑规格（§5.9 / F8）。
 *
 * ## 为什么这一块最该有单测
 *
 * 报价单的**报价总额 / 预估成本 / 毛利率**是这一页唯一"在浏览器里算出来的钱"，
 * 而算错了在界面上完全看不出来：不报错、不崩、typecheck / lint / 组件渲染都正常，
 * 只是那个数字与落库值不是同一个数。因此这里对**运算顺序**逐条断言 ——
 * 拆分重构时最容易发生的破坏正是"顺序被顺手改整齐"。
 *
 * ## 本文件钉住的四件事
 *
 * 1. **合计口径**：行折扣 → 整单折扣的施加顺序与浮点行为（`describe`①）；
 * 2. **与服务端口径的差异**（`describe`① 最后两条）：**现状记录**，
 *    不是"修好了"。详见 `./quotation-form.ts` 文件末的说明；
 * 3. **毛利红线边界**：恰好 20.00% **不**触发红字（`<` 而不是 `<=`），
 *    以及"总额为 0 时毛利率是 `null` 而不是 0"（界面显示 `-` 且不标红）；
 * 4. **行身份**：`withRowKey` 只复制、不改 `EMPTY_ITEM`，且两次调用生成的 key 不同
 *    （否则"删中间一行导致下面几行内容错位"的老问题会以另一种形式回来）。
 */

function row(patch: Partial<QuotationItemRow> = {}): QuotationRow {
  return withRowKey({ ...EMPTY_ITEM, ...patch });
}

/** 服务端口径的镜像（`server/modules/crm/quotation.service.ts` 的 `computeTotals`） */
function serverSideTotal(lines: QuotationRow[], headerDiscountPct: number): number {
  const factor = 1 - headerDiscountPct / 100;
  return round2(
    lines.reduce(
      (sum, item) =>
        sum + round2(item.quantity * item.unitPrice * (1 - item.discountPct / 100) * factor),
      0,
    ),
  );
}

describe('合计计算 computeQuotationTotals', () => {
  it('单行无折扣：总额 = 数量 × 单价，成本 = 数量 × 预估单位成本，毛利率 = (总额−成本)/总额', () => {
    const totals = computeQuotationTotals(
      [row({ quantity: 2, unitPrice: 100, estUnitCost: 60 })],
      0,
    );
    expect(totals.total).toBe(200);
    expect(totals.cost).toBe(120);
    expect(totals.marginPct).toBe(40);
  });

  it('行折扣逐行施加：行金额 = 数量 × 单价 × (1 − 行折扣/100)，再乘整单折扣', () => {
    const totals = computeQuotationTotals(
      [row({ quantity: 2, unitPrice: 100, discountPct: 10, estUnitCost: 60 })],
      50,
    );
    // 行金额 180，整单 5 折 → 90
    expect(totals.total).toBe(90);
    // 成本不参与任何折扣（原实现即如此：成本口径是"实打实的投入"）
    expect(totals.cost).toBe(120);
    /*
     * 毛利率改为**按取整后的合计与成本**计算，并保留两位 ——
     * 与服务端 `toQuotation` 的 `marginPct` 完全同式：
     *   Math.round(((totalAmount − estimatedCost) / totalAmount) · 10000) / 100
     * 原先这里断言未取整的 `-33.3333…`，与落库后列表/详情显示的毛利率不一致。
     */
    expect(totals.marginPct).toBe(-33.33);
  });

  it('多行：总额 = Σ行金额 × (1 − 整单折扣/100)（**先求和再打折**，现行客户端口径）', () => {
    const totals = computeQuotationTotals(
      [
        row({ quantity: 1, unitPrice: 100 }),
        row({ quantity: 3, unitPrice: 50 }),
        row({ quantity: 2, unitPrice: 25, discountPct: 20 }),
      ],
      10,
    );
    // 100 + 150 + 40 = 290 → ×0.9
    expect(totals.total).toBeCloseTo(261, 10);
    expect(totals.cost).toBe(0);
    expect(totals.marginPct).toBe(100);
  });

  it('总额为 0 时毛利率是 null（不是 0）：界面显示 `-`，且不触发红字', () => {
    const totals = computeQuotationTotals([row({ quantity: 1, unitPrice: 0 })], 0);
    expect(totals.total).toBe(0);
    expect(totals.marginPct).toBeNull();
    expect(isBelowMarginLine(totals.marginPct)).toBe(false);
  });

  it('成本高于总额时毛利率为负（会触发红字），不是 0、也不是 null', () => {
    const totals = computeQuotationTotals(
      [row({ quantity: 1, unitPrice: 100, estUnitCost: 200 })],
      0,
    );
    expect(totals.marginPct).toBe(-100);
    expect(isBelowMarginLine(totals.marginPct)).toBe(true);
  });

  it('整单折扣为空串（用户清空输入框）时按 0 处理，不产生 NaN', () => {
    const items = [row({ quantity: 2, unitPrice: 100 })];
    expect(computeQuotationTotals(items, '').total).toBe(200);
    expect(computeQuotationTotals(items, null).total).toBe(200);
    expect(computeQuotationTotals(items, undefined).total).toBe(200);
    expect(computeQuotationTotals(items, 0).total).toBe(200);
  });

  it('**多行 + 整单折扣时，预览必须与服务端落库口径逐分一致**', () => {
    /*
     * 这条用例原先叫「⚠️ 现状记录（未修）… 可差 0.01」，断言的是
     * 3 × 33.33 @ 整单 9 折 → 客户端 89.991（显示 89.99）/ 服务端 90.00。
     *
     * **现已修复**（T11 的客户端侧收尾）：`computeQuotationTotals` 改为与服务端
     * `quotation.service.ts#computeTotals` 完全同口径 ——
     * 逐行乘整单折扣、逐行 `round2`、再求和、最后再 `round2`。
     *
     * 为什么值得修（不只是"数字更整齐"）：
     *   · `crm_quotation.total_amount` 由服务端写入，**账不会错**；
     *   · 但**毛利红线提示基于预览值触发** —— 预览与落库差 1 分时，
     *     使用者会被一个不会生效的数字引导着改价；
     *   · 预览与落库不是同一个数，"预览"这个功能本身就没有意义。
     *
     * 下面用**服务端同款算法在测试内独立复算**再等值断言，而不是写死 `90`：
     * 写死只能证明"这次算对了"，复算才能证明"两边口径一致"
     * （将来任一侧改动都会让这条变红）。
     */
    const rows = [33.33, 33.33, 33.33].map((unitPrice) =>
      row({ quantity: 1, unitPrice }),
    );
    const client = computeQuotationTotals(rows, 10);
    const server = serverSideTotal(rows, 10);

    expect(server).toBe(90);
    // 预览 == 落库（原先差 1 分）
    expect(client.total).toBe(server);
    expect(round2(client.total)).toBe(90);

    // 单行报价本来就不存在差异，仍然一致（防止"为对齐而改坏单行"）
    const single = [row({ quantity: 1, unitPrice: 33.33 })];
    expect(round2(computeQuotationTotals(single, 10).total)).toBe(
      serverSideTotal(single, 10),
    );

    /*
     * 覆盖矩阵：多种单价集合 × 多种整单折扣，逐个断言"客户端 == 服务端复算"。
     * 这些组合里包含大量"不逐行取整就会差 1 分"的情形 ——
     * 若有人把实现改回一次性乘法，矩阵里会立刻有多个组合变红。
     */
    const priceSets: number[][] = [
      [33.33, 33.33, 33.33],
      [0.01, 0.01, 0.01],
      [99.99, 0.01],
      [1234.56, 789.01, 55.55],
      [10, 20, 30, 40],
      [1.005, 2.015, 3.025],
      [100],
      [],
    ];
    const discounts = [0, 7.5, 10, 33.3, 50, 99];
    let checked = 0;
    for (const prices of priceSets) {
      for (const disc of discounts) {
        const matrixRows = prices.map((unitPrice) =>
          row({ quantity: 1, unitPrice }),
        );
        expect(computeQuotationTotals(matrixRows, disc).total).toBe(
          serverSideTotal(matrixRows, disc),
        );
        checked += 1;
      }
    }
    // 防止矩阵被"顺手改小"而失去意义
    expect(checked).toBe(priceSets.length * discounts.length);  });

  it('口径矩阵：界面显示值与服务端逐行取整口径的差异**不超过本仓的取整容差** `0.01 × (行数 + 1)`', () => {
    /*
     * 容差取值与合同侧 `assertItemSum`（`contracts.service.ts`）一致：
     * 容忍逐行取整的尾数，但不容忍量级差。若哪天有人把客户端改成
     * "乘折扣但不取整且乘错基数"，差异会立刻超过这个容差而变红。
     */
    const violations: string[] = [];
    let checked = 0;
    for (const unitPrice of [0.01, 0.05, 7.77, 33.33, 99.99, 1234.56]) {
      for (const lineDiscountPct of [0, 7, 12.5, 33.33]) {
        const rows = [1, 2, 5].map((quantity) =>
          row({ quantity, unitPrice, discountPct: lineDiscountPct }),
        );
        for (const headerDiscountPct of [0, 10, 100]) {
          const client = round2(
            computeQuotationTotals(rows, headerDiscountPct).total,
          );
          const server = serverSideTotal(rows, headerDiscountPct);
          const gap = round2(Math.abs(client - server));
          const tolerance = 0.01 * (rows.length + 1);
          checked += 1;
          if (gap > tolerance) {
            violations.push(
              `${unitPrice} × ${lineDiscountPct}% 行折 × ${headerDiscountPct}% 整单 ⇒ 界面 ${client} vs 落库 ${server}（差 ${gap} > ${tolerance}）`,
            );
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(60);
    expect(violations).toEqual([]);
  });
});

describe('毛利红线 isBelowMarginLine / MARGIN_RED_LINE', () => {
  it('红线是 20%（改这个数必须是有意的）', () => {
    expect(MARGIN_RED_LINE).toBe(20);
  });

  it('恰好等于红线不算越线（`<` 而不是 `<=`）', () => {
    expect(isBelowMarginLine(20)).toBe(false);
    expect(isBelowMarginLine(20.0000001)).toBe(false);
    expect(isBelowMarginLine(19.9999999)).toBe(true);
  });

  it('毛利率为 null（总额 0 / 尚未填明细）时不算越线', () => {
    expect(isBelowMarginLine(null)).toBe(false);
  });

  it('负毛利（成本倒挂）算越线', () => {
    expect(isBelowMarginLine(-0.01)).toBe(true);
    expect(isBelowMarginLine(-100)).toBe(true);
  });
});

describe('toNum（明细行数字输入）', () => {
  it('空串按 0 处理（用户清空数量/单价时不至于得到 NaN）', () => {
    expect(toNum('')).toBe(0);
  });

  it('非有限数一律按 0 处理（Infinity / NaN / 乱码都不会漏进金额）', () => {
    expect(toNum('abc')).toBe(0);
    expect(toNum('Infinity')).toBe(0);
    expect(toNum('NaN')).toBe(0);
    expect(toNum('-')).toBe(0);
  });

  it('合法数字原样解析（含小数、负号与科学计数法）', () => {
    expect(toNum('1.5')).toBe(1.5);
    expect(toNum('1000')).toBe(1000);
    expect(toNum('-3')).toBe(-3);
    expect(toNum('1e3')).toBe(1000);
  });
});

describe('明细行身份 withRowKey / EMPTY_ITEM', () => {
  it('EMPTY_ITEM 是模板：本身不带 rowKey，也不会被 withRowKey 改写', () => {
    expect('rowKey' in EMPTY_ITEM).toBe(false);
    const first = withRowKey(EMPTY_ITEM);
    const second = withRowKey(EMPTY_ITEM);
    expect(first.rowKey).toBeTruthy();
    expect(second.rowKey).toBeTruthy();
    expect(first.rowKey).not.toBe(second.rowKey);
    expect('rowKey' in EMPTY_ITEM).toBe(false);
    // 新行默认值（人天 / 数量 1）必须原样带过来，否则新增明细行会是空数量
    expect(first.itemName).toBe('');
    expect(first.unit).toBe('人天');
    expect(first.quantity).toBe(1);
    expect(first.unitPrice).toBe(0);
    expect(first.discountPct).toBe(0);
    expect(first.estUnitCost).toBe(0);
    expect(first.remark).toBe('');
  });

  it('withRowKey 保留传入行的全部业务字段', () => {
    const keyed = withRowKey({
      itemName: '数据中台建设',
      unit: '项',
      quantity: 3,
      unitPrice: 12000.5,
      discountPct: 5,
      estUnitCost: 8000,
      remark: '含实施',
    });
    expect(keyed.itemName).toBe('数据中台建设');
    expect(keyed.unit).toBe('项');
    expect(keyed.quantity).toBe(3);
    expect(keyed.unitPrice).toBe(12000.5);
    expect(keyed.discountPct).toBe(5);
    expect(keyed.estUnitCost).toBe(8000);
    expect(keyed.remark).toBe('含实施');
  });
});

describe('quoteSchema（提交前的唯一闸门）', () => {
  const base = {
    title: '数据中台建设一期报价',
    customerId: 'c1',
    opportunityId: '',
    quoteDate: '2026-10-16',
    validUntil: '',
    discountPct: 0,
    remark: '',
  };

  it('标题与客户必填，报错文案即界面 toast 文案', () => {
    const noTitle = quoteSchema.safeParse({ ...base, title: '' });
    expect(noTitle.success).toBe(false);
    expect(noTitle.error?.issues[0]?.message).toBe('报价标题不能为空');

    const noCustomer = quoteSchema.safeParse({ ...base, customerId: '' });
    expect(noCustomer.success).toBe(false);
    expect(noCustomer.error?.issues[0]?.message).toBe('请选择客户');
  });

  it('整单折扣被强制成数字，且必须落在 0–100（含端点）', () => {
    const parsed = quoteSchema.safeParse({ ...base, discountPct: '50' });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.discountPct).toBe(50);

    expect(quoteSchema.safeParse({ ...base, discountPct: 0 }).success).toBe(true);
    expect(quoteSchema.safeParse({ ...base, discountPct: 100 }).success).toBe(true);
    expect(quoteSchema.safeParse({ ...base, discountPct: -1 }).success).toBe(false);
    expect(quoteSchema.safeParse({ ...base, discountPct: 101 }).success).toBe(false);
  });

  it('商机 / 日期可空，备注是必填字符串（表单始终会带上，故不构成阻塞）', () => {
    const parsed = quoteSchema.safeParse({
      ...base,
      opportunityId: '',
      quoteDate: undefined,
      validUntil: undefined,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.quoteDate).toBeUndefined();

    expect(quoteSchema.safeParse({ ...base, remark: undefined }).success).toBe(false);
  });
});

/* ── 本轮走查新钉住的两条（都是浏览器实测出来的真缺陷） ─────────────────── */

describe('applySelectChange —— Radix Select 的空值回调不得清掉已回填的值', () => {
  /**
   * 实测场景（`/crm/quotations/:id/edit`）：
   *   · `customers` 异步加载，首帧下拉里 0 个选项；
   *   · `form.reset` 已把 `customerId` 回填成服务端返回的 UUID；
   *   · Radix Select 因为找不到匹配的 `SelectItem`，主动回调 `onValueChange('')`；
   *   · 而 `onValueChange` 直接就是 `field.onChange` → 客户被抹成空串；
   *   · 结果：「保存修改」被必填校验拦住（"请选择客户"）且**不发请求**，
   *     使用者必须手动重选一次客户才能保存。
   */
  const SEEDED = 'ba85266d-19a8-407f-818c-a708fcaa59c9';

  it('allowEmpty=false：空值回调被忽略，保留已回填的客户', () => {
    expect(applySelectChange('', SEEDED, { allowEmpty: false })).toBe(SEEDED);
  });

  it('allowEmpty=false：真实选择正常写入', () => {
    expect(applySelectChange('c-2', SEEDED, { allowEmpty: false })).toBe('c-2');
  });

  it('allowEmpty=true：空值是有效语义（有「不指定」选项的场景）', () => {
    expect(applySelectChange('', SEEDED, { allowEmpty: true })).toBe('');
  });

  it('连续两次空值回调也不会把值弄丢（Radix 实测会回调多次）', () => {
    let value = SEEDED;
    value = applySelectChange('', value, { allowEmpty: false });
    value = applySelectChange('', value, { allowEmpty: false });
    expect(value).toBe(SEEDED);
  });
});

describe('buildQuotationPayload —— 编辑时"清空"必须真的发出去', () => {
  const values = {
    title: '报价A',
    customerId: 'c-1',
    opportunityId: '',
    quoteDate: '2026-10-16',
    validUntil: '',
    discountPct: 10,
    remark: '旧备注',
  };
  const items = [row({ itemName: '数据治理', quantity: 2, unitPrice: 10.05, discountPct: 10 })];

  it('新建：空的日期/备注用 undefined 省略（空串对 date 列是非法输入）', () => {
    const dto = buildQuotationPayload({ values, items, isEdit: false });
    expect(dto.validUntil).toBeUndefined();
    expect(dto.remark).toBe('旧备注');
  });

  it('编辑：清空备注 → 原样传空串（服务端 `|| null` 落成 NULL）；用 `|| undefined` 会静默丢弃', () => {
    const dto = buildQuotationPayload({
      values: { ...values, remark: '' },
      items,
      isEdit: true,
    });
    expect(dto.remark).toBe('');
  });

  it('编辑：清空有效期 → 原样传空串', () => {
    const dto = buildQuotationPayload({
      values: { ...values, validUntil: '' },
      items,
      isEdit: true,
    });
    expect(dto.validUntil).toBe('');
  });

  it('明细行按表单值取整构造，itemName 去空格', () => {
    const dto = buildQuotationPayload({ values, items, isEdit: false });
    expect(dto.items).toHaveLength(1);
    expect(dto.items[0].itemName).toBe('数据治理');
    expect(dto.items[0].quantity).toBe(2);
    expect(dto.items[0].discountPct).toBe(10);
  });

  it('未关联商机时不传 opportunityId（避免把空串当 UUID 校验）', () => {
    const dto = buildQuotationPayload({ values, items, isEdit: true });
    expect('opportunityId' in dto).toBe(false);
  });

  it('关联了商机时透传', () => {
    const dto = buildQuotationPayload({
      values: { ...values, opportunityId: 'o-9' },
      items,
      isEdit: true,
    });
    expect(dto.opportunityId).toBe('o-9');
  });
});
