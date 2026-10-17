import {
  EMPLOYEE_EXPORT_COLUMNS,
  EMPLOYEE_IMPORT_COLUMNS,
  EMPLOYEE_STATUS_TO_CODE,
  EMPLOYMENT_TYPE_TO_CODE,
  parseEmployeeRow,
} from './employee-import';
import {
  EMPLOYEE_STATUS_LABELS,
  EMPLOYMENT_TYPE_LABELS,
} from './HrStatusBadge';
import type { Employee } from '@shared/api.interface';

/**
 * 员工 Excel 导入解析规格（§5.9 / F8）。
 *
 * ## 为什么这是本仓最值得测的纯函数之一
 *
 * `parseEmployeeRow` 是员工批量导入的**唯一闸门**：HR 一次导入几百行，
 * 它拦不住的错误会**批量落库**，清理成本随行数线性增长。
 * 而它的行为里有好几条"不测就不知道"的约定：
 *
 * | 约定 | 不测的后果 |
 * |---|---|
 * | `2026/1/5` 与 `2026.1.5` 都要接受 | HR 用 Excel 默认斜杠日期，整表被拒 |
 * | 日期补零到 `2026-01-05` | 服务端按字符串比日期，不补零会比错 |
 * | 用工类型/状态中英文都接受 | 只支持英文时 HR 填"全职"整表被拒 |
 * | 未知取值**报错**而不是用默认值 | 静默默认把"实习"录成"全职"，成本归集错 |
 * | 部门名对不上**报错**而不是留空 | 建出"无部门员工"，费用归属与审批链错 |
 * | 有错时 `dto: null` | 上层拿半成品 DTO 去建员工 |
 *
 * ## 测试数据的用意
 *
 * 部门/岗位映射表刻意用**非平凡**的 ID（`dept-rd` 而不是 `d1`），
 * 这样"是否真的查了映射表"能被断言出来 —— 若实现硬编码返回 `d1`，
 * 测试会红。
 */
const DEPTS = new Map<string, string>([
  ['研发部', 'dept-rd'],
  ['销售部', 'dept-sales'],
]);
const POSITIONS = new Map<string, string>([
  ['后端工程师', 'pos-be'],
  ['销售经理', 'pos-sm'],
]);

/** 只填必填项的最小合法行 */
const MINIMAL = { 姓名: '张三' };

describe('parseEmployeeRow（员工导入单行解析）', () => {
  describe('必填与默认值', () => {
    it('只有姓名是必填，其余留空都通过', () => {
      const result = parseEmployeeRow(MINIMAL, DEPTS, POSITIONS);
      expect(result.errors).toEqual([]);
      expect(result.dto).not.toBeNull();
      expect(result.dto?.name).toBe('张三');
    });

    it('姓名留空/全空格 → 报错且不返回 DTO', () => {
      for (const raw of [{}, { 姓名: '' }, { 姓名: '   ' }] as Array<Record<string, string>>) {
        const result = parseEmployeeRow(raw, DEPTS, POSITIONS);
        expect(result.errors).toContain('姓名不能为空');
        expect(result.dto).toBeNull();
      }
    });

    it('姓名两侧空格被 trim（Excel 里常有不可见空格）', () => {
      expect(
        parseEmployeeRow({ 姓名: '  李四  ' }, DEPTS, POSITIONS).dto?.name,
      ).toBe('李四');
    });

    it('用工类型留空默认 full_time，状态留空默认 probation', () => {
      const dto = parseEmployeeRow(MINIMAL, DEPTS, POSITIONS).dto;
      expect(dto?.employmentType).toBe('full_time');
      expect(dto?.status).toBe('probation');
    });

    it('手机号/备注留空 → undefined（不是空串）', () => {
      const dto = parseEmployeeRow(MINIMAL, DEPTS, POSITIONS).dto;
      // 空串会被服务端当成"填了个空手机号"，undefined 才是"没填"
      expect(dto?.phone).toBeUndefined();
      expect(dto?.remark).toBeUndefined();
    });
  });

  describe('部门 / 岗位按中文名映射为 ID', () => {
    it('能查到就换成 ID（证明真的查了映射表，不是硬编码）', () => {
      const dto = parseEmployeeRow(
        { ...MINIMAL, 部门: '研发部', 岗位: '后端工程师' },
        DEPTS,
        POSITIONS,
      ).dto;
      expect(dto?.departmentId).toBe('dept-rd');
      expect(dto?.positionId).toBe('pos-be');
    });

    it('名称对不上 → **报错**而不是留空（留空会建出无部门员工）', () => {
      const result = parseEmployeeRow(
        { ...MINIMAL, 部门: '不存在的部门' },
        DEPTS,
        POSITIONS,
      );
      expect(result.errors).toContain('部门「不存在的部门」不存在');
      expect(result.dto).toBeNull();
      // 反例防线：不能因为查不到就把 ID 留空并通过
      expect(result.dto?.departmentId).toBeUndefined();
    });

    it('岗位名称对不上同样报错', () => {
      const result = parseEmployeeRow(
        { ...MINIMAL, 岗位: '不存在的岗位' },
        DEPTS,
        POSITIONS,
      );
      expect(result.errors).toContain('岗位「不存在的岗位」不存在');
      expect(result.dto).toBeNull();
    });

    it('留空则不填 ID 且**不报错**（部门非必填）', () => {
      const result = parseEmployeeRow(MINIMAL, DEPTS, POSITIONS);
      expect(result.errors).toEqual([]);
      expect(result.dto?.departmentId).toBeUndefined();
      expect(result.dto?.positionId).toBeUndefined();
    });

    it('部门名两侧空格被 trim 后再查（Excel 里常多一个空格）', () => {
      const dto = parseEmployeeRow(
        { ...MINIMAL, 部门: ' 研发部 ' },
        DEPTS,
        POSITIONS,
      ).dto;
      expect(dto?.departmentId).toBe('dept-rd');
    });
  });

  describe('入职日期：分隔符归一化与补零', () => {
    it('接受斜杠分隔（Excel 默认日期格式）并归一为 YYYY-MM-DD', () => {
      expect(
        parseEmployeeRow({ ...MINIMAL, 入职日期: '2026/1/5' }, DEPTS, POSITIONS)
          .dto?.hireDate,
      ).toBe('2026-01-05');
    });

    it('接受点号分隔', () => {
      expect(
        parseEmployeeRow({ ...MINIMAL, 入职日期: '2026.12.31' }, DEPTS, POSITIONS)
          .dto?.hireDate,
      ).toBe('2026-12-31');
    });

    it('接受标准横杠格式并补零（2026-1-5 → 2026-01-05）', () => {
      expect(
        parseEmployeeRow({ ...MINIMAL, 入职日期: '2026-1-5' }, DEPTS, POSITIONS)
          .dto?.hireDate,
      ).toBe('2026-01-05');
    });

    it('补零是必需的：服务端按字符串比较日期，不补零会比错', () => {
      const dto = parseEmployeeRow(
        { ...MINIMAL, 入职日期: '2026-1-5' },
        DEPTS,
        POSITIONS,
      ).dto;
      expect(dto?.hireDate).toBe('2026-01-05');
      // 反例防线：不能原样透出未补零的形态
      expect(dto?.hireDate).not.toBe('2026-1-5');
      // 字符串比较下 '2026-1-5' > '2026-01-05'（'1' > '0'），会算错司龄
      expect('2026-1-5' > '2026-01-05').toBe(true);
    });

    it('完整格式原样通过（幂等）', () => {
      expect(
        parseEmployeeRow({ ...MINIMAL, 入职日期: '2026-10-16' }, DEPTS, POSITIONS)
          .dto?.hireDate,
      ).toBe('2026-10-16');
    });

    it('无法识别的**格式** → 报格式错且不返回 DTO', () => {
      for (const bad of ['去年', '2026', '2026/1', 'abc', '2026-1-5-1']) {
        const result = parseEmployeeRow(
          { ...MINIMAL, 入职日期: bad },
          DEPTS,
          POSITIONS,
        );
        expect(result.errors).toContain('入职日期格式应为 YYYY-MM-DD');
        expect(result.dto).toBeNull();
      }
    });

    it('**不存在的日期** → 报错（正则匹配但日历上不存在）', () => {
      /*
       * 这组是本轮修复的真实缺陷。原实现只用正则
       * `/^(\d{4})-(\d{1,2})-(\d{1,2})$/`，它**不约束取值范围**，于是：
       *   · `2026-13-01`（13 月）通过；
       *   · `2026-02-31`（2 月 31 日）通过。
       * 两者会以字符串形式走到 `INSERT`，由服务端 PostgreSQL 的 `date`
       * 类型抛错 —— HR 只看到"导入失败"，不知道是哪一行哪一列。
       */
      for (const impossible of [
        '2026-13-01', // 13 月
        '2026-00-10', // 0 月
        '2026-02-31', // 2 月没有 31 日
        '2026-02-30',
        '2026-04-31', // 4 月只有 30 天
        '2026-01-32', // 32 日
        '2026-01-00', // 0 日
        '2025-02-29', // 2025 不是闰年
        '2100-02-29', // 2100 不是闰年（百年不闰）
      ]) {
        const result = parseEmployeeRow(
          { ...MINIMAL, 入职日期: impossible },
          DEPTS,
          POSITIONS,
        );
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toContain('不是一个真实存在的日期');
        expect(result.dto).toBeNull();
      }
    });

    it('**闰年 2 月 29 日必须被接受**（不能为了拦 2-31 把闰日也拦掉）', () => {
      for (const leap of ['2024-02-29', '2028-02-29', '2000-02-29']) {
        const result = parseEmployeeRow(
          { ...MINIMAL, 入职日期: leap },
          DEPTS,
          POSITIONS,
        );
        expect(result.errors).toEqual([]);
        expect(result.dto?.hireDate).toBe(leap);
      }
    });

    it('各月最后一天按真实天数判断（28/29/30/31 都要分别对）', () => {
      const lastDays: Array<[string, string]> = [
        ['2026-01-31', '2026-01-31'], // 31 天月
        ['2026-02-28', '2026-02-28'], // 平年 2 月
        ['2026-04-30', '2026-04-30'], // 30 天月
        ['2026-12-31', '2026-12-31'],
      ];
      for (const [input, expected] of lastDays) {
        const result = parseEmployeeRow(
          { ...MINIMAL, 入职日期: input },
          DEPTS,
          POSITIONS,
        );
        expect(result.errors).toEqual([]);
        expect(result.dto?.hireDate).toBe(expected);
      }
      // 相邻的越界值必须被拒（证明不是"只要格式对就放行"）
      for (const bad of ['2026-01-32', '2026-02-29', '2026-04-31']) {
        expect(
          parseEmployeeRow({ ...MINIMAL, 入职日期: bad }, DEPTS, POSITIONS)
            .errors.length,
        ).toBe(1);
      }
    });

    it('错误信息里带上原始输入（HR 要能定位是哪一格写错了）', () => {
      const result = parseEmployeeRow(
        { ...MINIMAL, 入职日期: '2026/2/31' },
        DEPTS,
        POSITIONS,
      );
      // 原样回显用户填的值（含分隔符），便于在 Excel 里搜索定位
      expect(result.errors[0]).toContain('2026/2/31');
    });

    it('留空则不填 hireDate 且不报错', () => {
      const result = parseEmployeeRow(MINIMAL, DEPTS, POSITIONS);
      expect(result.errors).toEqual([]);
      expect(result.dto?.hireDate).toBeUndefined();
    });
  });

  describe('用工类型 / 状态：中英文双映射', () => {
    it('中文取值被映射为代码（否则 HR 按模板填中文会整表被拒）', () => {
      expect(
        parseEmployeeRow({ ...MINIMAL, 用工类型: '灵活用工' }, DEPTS, POSITIONS)
          .dto?.employmentType,
      ).toBe('flex');
      expect(
        parseEmployeeRow({ ...MINIMAL, 用工类型: '实习' }, DEPTS, POSITIONS).dto
          ?.employmentType,
      ).toBe('intern');
    });

    it('英文代码取值原样通过（导出后再回导的场景）', () => {
      expect(
        parseEmployeeRow({ ...MINIMAL, 用工类型: 'part_time' }, DEPTS, POSITIONS)
          .dto?.employmentType,
      ).toBe('part_time');
    });

    it('状态的中文取值同样被映射', () => {
      expect(
        parseEmployeeRow({ ...MINIMAL, 状态: '在职' }, DEPTS, POSITIONS).dto
          ?.status,
      ).toBe('active');
      expect(
        parseEmployeeRow({ ...MINIMAL, 状态: '已离职' }, DEPTS, POSITIONS).dto
          ?.status,
      ).toBe('resigned');
    });

    it('未知用工类型 → **报错**，不用默认值（静默默认会把"实习"录成"全职"）', () => {
      const result = parseEmployeeRow(
        { ...MINIMAL, 用工类型: '小时工' },
        DEPTS,
        POSITIONS,
      );
      expect(result.errors).toContain(
        '用工类型「小时工」无效，应为 全职/兼职/灵活用工/实习/劳务派遣',
      );
      expect(result.dto).toBeNull();
    });

    it('未知状态 → 报错', () => {
      const result = parseEmployeeRow(
        { ...MINIMAL, 状态: '停薪留职' },
        DEPTS,
        POSITIONS,
      );
      expect(result.errors).toContain('状态「停薪留职」无效，应为 试用期/在职/已离职');
      expect(result.dto).toBeNull();
    });

it('**原型键必须被拒**（继承属性都是真值，否则会静默塞进函数值）', () => {
      /*
       * 用方括号查字面量对象会命中 `Object.prototype` 的继承属性，
       * 而它们都是**真值**：
       *   EMPLOYEE_STATUS_TO_CODE['constructor']  → [Function: Object]
       *   EMPLOYEE_STATUS_TO_CODE['toString']     → [Function: toString]
       *   EMPLOYEE_STATUS_TO_CODE['__proto__']    → [object Object]
       *
       * 于是 `if (mapped) status = mapped;` 被走通、**不报错**，
       * 并把一个函数塞进 `status`。契约是 `status: string`，
       * 而函数在 `JSON.stringify` 时被**静默丢弃**，服务端
       * `@IsOptional() @IsString()` 收到的就是"没传" → 落库默认值。
       * 结果是"导入成功、零错误，但那一列被换成了默认值"。
       *
       * 修复前实测：`errors=0`，`employmentType` 为
       * `function Object() { [native code] }`。
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
        const typeResult = parseEmployeeRow(
          { ...MINIMAL, 用工类型: key },
          DEPTS,
          POSITIONS,
        );
        expect(typeResult.errors).toHaveLength(1);
        expect(typeResult.errors[0]).toContain('无效');
        expect(typeResult.dto).toBeNull();

        const statusResult = parseEmployeeRow(
          { ...MINIMAL, 状态: key },
          DEPTS,
          POSITIONS,
        );
        expect(statusResult.errors).toHaveLength(1);
        expect(statusResult.errors[0]).toContain('无效');
        expect(statusResult.dto).toBeNull();
      }
    });

    it('原型键不报错时**绝不能**把函数塞进 DTO（类型契约防线）', () => {
      /*
       * 上一条断言"被拦住"，这一条断言"即使漏过也不可能是函数"——
       * 两者一起构成防线：将来若有人把校验放宽，这条仍会拦住
       * "非字符串值进入 DTO"这件事。
       */
      const result = parseEmployeeRow(
        { ...MINIMAL, 用工类型: 'constructor' },
        DEPTS,
        POSITIONS,
      );
      if (result.dto) {
        expect(typeof result.dto.employmentType).toBe('string');
      }
      expect(result.dto).toBeNull();
    });

    it('大小写敏感：`FULL_TIME` 不被接受（避免猜映射意图）', () => {
      const result = parseEmployeeRow(
        { ...MINIMAL, 用工类型: 'FULL_TIME' },
        DEPTS,
        POSITIONS,
      );
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.dto).toBeNull();
    });

    it('映射表覆盖全部代码与中文（漏一个会让那条路径整表被拒）', () => {
      // 每个代码都能被自身映射（导出→回导闭环）
      for (const code of ['full_time', 'part_time', 'flex', 'intern', 'dispatch']) {
        expect(EMPLOYMENT_TYPE_TO_CODE[code]).toBe(code);
      }
      for (const code of ['probation', 'active', 'resigned']) {
        expect(EMPLOYEE_STATUS_TO_CODE[code]).toBe(code);
      }
      // 每个中文都能映射到某个代码
      for (const zh of ['全职', '兼职', '灵活用工', '实习', '劳务派遣']) {
        expect(EMPLOYMENT_TYPE_TO_CODE[zh]).toBeTruthy();
      }
      for (const zh of ['试用期', '在职', '已离职']) {
        expect(EMPLOYEE_STATUS_TO_CODE[zh]).toBeTruthy();
      }
      // 中文映射的结果必须是合法代码（不是随手写的字符串）
      const validTypes = new Set(['full_time', 'part_time', 'flex', 'intern', 'dispatch']);
      for (const value of Object.values(EMPLOYMENT_TYPE_TO_CODE)) {
        expect(validTypes.has(value)).toBe(true);
      }
      const validStatuses = new Set(['probation', 'active', 'resigned']);
      for (const value of Object.values(EMPLOYEE_STATUS_TO_CODE)) {
        expect(validStatuses.has(value)).toBe(true);
      }
    });
  });

  describe('错误聚合：一次报全部问题而不是只报第一个', () => {
    it('多个字段同时出错时，errors 里全部列出', () => {
      const result = parseEmployeeRow(
        {
          姓名: '',
          部门: '无此部门',
          岗位: '无此岗位',
          入职日期: '昨天',
          用工类型: '小时工',
          状态: '未知',
        },
        DEPTS,
        POSITIONS,
      );
      expect(result.errors).toHaveLength(6);
      expect(result.dto).toBeNull();
    });

    it('有错时 dto 必须是 null（半成品 DTO 会被上层误用去建员工）', () => {
      const result = parseEmployeeRow({ 姓名: '', 部门: '研发部' }, DEPTS, POSITIONS);
      expect(result.dto).toBeNull();
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('无错时 errors 为空数组（不是 undefined）', () => {
      const result = parseEmployeeRow(MINIMAL, DEPTS, POSITIONS);
      expect(result.errors).toEqual([]);
    });
  });
});

describe('员工导入/导出列定义', () => {
  it('导入列头与解析器读取的键完全一致（改一处漏一处会导致整列读不到）', () => {
    /*
     * 这条断言把"列定义"与"解析器实际读的 raw[...] 键"绑在一起。
     * 若有人改了列头文案（如「入职日期」→「入职时间」）而没改解析器，
     * 导入会静默把那一列读成空 —— 而错误信息只会说"日期格式应为…"，
     * 让人以为是数据问题。下面用 MINIMAL 行反向验证每个列头都被读取过。
     */
    const headers = EMPLOYEE_IMPORT_COLUMNS.map((c) => c.header);
    expect(headers).toEqual([
      '姓名',
      '部门',
      '岗位',
      '入职日期',
      '用工类型',
      '状态',
      '手机号',
      '备注',
    ]);
    // 只有姓名是必填
    expect(EMPLOYEE_IMPORT_COLUMNS.filter((c) => c.required)).toHaveLength(1);
    expect(EMPLOYEE_IMPORT_COLUMNS.find((c) => c.required)?.header).toBe('姓名');
  });

  it('导出列头与列序固定', () => {
    expect(EMPLOYEE_EXPORT_COLUMNS.map((c) => c.header)).toEqual([
      '编号',
      '姓名',
      '部门',
      '岗位',
      '入职日期',
      '用工类型',
      '状态',
      '手机号',
    ]);
  });

  it('**导出 → 回导闭环**：导出值能被同一个解析器接受', () => {
    /*
     * 这是本文件最有价值的一条断言，也是"导出列与导入映射必须同源"的证明。
     *
     * 场景：HR 导出员工表 → 改几行 → 用导入功能回导。
     * 若导出的「用工类型」是中文而导入只认代码（或反之），回导会整表被拒。
     * 这里构造一个员工，按导出列取值，再把取值当作导入输入，
     * 断言解析器**不报错且映射回同一个代码**。
     */
    const employee = {
      code: 'EMP001',
      name: '王五',
      departmentName: '研发部',
      position: '后端工程师',
      hireDate: '2026-01-05',
      employmentType: 'flex',
      status: 'active',
      phone: '13800000000',
    } as unknown as Employee;

    const exported = new Map(
      EMPLOYEE_EXPORT_COLUMNS.map((c) => [c.header, c.value(employee)]),
    );
    const rawRow: Record<string, string> = {};
    for (const [header, value] of exported) {
      if (value !== null && value !== undefined) rawRow[header] = String(value);
    }

    const result = parseEmployeeRow(rawRow, DEPTS, POSITIONS);
    expect(result.errors).toEqual([]);
    expect(result.dto?.name).toBe('王五');
    expect(result.dto?.hireDate).toBe('2026-01-05');
    // 导出的「用工类型」是中文（EMPLOYMENT_TYPE_LABELS），回导必须映射回 flex
    expect(result.dto?.employmentType).toBe('flex');
    expect(result.dto?.status).toBe('active');
    expect(result.dto?.departmentId).toBe('dept-rd');
    expect(result.dto?.positionId).toBe('pos-be');
    expect(result.dto?.phone).toBe('13800000000');
  });

  it('导出「用工类型」用字典文案而不是裸代码', () => {
    const employee = { employmentType: 'flex' } as unknown as Employee;
    const column = EMPLOYEE_EXPORT_COLUMNS.find((c) => c.header === '用工类型');
    expect(column?.value(employee)).toBe(EMPLOYMENT_TYPE_LABELS.flex);
  });

  it('导出「状态」用字典文案；未知状态回退原值（不导出空白格）', () => {
    const column = EMPLOYEE_EXPORT_COLUMNS.find((c) => c.header === '状态');
    expect(
      column?.value({ status: 'active' } as unknown as Employee),
    ).toBe(EMPLOYEE_STATUS_LABELS.active);
    expect(
      column?.value({ status: 'weird' } as unknown as Employee),
    ).toBe('weird');
  });

  it('导出可空字段为 null 时给空串（不是 "null" 字符串）', () => {
    const empty = {
      code: 'E1',
      name: 'X',
      departmentName: null,
      position: null,
      hireDate: null,
      employmentType: null,
      status: 'active',
      phone: null,
    } as unknown as Employee;
    const m = new Map(EMPLOYEE_EXPORT_COLUMNS.map((c) => [c.header, c.value(empty)]));
    expect(m.get('部门')).toBe('');
    expect(m.get('岗位')).toBe('');
    expect(m.get('入职日期')).toBe('');
    expect(m.get('用工类型')).toBe('');
    expect(m.get('手机号')).toBe('');
  });
});
