import {
  DIRECTION_LABELS,
  auxExportColumns,
  balanceExportColumns,
  detailExportColumns,
  generalExportColumns,
  voucherDate,
} from './ledger-export-columns';
import type {
  AccountBalanceRow,
  AuxBalanceRow,
  DetailLedgerLine,
  GeneralLedgerRow,
} from '@shared/api.interface';

/**
 * 账簿导出列定义规格（§5.9 / F8）。
 *
 * ## 为什么这些列定义值得单测
 *
 * 导出是**财务对外交付**的东西（报税、审计、对账都要它）。而列定义的错误
 * 在界面上**完全看不出来**：导出照样成功、Excel 照样打开，只是数字落在
 * 错的列里。可能的错法都很隐蔽：
 *   · 漏一列（例如「期末贷方」没导出）→ 接收方以为那列全是 0；
 *   · 列序错（借/贷互换）→ **金额方向反了**；
 *   · `value` 取错字段（`closingDebit` 写成 `openingDebit`）→ 期初与期末同一个数。
 *
 * 这三类错误靠人眼看代码很难发现（`openingDebit` 与 `closingDebit` 只差几个字母），
 * 靠渲染页面也发现不了（页面上是对的，导出才错）。因此本规格的做法是
 * **逐列断言 header 与取值**，并对"同一行的各字段互不相同"做设计，
 * 使任何字段错配都会立刻暴露。
 *
 * ## 测试数据的设计要点
 *
 * 每一行的各个金额字段都取**不同的值**，且借贷两侧也不相同。
 * 若图省事写成全 0 或重复值，字段错配就测不出来 —— 那等于白测。
 */
function balanceRow(): AccountBalanceRow {
  return {
    accountCode: '1001',
    accountName: '库存现金',
    level: 1,
    direction: 'debit',
    isLeaf: true,
    openingDebit: 11,
    openingCredit: 12,
    debitOccur: 13,
    creditOccur: 14,
    closingDebit: 15,
    closingCredit: 16,
  } as AccountBalanceRow;
}

function generalRow(): GeneralLedgerRow {
  return {
    accountCode: '1001',
    accountName: '库存现金',
    direction: 'credit',
    accountType: 'asset',
    openingDebit: 21,
    openingCredit: 22,
    debitOccur: 23,
    creditOccur: 24,
    closingDebit: 25,
    closingCredit: 26,
    closingNet: 27,
    closingSide: 'credit',
    childCount: 28,
  } as GeneralLedgerRow;
}

function detailRow(): DetailLedgerLine {
  return {
    lineId: 'l1',
    voucherId: 'v1',
    voucherCode: 'V001',
    voucherDate: '2026-10-16T09:00:00.000+08:00',
    summary: '提现',
    counterpartAccounts: ['1002 银行存款', '1001 库存现金'],
    debit: 31,
    credit: 32,
    balance: 33,
    balanceSide: 'debit',
    aux: [
      { dimensionCode: 'dept', dimensionValue: '研发部' },
      { dimensionCode: 'proj', dimensionValue: null },
    ],
  } as unknown as DetailLedgerLine;
}

function auxRow(): AuxBalanceRow {
  return {
    dimensionId: 'd1',
    dimensionValue: '研发部',
    accountCode: '1001',
    accountName: '库存现金',
    openingDebit: 41,
    openingCredit: 42,
    debitOccur: 43,
    creditOccur: 44,
    closingDebit: 45,
    closingCredit: 46,
    closingNet: 47,
    closingSide: 'debit',
  } as unknown as AuxBalanceRow;
}

/** 把列定义跑成 `[header, value]` 数组，便于整体断言 */
function project<TRow>(
  columns: Array<{ header: string; value: (row: TRow) => unknown }>,
  row: TRow,
): Array<[string, unknown]> {
  return columns.map((column) => [column.header, column.value(row)]);
}

describe('账簿导出列定义', () => {
  describe('科目余额表', () => {
    it('列头与列序固定（漏列/换序会被这条拦住）', () => {
      const headers = balanceExportColumns('2026-10').map((c) => c.header);
      expect(headers).toEqual([
        '期间',
        '科目编码',
        '科目名称',
        '级次',
        '方向',
        '期初借方',
        '期初贷方',
        '本期发生借方',
        '本期发生贷方',
        '期末借方',
        '期末贷方',
      ]);
    });

    it('每列取到的是**对应**字段（借/贷不互换、期初与期末不混）', () => {
      const pairs = project(balanceExportColumns('2026-10'), balanceRow());
      expect(pairs).toEqual([
        ['期间', '2026-10'],
        ['科目编码', '1001'],
        ['科目名称', '库存现金'],
        ['级次', 1],
        ['方向', '借'],
        ['期初借方', 11],
        ['期初贷方', 12],
        ['本期发生借方', 13],
        ['本期发生贷方', 14],
        ['期末借方', 15],
        ['期末贷方', 16],
      ]);
    });
  });

  describe('总账', () => {
    it('比余额表多「下级科目数」，且各金额列顺序一致', () => {
      const headers = generalExportColumns('2026-10').map((c) => c.header);
      expect(headers).toEqual([
        '期间',
        '科目编码',
        '科目名称',
        '方向',
        '期初借方',
        '期初贷方',
        '本期发生借方',
        '本期发生贷方',
        '期末借方',
        '期末贷方',
        '下级科目数',
      ]);
      const row = generalRow();
      const pairs = project(generalExportColumns('2026-10'), row);
      // 逐列核对：任一处取错字段都会因测试数据互不相同而暴露
      expect(pairs).toEqual([
        ['期间', '2026-10'],
        ['科目编码', '1001'],
        ['科目名称', '库存现金'],
        ['方向', '贷'],
        ['期初借方', 21],
        ['期初贷方', 22],
        ['本期发生借方', 23],
        ['本期发生贷方', 24],
        ['期末借方', 25],
        ['期末贷方', 26],
        ['下级科目数', 28],
      ]);
    });
  });

  describe('明细账', () => {
    it('日期取到日（去掉时间戳），科目名来自参数而不是行', () => {
      const pairs = project(
        detailExportColumns('2026-10', '1001 库存现金'),
        detailRow(),
      );
      const byHeader = new Map(pairs);
      expect(byHeader.get('日期')).toBe('2026-10-16');
      // 关键：科目名来自**参数**（查询结果外层），行里没有这个信息
      expect(byHeader.get('科目')).toBe('1001 库存现金');
      expect(byHeader.get('凭证号')).toBe('V001');
      expect(byHeader.get('摘要')).toBe('提现');
      // 多值字段用中文顿号连接
      expect(byHeader.get('对方科目')).toBe('1002 银行存款、1001 库存现金');
      // 辅助核算：维度值为 null 时用 '-' 占位，不允许出现 "proj:null"
      expect(byHeader.get('辅助核算')).toBe('dept:研发部；proj:-');
    });

    it('借贷与余额三列分别取 debit / credit / balance（不是同一个数）', () => {
      const byHeader = new Map(
        project(detailExportColumns('2026-10', 'x'), detailRow()),
      );
      expect(byHeader.get('借方')).toBe(31);
      expect(byHeader.get('贷方')).toBe(32);
      expect(byHeader.get('余额')).toBe(33);
      expect(byHeader.get('方向')).toBe('借');
    });
  });

  describe('辅助余额表', () => {
    it('「维度」用传入的维度中文名（不是维度 code）', () => {
      const byHeader = new Map(
        project(auxExportColumns('2026-10', '部门'), auxRow()),
      );
      expect(byHeader.get('维度')).toBe('部门');
      expect(byHeader.get('维度值')).toBe('研发部');
      expect(byHeader.get('期末借方')).toBe(45);
      expect(byHeader.get('期末贷方')).toBe(46);
    });

    it('维度值为 null 时导出空串而不是 "null" 字符串', () => {
      const row = { ...auxRow(), dimensionValue: null } as AuxBalanceRow;
      const byHeader = new Map(project(auxExportColumns('2026-10', '部门'), row));
      // 导出的是空串（Excel 里显示为空白）；写 'null' 会被当成真实维度值
      expect(byHeader.get('维度值')).toBe('');
    });
  });

  describe('共享 helper', () => {
    it('voucherDate：空值给 "-"，有值只取日期段', () => {
      expect(voucherDate(null)).toBe('-');
      expect(voucherDate('')).toBe('-');
      expect(voucherDate('2026-10-16T09:00:00.000+08:00')).toBe('2026-10-16');
      // 已是纯日期的原样返回
      expect(voucherDate('2026-10-16')).toBe('2026-10-16');
    });

    it('DIRECTION_LABELS 覆盖借贷两侧（缺一个会让导出出现英文 debit/credit）', () => {
      expect(DIRECTION_LABELS.debit).toBe('借');
      expect(DIRECTION_LABELS.credit).toBe('贷');
    });

    it('未知方向回退为原值而不是 undefined（不会导出空白单元格）', () => {
      /*
       * 这里必须 `as unknown as` 双重断言：`direction` 的契约类型是
       * `AccountDirection`（只允许 debit/credit），直接 `as` 会被编译器
       * 判为"两个类型不充分重叠"而拒绝。
       *
       * 而这个断言是**必要的**：真实运行时会遇到契约之外的值
       * （历史数据、后端新增方向、脏数据导入），此时导出必须是"原样透出"
       * 而不是静默变成 undefined（那会在 Excel 里留空白格，
       * 接收方无法分辨"没有方向"与"数据丢了"）。
       */
      const row = {
        ...balanceRow(),
        direction: 'weird',
      } as unknown as AccountBalanceRow;
      const byHeader = new Map(
        project(balanceExportColumns('2026-10'), row),
      );
      expect(byHeader.get('方向')).toBe('weird');
    });
  });
});
