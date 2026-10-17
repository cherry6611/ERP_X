import {
  CUSTOMER_EMPTY_FORM,
  CUSTOMER_EXPORT_COLUMNS,
  CUSTOMER_IMPORT_COLUMNS,
  CUSTOMER_STATUS_LABELS,
  CUSTOMER_STATUS_TO_CODE,
  customerImportRowKey,
  customerSchema,
  parseCustomerRow,
} from './customer-import';
import type { Customer } from '@shared/api.interface';

/**
 * 客户 Excel 导入 / 导出的规格（§5.9 / F8）。
 *
 * ## 为什么这是客户域最值得测的纯逻辑
 *
 * `parseCustomerRow` 是客户批量导入的**唯一闸门**：一次导入几百行，它拦不住的错误
 * 会**批量落库**（清理成本随行数线性增长），而它的几条约定"不测就不知道"：
 *
 * | 约定 | 不测的后果 |
 * |---|---|
 * | 未知信用等级/状态**报错**而不是用默认值 | 静默默认会把写错的状态录成另一个状态，而操作员看到"导入成功" |
 * | 映射表查表必须判**自有键** | `CUSTOMER_STATUS_TO_CODE['constructor']` 是真值（`[Function: Object]`），会当成合法状态放行 |
 * | 必填名称 trim 后判空 | Excel 里"看起来有字"的单元格常是全空格 |
 * | 有错时 `dto: null` | 上层会拿半成品 DTO 去建客户 |
 * | 导出列取对字段 | 界面上完全看不出来：导出照样成功，只是数字落在错的列里 |
 * | 导出→回导闭环 | 状态导出成中文、回导只认代码时整表被拒 |
 *
 * ## 为什么没有日期断言
 *
 * 本页的导入模板**没有日期列**（员工导入踩过的"`2026-13-01` / `2026-02-31` 只过正则、
 * 不过日历"那个坑在这里不存在）。这里不是省略，而是 **N/A** —— 仍然留了一条守卫断言：
 * 一旦有人给模板加日期列，它会红，提醒补上"月/日范围 + 闰年"校验。
 * 同一套"边界值 + 相邻越界值"的纪律用在了**账期 0/365** 与**信用额度**上。
 *
 * ## 测试数据的用意
 *
 * 1. `makeCustomer()` 的每个字段取值**互不相同**（名称/行业/等级/额度/账期/状态/备注
 *    各是一个值）。这样"某一列取错了字段"必然断言失败，而不是碰巧取到同值而通过。
 * 2. 导出列断言用**整表比对**（`Object.fromEntries` + `toEqual`），而不是逐列 `expect`：
 *    漏一列、多一列、列序错都能被抓住。
 */
function makeCustomer(overrides: Partial<Customer> = {}): Customer {
  return {
    id: 'cust-0001',
    code: 'CUS2026100001',
    name: '晟笙测试客户',
    uscc: '91310000MA1FL0XXXX',
    industry: '金融',
    creditLevel: 'C',
    creditLimit: 123456.78,
    termsDays: 45,
    status: 'inactive',
    remark: '回导备注',
    taxEntityId: null,
    defaultTaxRate: null,
    createdAt: '2026-10-16T00:00:00.000Z',
    ...overrides,
  };
}

/** 只填必填项的最小合法行 */
const MINIMAL = { 名称: '张三' };

/** 把导出列跑成一个"原始单元格行"，与 `parseXlsxFirstSheet` 的产物同形（值都转字符串） */
function exportToRawRow(row: Customer): Record<string, string> {
  const raw: Record<string, string> = {};
  for (const column of CUSTOMER_EXPORT_COLUMNS) {
    const value = column.value(row);
    if (value !== null && value !== undefined) raw[column.header] = String(value);
  }
  return raw;
}

describe('parseCustomerRow（客户导入单行解析）', () => {
  describe('必填项与默认值', () => {
    it('只有名称是必填，其余留空都通过且用默认值 B / 30 / prospect', () => {
      const result = parseCustomerRow(MINIMAL);
      expect(result.errors).toEqual([]);
      expect(result.dto).not.toBeNull();
      expect(result.dto?.name).toBe('张三');
      expect(result.dto?.creditLevel).toBe('B');
      expect(result.dto?.creditLimit).toBe(0);
      expect(result.dto?.termsDays).toBe(30);
      expect(result.dto?.status).toBe('prospect');
    });

    it('名称留空 / 全空格 / 单元格缺失 → 报错且不返回 DTO', () => {
      for (const raw of [{}, { 名称: '' }, { 名称: '   ' }, { 名称: '\t\n ' }] as Array<
        Record<string, string>
      >) {
        const result = parseCustomerRow(raw);
        expect(result.errors).toContain('名称不能为空');
        expect(result.dto).toBeNull();
      }
    });

    it('所有文本列两侧空格都被 trim（Excel 里常有不可见空格）', () => {
      const dto = parseCustomerRow({
        名称: '  李四  ',
        统一社会信用代码: ' 91310000MA1FL0XXXX ',
        行业: ' 制造 ',
        信用等级: ' a ',
        信用额度: ' 100 ',
        '账期（天）': ' 45 ',
        状态: ' 合作中 ',
        备注: ' 备注 ',
      }).dto;
      expect(dto?.name).toBe('李四');
      expect(dto?.uscc).toBe('91310000MA1FL0XXXX');
      expect(dto?.industry).toBe('制造');
      expect(dto?.creditLevel).toBe('A');
      expect(dto?.creditLimit).toBe(100);
      expect(dto?.termsDays).toBe(45);
      expect(dto?.status).toBe('active');
      expect(dto?.remark).toBe('备注');
    });

    it('留空的非必填文本列 → undefined（不是空串），且不报错', () => {
      const result = parseCustomerRow(MINIMAL);
      expect(result.errors).toEqual([]);
      // 空串会被服务端当成"填了个空值"，undefined 才是"没填"
      expect(result.dto?.uscc).toBeUndefined();
      expect(result.dto?.industry).toBeUndefined();
      expect(result.dto?.remark).toBeUndefined();
    });

    it('DTO 的键固定为导入模板的 8 列，不多带 taxEntityId 等表单字段', () => {
      const dto = parseCustomerRow({ ...MINIMAL, 状态: 'active', 备注: 'x' }).dto;
      // 导入不负责纳税主体/默认税率（那是表单的字段），不能凭空塞进 DTO
      expect(dto).not.toHaveProperty('taxEntityId');
      expect(dto).not.toHaveProperty('defaultTaxRate');
      expect(Object.keys(dto as object).sort()).toEqual([
        'creditLevel',
        'creditLimit',
        'industry',
        'name',
        'remark',
        'status',
        'termsDays',
        'uscc',
      ]);
    });
  });

  describe('信用等级：白名单 + 大小写归一', () => {
    it('A / B / C 通过（小写也归一成大写，导出回导时手改过大小写不会整行被拒）', () => {
      for (const [input, expected] of [
        ['A', 'A'],
        ['b', 'B'],
        ['c', 'C'],
      ] as Array<[string, string]>) {
        const result = parseCustomerRow({ ...MINIMAL, 信用等级: input });
        expect(result.errors).toEqual([]);
        expect(result.dto?.creditLevel).toBe(expected);
      }
    });

    it('白名单外的取值 → **报错**，不静默用默认值 B（静默默认会改客户信用等级）', () => {
      for (const bad of ['D', 'AA', '甲级', '优秀', '1']) {
        const result = parseCustomerRow({ ...MINIMAL, 信用等级: bad });
        expect(result.errors).toContain(`信用等级「${bad}」无效，只能为 A、B、C`);
        expect(result.dto).toBeNull();
      }
    });

    it('留空 → 默认 B 且**不报错**（与表单默认值同源，见 CUSTOMER_EMPTY_FORM）', () => {
      const result = parseCustomerRow({ ...MINIMAL, 信用等级: '   ' });
      expect(result.errors).toEqual([]);
      expect(result.dto?.creditLevel).toBe(CUSTOMER_EMPTY_FORM.creditLevel);
    });
  });

  describe('状态：中英文双映射', () => {
    it('中文取值被映射为代码（操作员按模板填中文，"合作中"不能整行被拒）', () => {
      for (const [input, expected] of [
        ['合作中', 'active'],
        ['停用', 'inactive'],
        ['潜在客户', 'prospect'],
      ] as Array<[string, string]>) {
        const result = parseCustomerRow({ ...MINIMAL, 状态: input });
        expect(result.errors).toEqual([]);
        expect(result.dto?.status).toBe(expected);
      }
    });

    it('英文代码取值原样通过（导出后手工改成代码再回导的场景）', () => {
      for (const code of ['active', 'inactive', 'prospect']) {
        expect(parseCustomerRow({ ...MINIMAL, 状态: code }).dto?.status).toBe(code);
      }
    });

    it('未知状态 → **报错**，不用默认值（静默默认会把停用录成潜在客户）', () => {
      const result = parseCustomerRow({ ...MINIMAL, 状态: '冻结' });
      expect(result.errors).toContain('状态「冻结」无效，应为 合作中/停用/潜在客户');
      expect(result.dto).toBeNull();
    });

    it('大小写敏感：`ACTIVE` / `Active` 都不被接受（避免猜映射意图）', () => {
      for (const bad of ['ACTIVE', 'Active', 'PROSPECT']) {
        const result = parseCustomerRow({ ...MINIMAL, 状态: bad });
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.dto).toBeNull();
      }
    });

    it('⚠️ 自有键之外的原型键不能当成合法状态放行（本轮修复的真实缺陷）', () => {
      /*
       * 原实现是 `const mapped = CUSTOMER_STATUS_TO_CODE[statusRaw]`，
       * 而 `Record<string, string>` 的字面量在运行期仍是普通对象：
       * 继承自 `Object.prototype` 的键会被查出来且**都是真值**。
       *
       * 危害链（每一步都能单独验证）：
       *   ① 解析器返回 `status = [Function: Object]`，而
       *      `ParsedResult<CreateCustomerDto>` 声明的是 `status?: string`；
       *   ② axios `post` 序列化请求体时 `JSON.stringify({status: [Function]})` → `{}`，
       *      函数值被整个丢弃；
       *   ③ 服务端 `status` 是 `@IsOptional() @IsString()`，收到 undefined 视为没填；
       *   ④ `master-data.service.ts` 回落 `dto.status ?? 'active'` → 客户被建成"合作中"。
       * 全程 0 条错误，操作员看到的却是"导入成功"。
       */
      const protoKeys = [
        'constructor',
        'toString',
        'valueOf',
        'hasOwnProperty',
        'isPrototypeOf',
        'propertyIsEnumerable',
        '__proto__',
      ];
      for (const bad of protoKeys) {
        const result = parseCustomerRow({ ...MINIMAL, 状态: bad });
        expect(result.errors).toContain(`状态「${bad}」无效，应为 合作中/停用/潜在客户`);
        expect(result.dto).toBeNull();
      }
      // 反例防线：证明这些键在普通查表下**确实是真值**（即上面那条不是空跑）
      expect(
        (CUSTOMER_STATUS_TO_CODE as Record<string, unknown>)['constructor'],
      ).toBeTruthy();
      expect(typeof CUSTOMER_STATUS_TO_CODE['constructor']).not.toBe('string');
    });
  });

  describe('信用额度：非负数字', () => {
    it('合法数字原样通过（含 0 与小数）', () => {
      for (const [input, expected] of [
        ['0', 0],
        ['0.01', 0.01],
        ['123456.78', 123456.78],
        ['100 ', 100],
      ] as Array<[string, number]>) {
        const result = parseCustomerRow({ ...MINIMAL, 信用额度: input });
        expect(result.errors).toEqual([]);
        expect(result.dto?.creditLimit).toBe(expected);
      }
    });

    it('留空 → 0（与数据库列默认值/表单默认值一致），不报错', () => {
      const result = parseCustomerRow({ ...MINIMAL, 信用额度: '  ' });
      expect(result.errors).toEqual([]);
      expect(result.dto?.creditLimit).toBe(0);
      expect(result.dto?.creditLimit).toBe(CUSTOMER_EMPTY_FORM.creditLimit);
    });

    it('负数 / 非数字 / 逗号千分位 → 报错且不返回 DTO', () => {
      for (const bad of ['-1', '-0.01', 'abc', '1,000', '1 000', '一百', 'Infinity', 'NaN']) {
        const result = parseCustomerRow({ ...MINIMAL, 信用额度: bad });
        expect(result.errors).toContain('信用额度需为不小于 0 的数字');
        expect(result.dto).toBeNull();
      }
    });

    it('用 Number() 而不是 parseFloat：`100abc` 必须报错（parseFloat 会静默取 100）', () => {
      const result = parseCustomerRow({ ...MINIMAL, 信用额度: '100abc' });
      expect(result.errors).toContain('信用额度需为不小于 0 的数字');
      // parseFloat('100abc') === 100，这就是不能用它解析金额的原因
      expect(Number.parseFloat('100abc')).toBe(100);
      expect(Number('100abc')).toBeNaN();
    });
  });

  describe('账期：0-365 的整数（把日期类的"边界 + 相邻越界"纪律用在这里）', () => {
    it('边界值 0 / 1 / 365 通过，相邻越界值 -1 / 366 / 1000 被拒', () => {
      for (const [input, expected] of [
        ['0', 0],
        ['1', 1],
        ['30', 30],
        ['365', 365],
      ] as Array<[string, number]>) {
        const result = parseCustomerRow({ ...MINIMAL, '账期（天）': input });
        expect(result.errors).toEqual([]);
        expect(result.dto?.termsDays).toBe(expected);
      }
      for (const bad of ['-1', '366', '1000']) {
        const result = parseCustomerRow({ ...MINIMAL, '账期（天）': bad });
        expect(result.errors).toContain('账期需为 0-365 的整数');
        expect(result.dto).toBeNull();
      }
    });

    it('必须是整数：非整数与文本都报错', () => {
      for (const bad of ['30.5', '0.1', 'abc', '', '  ', '三十']) {
        const result = parseCustomerRow({ ...MINIMAL, '账期（天）': bad });
        if (bad.trim() === '') {
          // 空 → 走默认 30（与"写错"区分开）
          expect(result.errors).toEqual([]);
          expect(result.dto?.termsDays).toBe(30);
        } else {
          expect(result.errors).toContain('账期需为 0-365 的整数');
          expect(result.dto).toBeNull();
        }
      }
    });

    it('`30.0` 这类"数值型文本"必须被接受（所以不能用 /^\\d+$/ 去卡）', () => {
      const result = parseCustomerRow({ ...MINIMAL, '账期（天）': '30.0' });
      expect(result.errors).toEqual([]);
      expect(result.dto?.termsDays).toBe(30);
    });

    it('登记两处 Number() 语义带来的宽松（有意保留，不是漏校验）', () => {
      /*
       * `Number()` 认十六进制与科学计数法。Excel 正常不会产出这两种写法，
       * 而换成 `/^\d+$/` 会连 `30.0` 一起拒掉（见上一条）—— 所以保留现状，
       * 这里把它们**显式登记**下来：改行为的人会看到这两条断言并必须解释。
       */
      expect(parseCustomerRow({ ...MINIMAL, '账期（天）': '0x10' }).dto?.termsDays).toBe(16);
      expect(parseCustomerRow({ ...MINIMAL, '账期（天）': '1e2' }).dto?.termsDays).toBe(100);
    });
  });

  describe('错误聚合与 null 载荷', () => {
    it('一行里多个格子同时写错时，errors 一次列出全部', () => {
      const result = parseCustomerRow({
        名称: '',
        信用等级: 'D',
        信用额度: '-5',
        '账期（天）': '400',
        状态: '冻结',
      });
      expect(result.errors).toHaveLength(5);
      expect(result.errors).toEqual([
        '名称不能为空',
        '信用等级「D」无效，只能为 A、B、C',
        '信用额度需为不小于 0 的数字',
        '账期需为 0-365 的整数',
        '状态「冻结」无效，应为 合作中/停用/潜在客户',
      ]);
    });

    it('有错时 dto 必须是 null（半成品 DTO 会被上层误用去建客户）', () => {
      const result = parseCustomerRow({ 名称: '张三', 状态: '冻结' });
      expect(result.dto).toBeNull();
      // 反例防线：不能"顺手"把已经解析好的字段带出来
      expect(result.dto).toBeNull();
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('无错时 errors 是空数组（不是 undefined），且只有一个元素也不遗漏', () => {
      expect(parseCustomerRow(MINIMAL).errors).toEqual([]);
      const single = parseCustomerRow({ 名称: '张三', 状态: '冻结' });
      expect(single.errors).toHaveLength(1);
    });
  });

  describe('日期字段：本页导入没有日期列（同类缺陷 N/A，留守卫）', () => {
    it('模板里没有任何日期/时间列 —— 因此"只匹配正则、不校验日历"那类缺陷在本页不存在', () => {
      /*
       * 员工导入（`parseEmployeeRow`）就是在这里踩过坑：`2026-13-01` 与 `2026-02-31`
       * 能过 `/^(\d{4})-(\d{1,2})-(\d{1,2})$/`，一路走到 INSERT 才由 PostgreSQL 的
       * `date` 抛错，操作员只看到"导入失败"、不知道是哪一行哪一列。
       * 客户导入**没有日期列**，所以那段日历校验在这里没有对应物 —— 这条断言是守卫：
       * 谁将来加了日期列，它会红，提醒把"月/日范围 + 闰年回环"补上。
       */
      const dateish = CUSTOMER_IMPORT_COLUMNS.filter((column) =>
        /日期|时间|date|time/i.test(column.header),
      );
      expect(dateish).toEqual([]);
    });

    it('文件里多出来的列被忽略：坏日期既不会被校验、也不会进 DTO', () => {
      // 导出的表格里就有一列「编号」（导入模板没有），这条同时证明了多余列被忽略
      const result = parseCustomerRow({
        名称: '冗余列测试',
        编号: 'CUS2026100001',
        签约日期: '2026-02-31',
      });
      expect(result.errors).toEqual([]);
      expect(result.dto?.name).toBe('冗余列测试');
      expect(Object.keys(result.dto as object)).not.toContain('签约日期');
    });
  });

  describe('customerImportRowKey（导入判重键）', () => {
    it('取 trim 过的名称，与页面 existingKeys 的算法一致', () => {
      // 页面里 existingKeys = data.items.map(row => row.name.trim())
      // 两边算法不一致会造成"列表里已有，导入却说没重复" → 同一个客户被建两次
      expect(customerImportRowKey({ 名称: '  张三  ' })).toBe('张三');
      expect(customerImportRowKey({ 名称: '张三' })).toBe('张三');
      expect(customerImportRowKey({ 名称: '  张三  ' })).toBe('张三'.trim());
    });

    it('名称为空/缺失 → 空串（约定：空串表示无法判重，交给解析器报"名称不能为空"）', () => {
      expect(customerImportRowKey({})).toBe('');
      expect(customerImportRowKey({ 名称: '   ' })).toBe('');
    });
  });
});

describe('客户导入 / 导出列定义', () => {
  it('导入列头与列序固定，且只有名称是必填', () => {
    expect(CUSTOMER_IMPORT_COLUMNS.map((column) => column.header)).toEqual([
      '名称',
      '统一社会信用代码',
      '行业',
      '信用等级',
      '信用额度',
      '账期（天）',
      '状态',
      '备注',
    ]);
    expect(CUSTOMER_IMPORT_COLUMNS.filter((column) => column.required)).toHaveLength(1);
    expect(CUSTOMER_IMPORT_COLUMNS.find((column) => column.required)?.header).toBe('名称');
  });

  it('模板的每一列都被解析器读取（漏一列会让那一列静默读成空）', () => {
    // 用「所有列都填不同值」的一行反证：每个列头都必须出现在解析结果里
    const dto = parseCustomerRow({
      名称: '全列客户',
      统一社会信用代码: 'USCC-ALL',
      行业: 'INDUSTRY-ALL',
      信用等级: 'A',
      信用额度: '11',
      '账期（天）': '22',
      状态: '停用',
      备注: 'REMARK-ALL',
    }).dto;
    expect(dto).toEqual({
      name: '全列客户',
      uscc: 'USCC-ALL',
      industry: 'INDUSTRY-ALL',
      creditLevel: 'A',
      creditLimit: 11,
      termsDays: 22,
      status: 'inactive',
      remark: 'REMARK-ALL',
    });
  });

  it('导出列头与列序固定', () => {
    expect(CUSTOMER_EXPORT_COLUMNS.map((column) => column.header)).toEqual([
      '编号',
      '名称',
      '统一社会信用代码',
      '行业',
      '信用等级',
      '信用额度',
      '账期（天）',
      '状态',
      '备注',
    ]);
  });

  it('导出列**逐列取值**（整表比对：取错字段/漏列/列序错都会红）', () => {
    // makeCustomer() 的每个字段取值互不相同，取错字段必然失败
    const exported = Object.fromEntries(
      CUSTOMER_EXPORT_COLUMNS.map((column) => [column.header, column.value(makeCustomer())]),
    );
    expect(exported).toEqual({
      编号: 'CUS2026100001',
      名称: '晟笙测试客户',
      统一社会信用代码: '91310000MA1FL0XXXX',
      行业: '金融',
      信用等级: 'C',
      信用额度: 123456.78,
      '账期（天）': 45,
      状态: '停用',
      备注: '回导备注',
    });
  });

  it('导出可空字段为 null 时给空串（不是 "null" 字符串、也不是 undefined）', () => {
    const empty = makeCustomer({
      uscc: null,
      industry: null,
      creditLevel: null,
      remark: null,
    });
    const exported = Object.fromEntries(
      CUSTOMER_EXPORT_COLUMNS.map((column) => [column.header, column.value(empty)]),
    );
    expect(exported['统一社会信用代码']).toBe('');
    expect(exported['行业']).toBe('');
    expect(exported['信用等级']).toBe('');
    expect(exported['备注']).toBe('');
  });

  it('登记一处**有意的不对称**：编号/信用额度/账期三列没有 `?? \'\'`', () => {
    /*
     * `Customer` 契约里 `code: string`、`creditLimit: number`、`termsDays: number`
     * 都**非空**（`shared/api.interface.ts`；服务端 `toCustomer` 也做了
     * `Number(row.creditLimit ?? 0)` / `row.termsDays ?? 30`）。
     * 所以这三列不是"漏写兜底"，而是**不该**写：写了会把"契约保证不为空"这件事掩盖掉。
     *
     * 真出现 null 时也不会导出坏值 —— 最后一道兜底在导出器里统一做：
     * `excel-utils.ts` 的 `exportRowsToXlsx`：`cell === null || cell === undefined ? '' : cell`。
     * 这里断言"列定义不自己造值"（把契约外的 null 原样透出，交给导出器兜底）。
     */
    const poked = { ...makeCustomer(), creditLimit: null, termsDays: null } as unknown as Customer;
    const exported = Object.fromEntries(
      CUSTOMER_EXPORT_COLUMNS.map((column) => [column.header, column.value(poked)]),
    );
    expect(exported['信用额度']).toBeNull();
    expect(exported['账期（天）']).toBeNull();
    // 与"字符串化"区分开：不能是 'null' 这种能被接收方误读成数据的东西
    expect(exported['信用额度']).not.toBe('null');
    expect(exported['账期（天）']).not.toBe('null');
  });

  it('导出「状态」用字典文案；字典外的代码回退原值（不导出空白格）', () => {
    const column = CUSTOMER_EXPORT_COLUMNS.find((item) => item.header === '状态');
    expect(column?.value(makeCustomer({ status: 'active' }))).toBe(CUSTOMER_STATUS_LABELS.active);
    expect(column?.value(makeCustomer({ status: 'suspended' }))).toBe('suspended');
  });

  it('**导出 → 回导闭环**：导出值能被同一个解析器接受并映射回同一份数据', () => {
    /*
     * 这是本文件最有价值的一条断言，也是"导出列与导入映射必须同源"的证明。
     * 场景：操作员导出客户表 → 改几行 → 用导入功能回导。
     * 只要有一列导出成解析器不认的形态，回导就会整表被拒（而导出看起来完全正常）。
     */
    const rawRow = exportToRawRow(makeCustomer());
    // 导出表里有「编号」这一列，导入模板没有 —— 回导必须忽略它而不是报错
    expect(Object.keys(rawRow)).toContain('编号');

    const result = parseCustomerRow(rawRow);
    expect(result.errors).toEqual([]);
    expect(result.dto).toEqual({
      name: '晟笙测试客户',
      uscc: '91310000MA1FL0XXXX',
      industry: '金融',
      creditLevel: 'C',
      creditLimit: 123456.78,
      termsDays: 45,
      status: 'inactive',
      remark: '回导备注',
    });
  });

  it('闭环对三个状态都成立（导出的中文必须都能映射回代码）', () => {
    for (const status of ['active', 'inactive', 'prospect']) {
      const result = parseCustomerRow(exportToRawRow(makeCustomer({ status })));
      expect(result.errors).toEqual([]);
      expect(result.dto?.status).toBe(status);
    }
  });

  it('闭环对空可空字段成立（导出的空串回导后仍是 undefined，而不是空串/null）', () => {
    const rawRow = exportToRawRow(
      makeCustomer({ uscc: null, industry: null, creditLevel: null, remark: null }),
    );
    const result = parseCustomerRow(rawRow);
    expect(result.errors).toEqual([]);
    expect(result.dto?.uscc).toBeUndefined();
    expect(result.dto?.industry).toBeUndefined();
    expect(result.dto?.remark).toBeUndefined();
  });
});

describe('状态字典（CUSTOMER_STATUS_LABELS / CUSTOMER_STATUS_TO_CODE）', () => {
  it('每个代码都映射到自身（导出→回导闭环的代码形态）', () => {
    for (const code of ['active', 'inactive', 'prospect']) {
      expect(CUSTOMER_STATUS_TO_CODE[code]).toBe(code);
    }
  });

  it('每个中文标签都映射回**同一个**代码（两张表必须同源，不能各写一份）', () => {
    for (const [code, label] of Object.entries(CUSTOMER_STATUS_LABELS)) {
      expect(CUSTOMER_STATUS_TO_CODE[label]).toBe(code);
    }
  });

  it('映射结果必须是合法状态代码（不是随手写的字符串）', () => {
    const valid = new Set(['active', 'inactive', 'prospect']);
    for (const value of Object.values(CUSTOMER_STATUS_TO_CODE)) {
      expect(valid.has(value)).toBe(true);
    }
    // 每个代码都有中文标签（否则导出那一列是空白格）
    for (const code of valid) {
      expect(CUSTOMER_STATUS_LABELS[code]).toBeTruthy();
    }
  });

  it('两张表都没有多余条目（3 个代码 + 3 个标签 = 6）', () => {
    expect(Object.keys(CUSTOMER_STATUS_LABELS)).toHaveLength(3);
    expect(Object.keys(CUSTOMER_STATUS_TO_CODE)).toHaveLength(6);
  });

  it('字典里的中文与页面下拉/模板文案一致（改文案要同步改这两处）', () => {
    expect(CUSTOMER_STATUS_LABELS).toEqual({
      active: '合作中',
      inactive: '停用',
      prospect: '潜在客户',
    });
  });
});

describe('customerSchema 与 CUSTOMER_EMPTY_FORM', () => {
  const validForm = {
    ...CUSTOMER_EMPTY_FORM,
    name: '张三',
  };

  it('默认表单值除名称外全部合法（唯一缺的是必填名称）', () => {
    const result = customerSchema.safeParse(CUSTOMER_EMPTY_FORM);
    expect(result.success).toBe(false);
    if (!result.success) {
      // 只允许"名称不能为空"这一条 —— 若默认值里混进别的不合法值，这里会红
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(['name']);
    }
    expect(customerSchema.safeParse(validForm).success).toBe(true);
  });

  it('账期 0 / 365 通过，-1 / 366 被拒（与解析器的同一门槛）', () => {
    expect(customerSchema.safeParse({ ...validForm, termsDays: 0 }).success).toBe(true);
    expect(customerSchema.safeParse({ ...validForm, termsDays: 365 }).success).toBe(true);
    expect(customerSchema.safeParse({ ...validForm, termsDays: -1 }).success).toBe(false);
    expect(customerSchema.safeParse({ ...validForm, termsDays: 366 }).success).toBe(false);
    // 与导入侧同一个上限：两处不一致会让"表单能存、导入被拒"这种怪现象出现
    expect(parseCustomerRow({ 名称: '张三', '账期（天）': '365' }).errors).toEqual([]);
    expect(parseCustomerRow({ 名称: '张三', '账期（天）': '366' }).errors).toHaveLength(1);
  });

  it('信用额度 0 通过，负数被拒', () => {
    expect(customerSchema.safeParse({ ...validForm, creditLimit: 0 }).success).toBe(true);
    expect(customerSchema.safeParse({ ...validForm, creditLimit: -0.01 }).success).toBe(false);
  });

  it('登记一处**有意的差异**：表单清空数字框得到 0，导入留空得到默认 30', () => {
    /*
     * `z.coerce.number()` 把空串 coerce 成 0，而 0 是合法账期（款到发货），
     * 所以"把账期框清空"= 账期 0，不是"回到默认 30"。这是表单既有行为（本模块只搬运，
     * 未改），与导入的"列留空 → 30"看似矛盾，实则各自自洽：
     *   · 导入的"列留空"= 这次导入没带这个信息 → 用业务默认值 30；
     *   · 表单的"清空"= 用户显式表达了一个值 → zod 取 Number('') = 0。
     * 两条都断言下来，避免有人把其中一条"统一"成另一条而悄悄改掉账期口径
     * （账期直接决定应收到期日）。
     */
    expect(customerSchema.safeParse({ ...validForm, termsDays: '' }).success).toBe(true);
    const parsed = customerSchema.safeParse({ ...validForm, termsDays: '' });
    expect(parsed.success && parsed.data.termsDays).toBe(0);
    expect(customerSchema.safeParse({ ...validForm, creditLimit: '' }).success).toBe(true);
    expect(parseCustomerRow({ 名称: '张三' }).dto?.termsDays).toBe(30);
  });

  it('CUSTOMER_EMPTY_FORM 的默认值与解析器缺省值同源（B / 30 / prospect）', () => {
    const dto = parseCustomerRow({ 名称: '张三' }).dto;
    expect(CUSTOMER_EMPTY_FORM.creditLevel).toBe(dto?.creditLevel);
    expect(CUSTOMER_EMPTY_FORM.termsDays).toBe(dto?.termsDays);
    expect(CUSTOMER_EMPTY_FORM.status).toBe(dto?.status);
    expect(CUSTOMER_EMPTY_FORM.creditLimit).toBe(dto?.creditLimit);
  });

  it('CUSTOMER_EMPTY_FORM 的**十个字段逐一**固定（组件里两处表单复位都展开它）', () => {
    /*
     * 组件用 `{ ...CUSTOMER_EMPTY_FORM }` 替掉了原先两处行内字面量
     * （`useForm` 的 defaultValues 与 `openCreate` 的 `form.reset`）。
     * 这条断言把那份"默认值"的每个字段钉死 —— 少一个字段、改一个默认值都会红，
     * 而这类改动在界面上只表现为"新建弹窗里某一格变成了空/0"。
     */
    expect(CUSTOMER_EMPTY_FORM).toEqual({
      name: '',
      uscc: '',
      industry: '',
      creditLevel: 'B',
      creditLimit: 0,
      termsDays: 30,
      status: 'prospect',
      remark: '',
      taxEntityId: '',
      defaultTaxRate: '',
    });
  });
});
