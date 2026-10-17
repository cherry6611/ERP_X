import {
  arExportColumns,
  arSchema,
  receiptSchema,
  writeoffSchema,
} from './ar-schemas';
import { AR_STATUS_LABELS } from '@client/src/utils/biz-labels';
import type { ArItem } from '@shared/api.interface';

/**
 * 应收表单 schema 与导出列定义规格（§5.9 / F8）。
 *
 * 与 `ap-schemas.spec.ts` 成对。两边刻意保留**不对称**的断言：
 * 应收单挂合同、回款单挂客户；应付侧没有这个区分。
 * 若将来有人"为了统一"把 `arSchema` 的 `contractId` 改成 `customerId`，
 * 或把回款单也改成挂合同，这里的断言会失败 —— 这正是它存在的目的。
 */
describe('应收导出列定义（arExportColumns）', () => {
  function row(): ArItem {
    return {
      id: 'r1',
      code: 'AR001',
      customerId: 'c1',
      customerName: '客户甲',
      contractId: 'ct1',
      contractName: '合同一',
      amount: 2000,
      settledAmount: 500,
      dueDate: '2026-12-31',
      status: 'partial',
      overdue: false,
    } as unknown as ArItem;
  }

  const byHeader = (r: ArItem) =>
    new Map(arExportColumns.map((c) => [c.header, c.value(r)]));

  it('列头与列序固定（比应付多一列「逾期」）', () => {
    expect(arExportColumns.map((c) => c.header)).toEqual([
      '应收编号',
      '客户',
      '合同',
      '应收金额（含税）',
      '已核销',
      '未核销',
      '到期日',
      '状态',
      '逾期',
    ]);
  });

  it('「已核销」与「未核销」不互换，且未核销是现算', () => {
    const m = byHeader(row());
    expect(m.get('已核销')).toBe(500);
    expect(m.get('未核销')).toBe(1500);
    // 反例防线：若误取 settledAmount，未核销会等于 500
    expect(m.get('未核销')).not.toBe(500);
  });

  it('「逾期」导出中文是/否而不是 true/false 或 1/0', () => {
    expect(byHeader(row()).get('逾期')).toBe('否');
    expect(byHeader({ ...row(), overdue: true } as ArItem).get('逾期')).toBe(
      '是',
    );
  });

  it('「未核销」在已核销 > 应收时给负数（保留原行为，不静默 clamp）', () => {
    const over = { ...row(), amount: 100, settledAmount: 150 } as ArItem;
    expect(byHeader(over).get('未核销')).toBe(-50);
  });

  it('contractName / dueDate 为 null 时导出空串', () => {
    const empty = { ...row(), contractName: null, dueDate: null } as ArItem;
    const m = byHeader(empty);
    expect(m.get('合同')).toBe('');
    expect(m.get('到期日')).toBe('');
  });

  it('状态走字典文案，未知状态回退原值', () => {
    expect(byHeader({ ...row(), status: 'open' } as ArItem).get('状态')).toBe(
      AR_STATUS_LABELS.open,
    );
    const unknown = { ...row(), status: 'weird' } as unknown as ArItem;
    expect(byHeader(unknown).get('状态')).toBe('weird');
  });
});

describe('应收表单 schema', () => {
  it('arSchema 挂的是**合同**（contractId），不是客户', () => {
    /*
     * 这条断言钉住应收侧的核心业务口径：收入按合同确认，应收单必须能追溯到
     * 具体合同（后续按合同算可开票金额、按合同算回款率）。
     * 若改成 customerId，一个客户多合同时应收就无法归属。
     */
    const keys = Object.keys(arSchema.shape);
    expect(keys).toContain('contractId');
    expect(keys).not.toContain('customerId');
    expect(arSchema.safeParse({ contractId: '', amount: 1, remark: '' }).success).toBe(
      false,
    );
  });

  it('arSchema 金额门槛是 1（0 元应收无业务含义）', () => {
    const base = { contractId: 'ct1', remark: '' };
    expect(arSchema.safeParse({ ...base, amount: 0.99 }).success).toBe(false);
    expect(arSchema.safeParse({ ...base, amount: 1 }).success).toBe(true);
  });

  it('receiptSchema 挂的是**客户**（customerId），不是合同', () => {
    /*
     * 与上一条对称：客户可能一次付多个合同的钱，回款单不能预先绑定某一个合同，
     * 归属由「核销」分摊到各应收单上。这是应收侧与应付侧的**有意不对称**。
     */
    const keys = Object.keys(receiptSchema.shape);
    expect(keys).toContain('customerId');
    expect(keys).not.toContain('contractId');
    expect(
      receiptSchema.safeParse({ customerId: '', amount: 1, method: '', remark: '' })
        .success,
    ).toBe(false);
  });

  it('receiptSchema 金额门槛是 1', () => {
    const base = { customerId: 'c1', method: 'transfer', remark: '' };
    expect(receiptSchema.safeParse({ ...base, amount: 0.99 }).success).toBe(
      false,
    );
    expect(receiptSchema.safeParse({ ...base, amount: 1 }).success).toBe(true);
  });

  it('writeoffSchema 门槛与应付侧一致为 0.01（尾差必须能核销）', () => {
    const base = { arId: 'r1', receiptId: 'p1' };
    expect(writeoffSchema.safeParse({ ...base, amount: 0.01 }).success).toBe(
      true,
    );
    expect(writeoffSchema.safeParse({ ...base, amount: 0 }).success).toBe(false);
  });

  it('writeoffSchema 的字段名是 arId / receiptId（不是 apId / paymentId）', () => {
    const keys = Object.keys(writeoffSchema.shape);
    expect(keys).toContain('arId');
    expect(keys).toContain('receiptId');
    expect(keys).not.toContain('apId');
    expect(keys).not.toContain('paymentId');
  });
});
