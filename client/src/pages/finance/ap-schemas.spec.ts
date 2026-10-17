import {
  apExportColumns,
  apSchema,
  paymentSchema,
  vendorSettlementSchema,
  writeoffSchema,
} from './ap-schemas';
import { AP_STATUS_LABELS } from '@client/src/utils/biz-labels';
import type { ApItem } from '@shared/api.interface';

/**
 * 应付表单 schema 与导出列定义规格（§5.9 / F8）。
 *
 * ## 为什么这两块值得单测
 *
 * **schema 是财务数据的入口闸门。** 改错一个 `min` 就会放进脏数据，而
 * zod 的报错只在提交时以 toast 出现 —— 如果没人测边界，一个误改的
 * `min(1) → min(0)` 会静默允许 0 元应付单落库，之后应付台账里永远多一行
 * 不需要付款的记录。
 *
 * 本文件特别钉住**三处"看起来该统一、实际不该统一"的门槛**：
 *   · 应付金额 `min(1)` —— 0 元负债无业务含义；
 *   · 核销金额 `min(0.01)` —— 1 分钱的分摊是合法且必要的尾差处理；
 *   · 付款金额 `min(1)` —— 与应付同理。
 * 把它们写成同一个数会让尾差无法核销，或让 0 元单据落库。
 *
 * **导出列定义的错误在界面上看不出来。** 导出照样成功、Excel 照样打开，
 * 只是「已付」那列显示的是应付金额 —— 而对账的人会据此以为款已付清。
 */
describe('应付导出列定义（apExportColumns）', () => {
  function row(): ApItem {
    return {
      id: 'a1',
      code: 'AP001',
      supplierId: 's1',
      supplierName: '供应商甲',
      projectId: 'p1',
      projectName: '项目一',
      amount: 1000,
      paidAmount: 400,
      dueDate: '2026-11-30',
      status: 'partial',
      remark: null,
    } as unknown as ApItem;
  }

  const byHeader = (r: ApItem) =>
    new Map(apExportColumns.map((c) => [c.header, c.value(r)]));

  it('列头与列序固定', () => {
    expect(apExportColumns.map((c) => c.header)).toEqual([
      '应付编号',
      '供应商',
      '项目',
      '应付金额（含税）',
      '已付',
      '未付',
      '到期日',
      '状态',
    ]);
  });

  it('每列取到对应字段（已付/未付不互换，金额不取错）', () => {
    const m = byHeader(row());
    expect(m.get('应付编号')).toBe('AP001');
    expect(m.get('供应商')).toBe('供应商甲');
    expect(m.get('项目')).toBe('项目一');
    expect(m.get('应付金额（含税）')).toBe(1000);
    expect(m.get('已付')).toBe(400);
    expect(m.get('到期日')).toBe('2026-11-30');
  });

  it('「未付」是 amount − paidAmount 现算（不是取某个字段）', () => {
    const m = byHeader(row());
    expect(m.get('未付')).toBe(600);
    // 反例防线：若误取 paidAmount，未付会等于 400
    expect(m.get('未付')).not.toBe(400);
  });

  it('「未付」在已付 > 应付时给负数（**保留原行为**，不静默 clamp）', () => {
    /*
     * 这条断言是"有意保留原行为"的登记：
     * 「已付 > 应付」是脏数据（超付），导出时显示负数能让对账的人**看见**异常；
     * 若改成 `Math.max(0, …)` 就会把它藏起来。将来若确要 clamp，
     * 必须先改这条断言并说明理由，而不能顺手改。
     */
    const overpaid = { ...row(), amount: 100, paidAmount: 150 } as ApItem;
    expect(byHeader(overpaid).get('未付')).toBe(-50);
  });

  it('projectName / dueDate 为 null 时导出空串（不是 "null" 字符串）', () => {
    const empty = { ...row(), projectName: null, dueDate: null } as ApItem;
    const m = byHeader(empty);
    expect(m.get('项目')).toBe('');
    expect(m.get('到期日')).toBe('');
  });

  it('状态走字典文案（缺字典时回退原值，不会导出空白）', () => {
    expect(byHeader({ ...row(), status: 'paid' } as ApItem).get('状态')).toBe(
      AP_STATUS_LABELS.paid,
    );
    /*
     * 契约类型 `ApStatus` 只允许已知状态，因此这里必须 `as unknown as`
     * 双重断言。而这个断言是**必要的**：真实运行时会遇到契约之外的状态
     * （后端新增状态、历史数据、脏数据），此时导出必须是"原样透出"
     * 而不是 undefined（那会在 Excel 里留空白格，接收方无法分辨
     * "没有状态"与"数据丢了"）。
     */
    const unknown = { ...row(), status: 'weird' } as unknown as ApItem;
    expect(byHeader(unknown).get('状态')).toBe('weird');
  });
});

describe('应付表单 schema', () => {
  describe('apSchema（新建应付单）', () => {
    it('金额门槛是 1：0 元应付单被拒（0 元负债无业务含义）', () => {
      const base = { supplierId: 's1', remark: '' };
      expect(apSchema.safeParse({ ...base, amount: 0.99 }).success).toBe(false);
      expect(apSchema.safeParse({ ...base, amount: 1 }).success).toBe(true);
    });

    it('金额门槛**不是** 0.01（与核销门槛有意不同）', () => {
      const base = { supplierId: 's1', remark: '' };
      // 0.5 是"大于 0 但小于 1"的区间：若有人把门槛误改成 0.01 会放过它
      expect(apSchema.safeParse({ ...base, amount: 0.5 }).success).toBe(false);
    });

    it('字符串型金额被 coerce 成数字（表单里 input 给的是字符串）', () => {
      const parsed = apSchema.safeParse({
        supplierId: 's1',
        amount: '1234.56',
        remark: '',
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.amount).toBe(1234.56);
    });

    it('未选供应商被拒（min(1) 拦住空串）', () => {
      const parsed = apSchema.safeParse({ supplierId: '', amount: 10, remark: '' });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.message).toBe('请选择供应商');
      }
    });

    it('dueDate 可省略（不是必填）', () => {
      expect(
        apSchema.safeParse({ supplierId: 's1', amount: 10, remark: '' }).success,
      ).toBe(true);
    });
  });

  describe('writeoffSchema（核销）', () => {
    it('核销门槛是 0.01：1 分钱的分摊必须合法（尾差处理）', () => {
      const base = { apId: 'a1', paymentId: 'p1' };
      expect(writeoffSchema.safeParse({ ...base, amount: 0.01 }).success).toBe(
        true,
      );
      expect(writeoffSchema.safeParse({ ...base, amount: 0 }).success).toBe(
        false,
      );
    });

    it('核销门槛**不是** 1（否则尾差永远核不掉）', () => {
      expect(
        writeoffSchema.safeParse({ apId: 'a1', paymentId: 'p1', amount: 0.5 })
          .success,
      ).toBe(true);
    });

    it('未选应付或未选付款都被拒', () => {
      expect(
        writeoffSchema.safeParse({ apId: '', paymentId: 'p1', amount: 1 })
          .success,
      ).toBe(false);
      expect(
        writeoffSchema.safeParse({ apId: 'a1', paymentId: '', amount: 1 })
          .success,
      ).toBe(false);
    });
  });

  describe('paymentSchema（登记付款）', () => {
    it('付款金额门槛同样是 1', () => {
      const base = { apId: 'a1', method: 'transfer', remark: '' };
      expect(paymentSchema.safeParse({ ...base, amount: 0.99 }).success).toBe(
        false,
      );
      expect(paymentSchema.safeParse({ ...base, amount: 1 }).success).toBe(true);
    });
  });

  describe('vendorSettlementSchema（外协结算）', () => {
    it('供应商与月份必填，项目与到期日可选', () => {
      expect(
        vendorSettlementSchema.safeParse({ supplierId: 's1', period: '2026-10' })
          .success,
      ).toBe(true);
      expect(
        vendorSettlementSchema.safeParse({ supplierId: '', period: '2026-10' })
          .success,
      ).toBe(false);
      expect(
        vendorSettlementSchema.safeParse({ supplierId: 's1', period: '' })
          .success,
      ).toBe(false);
    });

    it('period 不做格式校验（保持原行为：仅要求非空）', () => {
      /*
       * 原 schema 只写 `min(1)`，没有 `^\d{4}-\d{2}$` 正则。
       * 这条断言**登记现状**而不是认可它：真正该拦的格式错误目前由
       * 后端的期间闸门兜住（会返回可读中文错误）。若将来要加正则，
       * 这条断言会失败，从而强制一次有意识的决定。
       */
      expect(
        vendorSettlementSchema.safeParse({ supplierId: 's1', period: 'x' })
          .success,
      ).toBe(true);
    });
  });
});
