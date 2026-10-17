import {
  EMPTY_FORM,
  parseSupplierRow,
  SUPPLIER_EXPORT_COLUMNS,
  SUPPLIER_IMPORT_COLUMNS,
  SUPPLIER_STATUS_LABELS,
  SUPPLIER_STATUS_TO_CODE,
  SUPPLIER_TYPE_LABELS,
  SUPPLIER_TYPE_TO_CODE,
  supplierSchema,
} from './supplier-import';
import type { Supplier } from '@shared/api.interface';

/**
 * 供应商 Excel 导入/导出纯逻辑规格（§5.9 / F8）。
 *
 * ## 为什么这是本页最值得测的模块
 *
 * `parseSupplierRow` 是供应商批量导入的**唯一闸门**：运营一次导几百行，
 * 它拦不住的错误会**批量落库**。而它的行为里有好几条"不测就不知道"的约定：
 *
 * | 约定 | 不测的后果 |
 * |---|---|
 * | 「类型」未知取值**报错**而不是静默用 `outsource` | "算力资源"被录成"外包服务"，分类与对账口径错 |
 * | 「状态」未知取值**报错**而不是静默用 `active` | 本该停用的供应商被启用，可继续用于新采购 |
 * | 「评级」非数字报错（`Number('4星')` → `NaN`） | `NaN` 走到 INSERT 由服务端 `numeric` 抛错，操作员看不到行号 |
 * | 有错时 `dto: null` | 上层拿半成品 DTO 去建供应商 |
 * | 导出列 `?? ''` | 收表人无法区分"空"与"漏填" |
 *
 * ## 本轮**没有**发现可修的缺陷（如实说明）
 *
 * 派单时提示重点查三类问题，逐条核对结论如下：
 *
 * ① **日期范围校验** —— 不适用：供应商主数据**没有任何日期列**
 *    （`SUPPLIER_IMPORT_COLUMNS` 8 列 / 导出 9 列全无日期字段），
 *    因此不存在 `employee-import.ts` 里"`2026-13-01` 通过正则直达 INSERT"
 *    那类风险面。下方用一条结构断言把它钉住：**导入列里永远不该冒出日期列**
 *    —— 一旦有人加了「合作起始日」之类，该断言会红，提醒补日历有效性校验。
 *
 * ② **未知枚举静默回退** —— 已正确：两个枚举列都是"有值但映射不到 → push 错误"，
 *    只有**留空**才用默认值。测试对"留空走默认"与"填错必报错"分别断言。
 *
 * ③ **导出列漏 `?? ''`** —— 「评级」列确实没有 `?? ''`，但**不是缺陷**：
 *    `Supplier.rating` 是非空 `number`，服务端 `mapSupplier` 用
 *    `Number(row.rating ?? 0)` 兜底、DB 列有 `default('0')`，`null` 在契约层
 *    不可达（见 `supplier-import.ts` 该列上方的注释）。它与"金额列可能为 null"
 *    的情况不同，属**有意的不对称**，因此这里注册成断言而不是"顺手改统一"。
 *
 * ## 测试数据的用意
 *
 * 导出列断言刻意用**每个字段都不同**的一行（编号 A、名称 B、联系人 C …），
 * 这样"`value` 取错字段"会立刻报红 —— 若都用 `'x'`，列错位在测试里也看不出来。
 */
describe('parseSupplierRow（供应商导入单行解析）', () => {
  /** 只填必填项的最小合法行 */
  const MINIMAL = { 名称: '甲公司' };

  describe('必填与默认值', () => {
    it('只有名称是必填，其余留空都通过', () => {
      const result = parseSupplierRow(MINIMAL);
      expect(result.errors).toEqual([]);
      expect(result.dto).not.toBeNull();
      expect(result.dto?.name).toBe('甲公司');
    });

    it('名称留空/全空格 → 报错且不返回 DTO', () => {
      for (const raw of [{}, { 名称: '' }, { 名称: '   ' }] as Array<
        Record<string, string>
      >) {
        const result = parseSupplierRow(raw);
        expect(result.errors).toContain('名称不能为空');
        expect(result.dto).toBeNull();
      }
    });

    it('名称两侧空格被 trim（Excel 里常有不可见空格）', () => {
      expect(parseSupplierRow({ 名称: '  乙公司  ' }).dto?.name).toBe('乙公司');
    });

    it('类型留空默认 outsource，状态留空默认 active', () => {
      const dto = parseSupplierRow(MINIMAL).dto;
      expect(dto?.type).toBe('outsource');
      expect(dto?.status).toBe('active');
    });

    it('评级留空默认 0（不是 undefined）', () => {
      const dto = parseSupplierRow(MINIMAL).dto;
      // 显式 0 而不是 undefined：服务端 `rating: String(dto.rating ?? 0)` 两种写法
      // 落库都是 0，但显式 0 让「未填」在 DTO 里可被断言
      expect(dto?.rating).toBe(0);
    });

    it('联系人/电话/银行账户/备注留空 → undefined（不是空串）', () => {
      const dto = parseSupplierRow(MINIMAL).dto;
      /*
       * 空串会被服务端当成"填了个空联系人"，undefined 才是"没填"。
       * 区别在 `updateSupplier` 上是可见的：`if (dto.contactName !== undefined)`
       * 决定该列是否被写入 —— 空串会**覆盖**成空值。
       */
      expect(dto?.contactName).toBeUndefined();
      expect(dto?.contactPhone).toBeUndefined();
      expect(dto?.bankAccount).toBeUndefined();
      expect(dto?.remark).toBeUndefined();
    });

    it('各文本列两侧空格被 trim 后再落 DTO', () => {
      const dto = parseSupplierRow({
        ...MINIMAL,
        联系人: ' 王五 ',
        联系电话: ' 13800000000 ',
        银行账户: ' 6222 0000 1111 2222 ',
        备注: ' 长期合作 ',
      }).dto;
      expect(dto?.contactName).toBe('王五');
      expect(dto?.contactPhone).toBe('13800000000');
      expect(dto?.bankAccount).toBe('6222 0000 1111 2222');
      expect(dto?.remark).toBe('长期合作');
    });

    it('银行账户里的空格**不被**压缩（账号分组空格有意义）', () => {
      // 账号常按 4 位分组书写，只 trim 首尾、不删中间空格
      expect(
        parseSupplierRow({ ...MINIMAL, 银行账户: '  6222 0000 1111  ' }).dto
          ?.bankAccount,
      ).toBe('6222 0000 1111');
    });
  });

  describe('类型：中英文双映射，未知取值必须报错', () => {
    it('中文标签被映射为代码（否则填表人按模板填中文会整表被拒）', () => {
      const cases: Array<[string, string]> = [
        ['外包服务', 'outsource'],
        ['算力资源', 'compute'],
        ['存储资源', 'storage'],
        ['工具软件', 'tool'],
        ['差旅服务', 'travel'],
        ['其他', 'other'],
      ];
      for (const [zh, code] of cases) {
        const result = parseSupplierRow({ ...MINIMAL, 类型: zh });
        expect(result.errors).toEqual([]);
        expect(result.dto?.type).toBe(code);
      }
    });

    it('英文代码原样通过（导出后再回导的场景）', () => {
      for (const code of [
        'outsource',
        'compute',
        'storage',
        'tool',
        'travel',
        'other',
      ]) {
        expect(parseSupplierRow({ ...MINIMAL, 类型: code }).dto?.type).toBe(code);
      }
    });

    it('未知类型 → **报错**，不用默认值（静默默认会录错分类）', () => {
      const result = parseSupplierRow({ ...MINIMAL, 类型: '云计算' });
      expect(result.errors).toContain(
        '类型「云计算」无效，应为 外包服务/算力资源/存储资源/工具软件/差旅服务/其他',
      );
      expect(result.dto).toBeNull();
      // 反例防线：不能因为映射不到就悄悄沿用默认值 outsource
      expect(result.dto?.type).toBeUndefined();
    });

    it('大小写/错别字敏感：`Compute`、`算力` 都不被接受（不猜映射意图）', () => {
      for (const bad of ['Compute', 'COMPUTE', '算力', '算力资源 ']) {
        const result = parseSupplierRow({ ...MINIMAL, 类型: bad });
        // 注意末项带尾空格 —— trim 后仍是 `算力资源`，应当**接受**
        if (bad === '算力资源 ') {
          expect(result.errors).toEqual([]);
          expect(result.dto?.type).toBe('compute');
        } else {
          expect(result.errors.length).toBeGreaterThan(0);
          expect(result.dto).toBeNull();
        }
      }
    });
  });

  describe('状态：中英文双映射，未知取值必须报错', () => {
    it('中文标签被映射为代码', () => {
      expect(parseSupplierRow({ ...MINIMAL, 状态: '合作中' }).dto?.status).toBe(
        'active',
      );
      expect(parseSupplierRow({ ...MINIMAL, 状态: '停用' }).dto?.status).toBe(
        'inactive',
      );
    });

    it('英文代码原样通过', () => {
      expect(parseSupplierRow({ ...MINIMAL, 状态: 'active' }).dto?.status).toBe(
        'active',
      );
      expect(parseSupplierRow({ ...MINIMAL, 状态: 'inactive' }).dto?.status).toBe(
        'inactive',
      );
    });

    it('未知状态 → 报错（静默 active 会让停用供应商被重新启用）', () => {
      const result = parseSupplierRow({ ...MINIMAL, 状态: '暂停合作' });
      expect(result.errors).toContain('状态「暂停合作」无效，应为 合作中/停用');
      expect(result.dto).toBeNull();
    });
  });

  describe('评级：数值范围与"非数字"', () => {
    it('0 与 5 是闭区间端点，都被接受', () => {
      for (const value of ['0', '5']) {
        const result = parseSupplierRow({ ...MINIMAL, 评级: value });
        expect(result.errors).toEqual([]);
        expect(result.dto?.rating).toBe(Number(value));
      }
    });

    it('区间内的小数被接受（0.5 步长的输入框可产出）', () => {
      for (const value of ['0.5', '3.5', '4.25']) {
        expect(parseSupplierRow({ ...MINIMAL, 评级: value }).dto?.rating).toBe(
          Number(value),
        );
      }
    });

    it('越界与非数字 → 报错且不返回 DTO', () => {
      for (const bad of ['-1', '5.5', '6', '100', '4星', '五', 'abc', 'NaN']) {
        const result = parseSupplierRow({ ...MINIMAL, 评级: bad });
        expect(result.errors).toContain('评级需为 0-5 的数字');
        expect(result.dto).toBeNull();
      }
    });

    it('Number("4星") 确实是 NaN —— 这才是必须用 isFinite 而不是「非零判断」的原因', () => {
      /*
       * 反例防线：若实现写成 `if (!parsed || parsed < 0)`，`'0'` 会被误判为非法
       * （`!0` 是 true），而 `NaN` 又要靠别的手段拦。这里把两个事实都钉住。
       */
      expect(Number.isNaN(Number('4星'))).toBe(true);
      expect(Number.isFinite(Number('abc'))).toBe(false);
      // 而 '0' 必须走"合法"分支
      expect(parseSupplierRow({ ...MINIMAL, 评级: '0' }).errors).toEqual([]);
    });

    it('评级是 number 类型（不是字符串）', () => {
      expect(typeof parseSupplierRow({ ...MINIMAL, 评级: '3.5' }).dto?.rating).toBe(
        'number',
      );
    });

    it('与 zod schema 的口径一致：schema 也是 min(0).max(5)', () => {
      // 两处门槛若不一致，同一个值会出现"表单放行 / 导入拒绝"或反之
      const base = { ...EMPTY_FORM, name: '甲公司', type: 'other' };
      expect(supplierSchema.safeParse({ ...base, rating: 0 }).success).toBe(true);
      expect(supplierSchema.safeParse({ ...base, rating: 5 }).success).toBe(true);
      expect(supplierSchema.safeParse({ ...base, rating: -0.5 }).success).toBe(false);
      expect(supplierSchema.safeParse({ ...base, rating: 5.5 }).success).toBe(false);
    });
  });

  describe('错误聚合：一次报全部问题而不是只报第一个', () => {
    it('多个字段同时出错时，errors 里全部列出', () => {
      const result = parseSupplierRow({
        名称: '',
        类型: '云计算',
        评级: 'A+',
        状态: '暂停',
      });
      expect(result.errors).toHaveLength(4);
      expect(result.errors).toEqual([
        '名称不能为空',
        '类型「云计算」无效，应为 外包服务/算力资源/存储资源/工具软件/差旅服务/其他',
        '评级需为 0-5 的数字',
        '状态「暂停」无效，应为 合作中/停用',
      ]);
      expect(result.dto).toBeNull();
    });

    it('有错时 dto 必须是 null（半成品 DTO 会被上层误用去建供应商）', () => {
      const result = parseSupplierRow({ 名称: '', 类型: '外包服务' });
      expect(result.dto).toBeNull();
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('无错时 errors 为空数组（不是 undefined）', () => {
      expect(parseSupplierRow(MINIMAL).errors).toEqual([]);
    });

    it('错误信息里带上原始输入（操作员要能定位是哪一格写错了）', () => {
      expect(parseSupplierRow({ ...MINIMAL, 类型: '云计算' }).errors[0]).toContain(
        '云计算',
      );
      expect(parseSupplierRow({ ...MINIMAL, 状态: '暂停' }).errors[0]).toContain(
        '暂停',
      );
    });
  });

  describe('必须报错但**不**报错的边界（如实登记，非缺陷）', () => {
    it('评级 `1e1` 被 JS 的 Number 解析为 10 → 越界报错（不是静默通过）', () => {
      /*
       * `Number('1e1') === 10`，落在 0-5 之外 —— 被范围检查拦住。
       * 真正需要留意的是 `1e0`（= 1）与 `0x3`（= 3）：它们**会**通过。
       * 这是 `Number()` 的既有语义，本轮保持行为不变（Excel 里的单元格
       * 不会产出这两种写法，属于"人工在表格里手打"的极端输入）。
       */
      expect(parseSupplierRow({ ...MINIMAL, 评级: '1e1' }).dto).toBeNull();
      expect(parseSupplierRow({ ...MINIMAL, 评级: '1e0' }).dto?.rating).toBe(1);
      expect(parseSupplierRow({ ...MINIMAL, 评级: '0x3' }).dto?.rating).toBe(3);
    });

    it('评级小数位不限制（客户端比服务端**宽松**，见下方契约对照）', () => {
      /*
       * 服务端 `CreateSupplierDto.rating` 是
       * `@IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(100)`，
       * 而这里只查 0-5 —— 也就是说 `4.999` 能过客户端、会被服务端 400 拒绝。
       *
       * 为什么**不**在这里补 `maxDecimalPlaces: 2`：那是把服务端校验复制到客户端，
       * 一旦两边漂移就会出现"客户端拦下服务端本可接受的值"。而这条路径的
       * 真实输入是 Excel 单元格，评级列只有 0-5（步长 0.5），且 UI 的
       * `<Input type="number" step={0.5}>` 也产不出 3 位小数。
       * 结论：**有意不改**，登记为"客户端宽松于服务端"的事实。
       */
      const result = parseSupplierRow({ ...MINIMAL, 评级: '4.999' });
      expect(result.errors).toEqual([]);
      expect(result.dto?.rating).toBe(4.999);
    });

    it('文本长度不设限（客户端宽于服务端 MaxLength）', () => {
      /*
       * 服务端：name ≤ 200、type ≤ 40、contactName ≤ 100、contactPhone ≤ 40、
       * bankAccount ≤ 64、remark ≤ 1000。这里一律不查长度 —— 超长值会由服务端
       * 返回 400，逐行导入时该行标红、其余行照常。**客户端更宽松是安全的**
       * （不会拒掉服务端本可接受的值）；反过来才是问题。
       */
      const longBank = '6'.repeat(65);
      const result = parseSupplierRow({ ...MINIMAL, 银行账户: longBank });
      expect(result.errors).toEqual([]);
      expect(result.dto?.bankAccount).toBe(longBank);
      expect(longBank).toHaveLength(65); // 服务端 bank_account 上限是 64
    });

    it('没有税务登记号 / 账期列 → 不存在"客户端校验与服务端 DTO 不一致"的面', () => {
      /*
       * 派单提示重点看 tax ID / 银行账户 / 账期。
       *  - 税务登记号：`CreateSupplierDto` **没有** taxNo/taxId 字段（只有
       *    `taxEntityId`，且它只能来自下拉框，Excel 导入根本不填）→ 无校验面。
       *  - 账期：供应商契约**没有**账期字段（账期在应付单据上）→ 无校验面。
       *  - 银行账户：见上一条，无长度/格式校验，服务端 `@MaxLength(64)` 兜底。
       */
      const dtoKeys = Object.keys(parseSupplierRow(MINIMAL).dto ?? {});
      expect(dtoKeys.sort()).toEqual(
        [
          'bankAccount',
          'contactName',
          'contactPhone',
          'name',
          'rating',
          'remark',
          'status',
          'type',
        ].sort(),
      );
      expect(dtoKeys).not.toContain('taxNo');
      expect(dtoKeys).not.toContain('taxEntityId');
      expect(dtoKeys).not.toContain('creditDays');
    });
  });
});

describe('供应商导入/导出列定义', () => {
  it('导入列头与解析器读取的键完全一致（改一处漏一处会导致整列读不到）', () => {
    const headers = SUPPLIER_IMPORT_COLUMNS.map((c) => c.header);
    expect(headers).toEqual([
      '名称',
      '类型',
      '联系人',
      '联系电话',
      '银行账户',
      '评级',
      '状态',
      '备注',
    ]);
    // 只有名称是必填
    expect(SUPPLIER_IMPORT_COLUMNS.filter((c) => c.required)).toHaveLength(1);
    expect(SUPPLIER_IMPORT_COLUMNS.find((c) => c.required)?.header).toBe('名称');
  });

  it('导入列里**没有日期列** —— 一旦加上就必须补日历有效性校验', () => {
    /*
     * `employee-import.ts` 的教训：日期列只用正则匹配会放过 `2026-13-01` /
     * `2026-02-31`，它们一路走到 INSERT，由 PostgreSQL 的 `date` 类型抛错 ——
     * HR 只看到"导入失败"，不知道是哪一行哪一列。
     *
     * 供应商契约当前没有日期字段，所以没有这个风险面。这条断言的作用是
     * **将来加日期列时会红**，提醒补 `Date.UTC` 回环校验（见 employee-import.ts）。
     */
    const dateLike = /日期|时间|年月|Date|Time/i;
    expect(SUPPLIER_IMPORT_COLUMNS.filter((c) => dateLike.test(c.header))).toEqual(
      [],
    );
    expect(
      SUPPLIER_EXPORT_COLUMNS.filter((c) => dateLike.test(c.header)),
    ).toEqual([]);
  });

  it('导出列头与列序固定', () => {
    expect(SUPPLIER_EXPORT_COLUMNS.map((c) => c.header)).toEqual([
      '编号',
      '名称',
      '类型',
      '联系人',
      '联系电话',
      '银行账户',
      '评级',
      '状态',
      '备注',
    ]);
  });

  it('每列**逐列**取到正确字段（用各字段互不相同的行，取错字段会立刻报红）', () => {
    /*
     * 「编号/名称」这类列错位在界面上完全看不出来：导出照样成功、Excel 照样打开，
     * 只是「联系人」列里显示的是电话。所以这里让 9 个字段的值两两不同。
     */
    const row = {
      id: 'id-1',
      code: 'SUP001',
      name: '甲公司',
      type: 'compute',
      contactName: '王五',
      contactPhone: '13800000000',
      bankAccount: '6222000011112222',
      rating: 4.5,
      status: 'inactive',
      remark: '长期合作',
      createdAt: '2026-10-16T00:00:00.000Z',
    } as unknown as Supplier;

    const cells = new Map(
      SUPPLIER_EXPORT_COLUMNS.map((col) => [col.header, col.value(row)]),
    );
    expect([...cells.keys()]).toEqual(SUPPLIER_EXPORT_COLUMNS.map((c) => c.header));
    expect(cells.get('编号')).toBe('SUP001');
    expect(cells.get('名称')).toBe('甲公司');
    expect(cells.get('类型')).toBe('算力资源'); // 字典文案，不是裸代码 compute
    expect(cells.get('联系人')).toBe('王五');
    expect(cells.get('联系电话')).toBe('13800000000');
    expect(cells.get('银行账户')).toBe('6222000011112222');
    expect(cells.get('评级')).toBe(4.5);
    expect(cells.get('状态')).toBe('停用'); // 字典文案，不是裸代码 inactive
    expect(cells.get('备注')).toBe('长期合作');
  });

  it('可空字段为 null 时给空串（不是 "null" 字符串）', () => {
    const row = {
      code: 'SUP002',
      name: '乙公司',
      type: null,
      contactName: null,
      contactPhone: null,
      bankAccount: null,
      rating: 0,
      status: 'active',
      remark: null,
    } as unknown as Supplier;
    const cells = new Map(
      SUPPLIER_EXPORT_COLUMNS.map((col) => [col.header, col.value(row)]),
    );
    expect(cells.get('类型')).toBe('');
    expect(cells.get('联系人')).toBe('');
    expect(cells.get('联系电话')).toBe('');
    expect(cells.get('银行账户')).toBe('');
    expect(cells.get('备注')).toBe('');
    // 反例防线：'' 而不是字符串 'null'
    expect(cells.get('联系人')).not.toBe('null');
  });

  it('导出「类型」用字典文案；未知代码回退原值（不导出空白格）', () => {
    const column = SUPPLIER_EXPORT_COLUMNS.find((c) => c.header === '类型');
    expect(column?.value({ type: 'compute' } as unknown as Supplier)).toBe(
      SUPPLIER_TYPE_LABELS.compute,
    );
    expect(column?.value({ type: 'weird' } as unknown as Supplier)).toBe('weird');
  });

  it('导出「状态」用字典文案；未知状态回退原值', () => {
    const column = SUPPLIER_EXPORT_COLUMNS.find((c) => c.header === '状态');
    expect(column?.value({ status: 'active' } as unknown as Supplier)).toBe(
      SUPPLIER_STATUS_LABELS.active,
    );
    expect(column?.value({ status: 'weird' } as unknown as Supplier)).toBe('weird');
  });

  it('**有意的不对称**：「评级」列没有 `?? \'\'`，因为契约保证它非空', () => {
    /*
     * 与同级其它列不同，这一列直接返回 `row.rating`。这不是漏写：
     *   · `Supplier.rating: number`（非 `number | null`）；
     *   · 服务端 `mapSupplier` → `rating: Number(row.rating ?? 0)`；
     *   · DB 列 `md_supplier.rating` 有 `default('0')`。
     * `null` 在契约层不可达，`?? ''` 是死代码。此断言把"返回 number"钉住 ——
     * 若有人改成 `row.rating ?? ''`，`typeof` 会变成 string，Excel 里「评级」
     * 会从可求和的数字变成文本。
     */
    const column = SUPPLIER_EXPORT_COLUMNS.find((c) => c.header === '评级');
    expect(column?.value({ rating: 0 } as unknown as Supplier)).toBe(0);
    expect(typeof column?.value({ rating: 3 } as unknown as Supplier)).toBe('number');
    // 与相邻列对照：可空列必须给出 ''（否则这条"不对称"就没有参照物）
    expect(
      SUPPLIER_EXPORT_COLUMNS.find((c) => c.header === '备注')?.value({
        remark: null,
      } as unknown as Supplier),
    ).toBe('');
  });
});

describe('导出 → 回导闭环', () => {
  it('导出值能原样喂回 parseSupplierRow 且映射回同一个状态/类型', () => {
    /*
     * 这是本文件最有价值的一条断言，也是"导出列与导入映射必须同源"的证明。
     *
     * 场景：运营导出供应商表 → 改几行 → 用导入功能回导。
     * 若导出的「类型」是中文而 `SUPPLIER_TYPE_TO_CODE` 没有这个词，回导整表被拒。
     * 这里按导出列取值 → 当作导入输入 → 断言解析器不报错且回到同一个代码。
     */
    for (const type of [
      'outsource',
      'compute',
      'storage',
      'tool',
      'travel',
      'other',
    ]) {
      for (const status of ['active', 'inactive']) {
        const supplier = {
          code: 'SUP001',
          name: '甲公司',
          type,
          contactName: '王五',
          contactPhone: '13800000000',
          bankAccount: '6222000011112222',
          rating: 4.5,
          status,
          remark: '长期合作',
        } as unknown as Supplier;

        const rawRow: Record<string, string> = {};
        for (const col of SUPPLIER_EXPORT_COLUMNS) {
          const value = col.value(supplier);
          if (value !== null && value !== undefined) {
            rawRow[col.header] = String(value);
          }
        }

        const result = parseSupplierRow(rawRow);
        expect(result.errors).toEqual([]);
        expect(result.dto?.name).toBe('甲公司');
        expect(result.dto?.type).toBe(type);
        expect(result.dto?.status).toBe(status);
        expect(result.dto?.rating).toBe(4.5);
        expect(result.dto?.contactName).toBe('王五');
        expect(result.dto?.bankAccount).toBe('6222000011112222');
      }
    }
  });

  it('导出列头是导入列头的**超集**（多出的「编号」在导入侧不存在）', () => {
    /*
     * 导出多一列「编号」而导入模板没有 —— 这是有意的：编号由服务端生成，
     * 回导时它会被解析器忽略（`parseSupplierRow` 从不读 `raw['编号']`）。
     * 这里显式登记该差异，免得有人"为了对称"把「编号」塞进导入模板，
     * 让填表人以为可以自选编号。
     */
    const importHeaders = new Set(SUPPLIER_IMPORT_COLUMNS.map((c) => c.header));
    const exportHeaders = SUPPLIER_EXPORT_COLUMNS.map((c) => c.header);
    const onlyInExport = exportHeaders.filter((h) => !importHeaders.has(h));
    expect(onlyInExport).toEqual(['编号']);
    expect(
      SUPPLIER_IMPORT_COLUMNS.map((c) => c.header).filter(
        (h) => !exportHeaders.includes(h),
      ),
    ).toEqual([]);

    // 多出的「编号」被解析器忽略：带着它也不会影响结果
    const withCode = parseSupplierRow({ 名称: '甲公司', 编号: 'SUP999' });
    expect(withCode.errors).toEqual([]);
    expect(withCode.dto).not.toHaveProperty('code');
  });
});

describe('映射表完整性（导出 → 回导的静态前提）', () => {
  it('每个代码都映射到自身', () => {
    for (const code of [
      'outsource',
      'compute',
      'storage',
      'tool',
      'travel',
      'other',
    ]) {
      expect(SUPPLIER_TYPE_TO_CODE[code]).toBe(code);
    }
    for (const code of ['active', 'inactive']) {
      expect(SUPPLIER_STATUS_TO_CODE[code]).toBe(code);
    }
  });

  it('每个中文标签都能映射到合法代码（漏一个就让那条路径整表被拒）', () => {
    const validTypes = new Set([
      'outsource',
      'compute',
      'storage',
      'tool',
      'travel',
      'other',
    ]);
    for (const zh of Object.values(SUPPLIER_TYPE_LABELS)) {
      expect(SUPPLIER_TYPE_TO_CODE[zh]).toBeTruthy();
      expect(validTypes.has(SUPPLIER_TYPE_TO_CODE[zh])).toBe(true);
    }
    const validStatuses = new Set(['active', 'inactive']);
    for (const zh of Object.values(SUPPLIER_STATUS_LABELS)) {
      expect(SUPPLIER_STATUS_TO_CODE[zh]).toBeTruthy();
      expect(validStatuses.has(SUPPLIER_STATUS_TO_CODE[zh])).toBe(true);
    }
    // 映射表的值必须全部是合法代码（不是随手写的字符串）
    for (const value of Object.values(SUPPLIER_TYPE_TO_CODE)) {
      expect(validTypes.has(value)).toBe(true);
    }
    for (const value of Object.values(SUPPLIER_STATUS_TO_CODE)) {
      expect(validStatuses.has(value)).toBe(true);
    }
  });

  it('对象展开生成的"中文→代码"是**反向**映射（不能写成同向）', () => {
    /*
     * `SUPPLIER_TYPE_TO_CODE` 用 `Object.fromEntries(Object.entries(LABELS).map(
     * ([code, zh]) => [zh, code]))` 生成反表 —— 顺序反了会得到 {外包服务: '外包服务'}，
     * 而这种错在类型上完全看不出来。逐条断言。
     */
    for (const [code, zh] of Object.entries(SUPPLIER_TYPE_LABELS)) {
      expect(SUPPLIER_TYPE_TO_CODE[zh]).toBe(code);
      expect(SUPPLIER_TYPE_TO_CODE[zh]).not.toBe(zh);
    }
  });

  it('标签表覆盖全部 6 种类型与 2 种状态（少一个下拉框就缺项）', () => {
    expect(Object.keys(SUPPLIER_TYPE_LABELS)).toEqual([
      'outsource',
      'compute',
      'storage',
      'tool',
      'travel',
      'other',
    ]);
    expect(Object.keys(SUPPLIER_STATUS_LABELS)).toEqual(['active', 'inactive']);
  });
});

describe('supplierSchema 与 EMPTY_FORM', () => {
  it('EMPTY_FORM 默认类型 outsource、状态 active、评级 0（与解析器默认值一致）', () => {
    // 若表单默认值与导入默认值不一致，同一份数据"手填"与"导入"会落成两种记录
    expect(EMPTY_FORM.type).toBe('outsource');
    expect(EMPTY_FORM.status).toBe('active');
    expect(EMPTY_FORM.rating).toBe(0);
  });

  it('EMPTY_FORM 只差必填项：schema 报且仅报 name（其余 9 个空串字段都放行）', () => {
    const parsed = supplierSchema.safeParse(EMPTY_FORM);
    expect(parsed.success).toBe(false); // name 为空 → 不通过
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.path.join('.'))).toEqual(['name']);
      expect(parsed.error.issues[0].message).toBe('供应商名称不能为空');
    }
  });

  it('名称必填、类型必填（两条中文报错文案固定）', () => {
    // 名称留空 → 只有 name 一项不过，文案固定
    const noName = supplierSchema.safeParse(EMPTY_FORM);
    expect(noName.success).toBe(false);
    expect(
      noName.success ? [] : noName.error.issues.map((i) => [i.path.join('.'), i.message]),
    ).toEqual([['name', '供应商名称不能为空']]);
    /*
     * 类型：`z.string().min(1)` 只在**传了空串**时才报错。
     * 注意 `EMPTY_FORM.type` 是 `'outsource'`，所以「清空类型」这条路在真实
     * 表单里不可达 —— `<Select>` 没有空选项，`openCreate`/`openEdit` 也都会
     * 给一个非空值。也就是说 `'请选择供应商类型'` 目前是**防御性文案**。
     * 这里如实登记：手动传空串才触发。
     */
    expect(supplierSchema.safeParse({ ...EMPTY_FORM, name: '甲公司' }).success).toBe(
      true,
    );
    const noType = supplierSchema.safeParse({
      ...EMPTY_FORM,
      name: '甲公司',
      type: '',
    });
    expect(noType.success).toBe(false);
    expect(
      noType.success ? [] : noType.error.issues.map((i) => [i.path.join('.'), i.message]),
    ).toEqual([['type', '请选择供应商类型']]);
    // 两项都填 → 通过
    const ok = supplierSchema.safeParse({
      ...EMPTY_FORM,
      name: '甲公司',
      type: 'compute',
    });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.name).toBe('甲公司');
  });

  it('名称的空白串**不**通过（zod `min(1)` 不 trim，空格长度是 1）', () => {
    /*
     * 如实登记：`z.string().min(1)` 只看长度，`'   '` 会通过 schema。
     * 但表单提交路径上不会出现这种值 —— 服务端 `@IsNotEmpty()` 也不 trim，
     * 二者口径一致。**这里不改**（改成 `.trim().min(1)` 会改变表单行为，
     * 与"纯重构零行为变更"冲突）；仅在导入侧，解析器已 `trim()` 后判空。
     */
    expect(supplierSchema.safeParse({ ...EMPTY_FORM, name: '   ', type: 'other' }).success).toBe(
      true,
    );
  });

  it('评级用 coerce：字符串 3.5 通过并转成 number（表单输入框给的是字符串）', () => {
    const result = supplierSchema.safeParse({
      ...EMPTY_FORM,
      name: '甲公司',
      type: 'other',
      rating: '3.5',
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.rating).toBe(3.5);
    expect(result.success && typeof result.data.rating).toBe('number');
  });

  it('评级 `\'\'` 被 coerce 成 0 并**通过**（清空输入框不会拦提交）', () => {
    /*
     * 如实登记一个容易踩的行为：`z.coerce.number()` 对 `''` 得到 `Number('') === 0`。
     * 于是"把评级删空"会以 0 提交，而不是报错。这是既有行为，本轮未改。
     */
    const result = supplierSchema.safeParse({
      ...EMPTY_FORM,
      name: '甲公司',
      type: 'other',
      rating: '',
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data.rating).toBe(0);
  });

  it('税务主体与税率在 schema 里都是普通字符串（空串代表"不指定"）', () => {
    // 组件提交时把 '' 转成 null（`data.taxEntityId || null`），schema 不做 UUID 校验
    expect(EMPTY_FORM.taxEntityId).toBe('');
    expect(EMPTY_FORM.defaultTaxRate).toBe('');
    const result = supplierSchema.safeParse({
      ...EMPTY_FORM,
      name: '甲公司',
      type: 'other',
      taxEntityId: 'not-a-uuid',
      defaultTaxRate: '6',
    });
    expect(result.success).toBe(true);
  });
});

describe('原型键安全性（继承属性不得被当作合法取值）', () => {
  it('**类型/状态传原型键必须被拒**', () => {
    /*
     * 与 customers/hr 的导入解析器同一缺陷类：`TABLE[key]` 会命中
     * `Object.prototype` 的继承属性，而它们都是真值，于是
     * `if (mapped) …` 被走通、不报错，并把**函数**塞进 DTO 字段。
     * 函数在 `JSON.stringify` 时被丢弃 → 服务端收到"没传" → 落库默认值。
     * 修复前实测 `errors=0`。
     */
    const PROTOTYPE_KEYS = [
      'constructor',
      'toString',
      'valueOf',
      'hasOwnProperty',
      'isPrototypeOf',
      'propertyIsEnumerable',
      '__proto__',
    ];
    for (const key of PROTOTYPE_KEYS) {
      const byType = parseSupplierRow({ 名称: '供应商甲', 类型: key });
      expect(byType.errors).toHaveLength(1);
      expect(byType.errors[0]).toContain('无效');
      expect(byType.dto).toBeNull();

      const byStatus = parseSupplierRow({ 名称: '供应商甲', 状态: key });
      expect(byStatus.errors).toHaveLength(1);
      expect(byStatus.errors[0]).toContain('无效');
      expect(byStatus.dto).toBeNull();
    }
  });

  it('合法取值仍照常通过（证明加固没有误伤正常路径）', () => {
    expect(parseSupplierRow({ 名称: '甲', 类型: '算力资源' }).errors).toEqual([]);
    expect(parseSupplierRow({ 名称: '甲', 状态: '停用' }).errors).toEqual([]);
    expect(parseSupplierRow({ 名称: '甲', 类型: 'outsource' }).errors).toEqual([]);
  });
});
