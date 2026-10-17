/**
 * C-11 对账单 SQL 集成测试（pglite + 真实 StatementService）。
 *
 * 为什么需要这一层：`statement.logic.spec.ts` 只钉住算术，**碰不到 SQL**。
 * 对账单最容易在真实库里炸的地方是取数语句（`AT TIME ZONE` 表达式、
 * 子查询列名、`COUNT` 汇总），这些 `tsc` 与纯函数测试都发现不了。
 * 因此这里用 pglite 跑完整迁移链建表，再用真实 service 出对账单。
 *
 * 边界（诚实声明）：
 *   - 不连本地开发库，也不跑 `npm run db:migrate`（迁移只作用于内存 pglite）；
 *   - 覆盖：客户/供应商对账单取数、期初期末、作废剔除、发票备查行、对手方下拉、B-02 越权拦截；
 *   - 不覆盖：Nest HTTP 层（DTO 管道 / @NeedLogin / @CanFinanceRead）。
 */
import { ForbiddenException } from '@nestjs/common';
import { DataScopeService } from '@server/common/auth/data-scope.service';
import { StatementService } from '@server/modules/finance/statement.service';
import type { PostgresJsDatabase } from '@server/platform';
import type { StatementResult } from '@shared/api.interface';
import { createHarness, queryRows, type Harness } from './pglite-harness';

/** pglite 首次启动（WASM）+ 全量迁移约数秒，给足余量 */
const FLOW_TIMEOUT_MS = 180_000;

const PREFIX = '[API_TEST]';

/* 固定 UUID：断言里要逐条对号，不能靠查回来的随机值 */
const UUID = {
  customer: '11111111-1111-4111-8111-111111111111',
  customerB: '11111111-1111-4111-8111-222222222222',
  /** 8 月已结清：10 月下拉里必须仍有它（期初=0，但发生过业务） */
  customerC: '11111111-1111-4111-8111-333333333333',
  supplier: '33333333-3333-4333-8333-111111111111',
  contract: '44444444-4444-4444-8444-111111111111',
  project: '55555555-5555-4555-8555-111111111111',
  arOld: 'a0000000-0000-4000-8000-000000000001',
  arSep: 'a0000000-0000-4000-8000-000000000002',
  arOct1: 'a0000000-0000-4000-8000-000000000003',
  arOct31: 'a0000000-0000-4000-8000-000000000004',
  arVoided: 'a0000000-0000-4000-8000-000000000005',
  /** 客户丙：8 月发生并当月结清，10 月无任何发生额 */
  arAugClosed: 'a0000000-0000-4000-8000-000000000006',
  /** 客户丙的合同 / 收入确认单 / 收入折让（折让链路必须完整才能关联到客户） */
  contractC: '44444444-4444-4444-8444-333333333333',
  revenueC: '66666666-6666-4666-8666-333333333333',
  adjustC: '77777777-7777-4777-8777-333333333333',
  /** 客户丁：8 月一笔应收且无任何冲减 → 专用于"有期初余额但本期无发生额"用例 */
  customerD: '11111111-1111-4111-8111-444444444444',
  arDCarried: 'a0000000-0000-4000-8000-000000000007',
  rcvOld: 'b0000000-0000-4000-8000-000000000001',
  rcvSep: 'b0000000-0000-4000-8000-000000000002',
  rcvOct1: 'b0000000-0000-4000-8000-000000000003',
  rcvVoided: 'b0000000-0000-4000-8000-000000000004',
  invOct: 'c0000000-0000-4000-8000-000000000001',
  invVoided: 'c0000000-0000-4000-8000-000000000002',
  apOld: 'd0000000-0000-4000-8000-000000000001',
  apOct: 'd0000000-0000-4000-8000-000000000002',
  apVoided: 'd0000000-0000-4000-8000-000000000003',
  payOld: 'e0000000-0000-4000-8000-000000000001',
  payOct: 'e0000000-0000-4000-8000-000000000002',
  purInvOct: 'f0000000-0000-4000-8000-000000000001',
  /** B-02 测试用操作人：`sys_user.id` 是 uuid 列，actor.userId 必须是合法 UUID */
  userA: '99999999-9999-4999-8999-111111111111',
  userNoDept: '99999999-9999-4999-8999-222222222222',
} as const;

/**
 * 种子数据（金额刻意用分位，验证 2 位小数口径）：
 *   客户 A 应收：08-15 1000.00 / 09-10 500.50 / 10-01 200.25 / 10-31 300.00 / 作废 999.00
 *   客户 A 回款：09-05 100.10 / 09-20 200.20 / 10-15 50.05 / 作废 888.00
 *   客户 A 销项发票：10-08 1060.00（关联 AR_1001）/ 作废 500.00
 *   ⇒ 10 月期初 = 1000.00 + 500.50 − 100.10 − 200.20 = 1200.20
 *      10 月本期借 = 200.25 + 300.00 = 500.25，本期贷 = 50.05
 *      10 月期末 = 1200.20 + 500.25 − 50.05 = 1650.40
 *   供应商 应付：09-15 3000.00 / 10-05 800.00 / 作废 777.00
 *   供应商 付款：09-25 1000.00 / 10-20 400.50
 *   ⇒ 10 月期初 = 2000.00，本期借 = 800.00，本期贷 = 400.50，期末 = 2400.50
 */
async function seed(harness: Harness): Promise<void> {
  const db = harness.db;
  await db.exec(`
    INSERT INTO md_customer (id, code, name, uscc, invoice_phone)
    VALUES
      ('${UUID.customer}', '${PREFIX}C001', '${PREFIX} 客户甲', '91310000TEST0001X', '021-00000001'),
      ('${UUID.customerB}', '${PREFIX}C002', '${PREFIX} 客户乙', NULL, NULL),
      ('${UUID.customerC}', '${PREFIX}C003', '${PREFIX} 客户丙', NULL, NULL);

    INSERT INTO md_supplier (id, code, name, contact_name, contact_phone)
    VALUES ('${UUID.supplier}', '${PREFIX}S001', '${PREFIX} 供应商甲', '张三', '021-00000002');

    INSERT INTO erp_contract (id, code, name, customer_id, amount, tax_rate)
    VALUES ('${UUID.contract}', '${PREFIX}CT001', '${PREFIX} 合同甲', '${UUID.customer}', '10000', '6');

    -- 客户丙的合同必须先于引用它的 erp_ar / erp_project_revenue 插入：
    -- fk_erp_ar_contract 现在会在写入时校验父合同存在。
    INSERT INTO erp_contract (id, code, name, customer_id, amount, tax_rate)
    VALUES ('${UUID.contractC}', '${PREFIX}CT003', '${PREFIX} 合同丙', '${UUID.customerC}', '300', '6');

    INSERT INTO erp_project (id, code, name, dept_name, pm_user_id)
    VALUES ('${UUID.project}', '${PREFIX}P001', '${PREFIX} 项目甲', '${PREFIX}数据部', '${PREFIX}pm-user');

    INSERT INTO erp_ar (id, code, contract_id, customer_id, project_id, amount, settled_amount, due_date, status, source, _created_at)
    VALUES
      ('${UUID.arOld}',  '${PREFIX}ARR0001', '${UUID.contract}', '${UUID.customer}', '${UUID.project}', '1000.00', '1000.00', '2026-09-30', 'settled', 'manual', '2026-08-15 10:00:00+08'),
      ('${UUID.arSep}',  '${PREFIX}ARR0002', '${UUID.contract}', '${UUID.customer}', '${UUID.project}', '500.50',  '0.00',    '2026-10-31', 'open',    'manual', '2026-09-10 10:00:00+08'),
      ('${UUID.arOct1}', '${PREFIX}ARR0003', '${UUID.contract}', '${UUID.customer}', '${UUID.project}', '200.25',  '20.25',   '2026-11-30', 'partial', 'manual', '2026-10-01 09:00:00+08'),
      ('${UUID.arOct31}','${PREFIX}ARR0004', '${UUID.contract}', '${UUID.customer}', '${UUID.project}', '300.00',  '0.00',    '2026-12-31', 'open',    'manual', '2026-10-31 23:30:00+08'),
      ('${UUID.arVoided}','${PREFIX}ARR0005','${UUID.contract}', '${UUID.customer}', '${UUID.project}', '999.00',  '0.00',    '2026-12-31', 'voided',  'manual', '2026-10-05 10:00:00+08'),
      ('${UUID.arAugClosed}','${PREFIX}ARR0006','${UUID.contractC}','${UUID.customerC}','${UUID.project}','300.00','300.00','2026-08-31', 'settled', 'manual', '2026-08-20 10:00:00+08');

    -- 客户丙的收入确认单：erp_revenue_adjust 自身没有 customer_id，
    -- 只能经 revenue_id -> erp_project_revenue.contract_id -> erp_contract.customer_id
    -- 关联到客户；合同已在前面插入。
    INSERT INTO erp_project_revenue (id, code, project_id, contract_id, period, method, amount, status)
    VALUES ('${UUID.revenueC}', '${PREFIX}REV003', '${UUID.project}', '${UUID.contractC}', '2026-08', 'milestone', '300.00', 'recognized');

    -- 收入折让：模拟 ArService.applyCredit 冲减应收后的结果。
    -- 真实系统里 applyCredit 只增加 erp_ar.settled_amount、不写回款行，
    -- 折让痕迹只留在 erp_revenue_adjust 上 —— 对账单必须读它才能把余额冲平。
    -- _created_at 显式落在 8 月：该表无独立业务日期列，对账单以登记日为准（**需财务确认**），
    -- 若用默认 CURRENT_TIMESTAMP 会落到"今天"，导致折让被算到错误的期间。
    INSERT INTO erp_revenue_adjust (id, code, revenue_id, adjust_type, amount, reason, status, _created_at)
    VALUES ('${UUID.adjustC}', '${PREFIX}ADJ003', '${UUID.revenueC}', 'credit', '300.00', '${PREFIX} 收入折让冲减应收', 'applied', '2026-08-20 11:00:00+08');

    -- 客户丁：8 月一笔应收，**无任何冲减** → 10 月期初 500、本期 0 行、期末 500。
    -- 用于验证"本期无发生额但有期初余额"的对手方仍出现在下拉中。
    -- 注意 md_customer 没有 contact_name/contact_phone 列（那两列在 md_supplier 上）。
    INSERT INTO md_customer (id, code, name)
    VALUES ('${UUID.customerD}', '${PREFIX}C004', '${PREFIX} 客户丁');

    INSERT INTO erp_ar (id, code, contract_id, customer_id, project_id, amount, settled_amount, due_date, status, source, _created_at)
    VALUES ('${UUID.arDCarried}','${PREFIX}ARR0007','${UUID.contract}','${UUID.customerD}','${UUID.project}','500.00','0.00','2026-10-15', 'open', 'manual', '2026-08-25 10:00:00+08');

    INSERT INTO erp_receipt (id, code, customer_id, amount, used_amount, receipt_date, method, status)
    VALUES
      ('${UUID.rcvOld}',   '${PREFIX}RCV0001', '${UUID.customer}', '100.10', '100.10', '2026-09-05', 'bank', 'matched'),
      ('${UUID.rcvSep}',   '${PREFIX}RCV0002', '${UUID.customer}', '200.20', '200.20', '2026-09-20', 'bank', 'matched'),
      ('${UUID.rcvOct1}',  '${PREFIX}RCV0003', '${UUID.customer}', '50.05',  '0.00',   '2026-10-15', 'bank', 'unmatched'),
      ('${UUID.rcvVoided}','${PREFIX}RCV0004', '${UUID.customer}', '888.00', '0.00',   '2026-10-06', 'bank', 'voided');

    INSERT INTO erp_invoice (id, code, contract_id, customer_id, invoice_type, amount, tax_rate, tax_amount, invoice_date, status, direction, ar_id)
    VALUES
      ('${UUID.invOct}',   '${PREFIX}INV0001', '${UUID.contract}', '${UUID.customer}', 'vat_special', '1060.00', '6', '60.00', '2026-10-08', 'issued', 'sales', '${UUID.arSep}'),
      ('${UUID.invVoided}','${PREFIX}INV0002', '${UUID.contract}', '${UUID.customer}', 'vat_special', '500.00',  '6', '28.30', '2026-10-09', 'voided', 'sales', NULL);

    INSERT INTO erp_ap_bill (id, code, supplier_id, project_id, amount, paid_amount, due_date, status, source, _created_at)
    VALUES
      ('${UUID.apOld}',   '${PREFIX}APB0001', '${UUID.supplier}', '${UUID.project}', '3000.00', '1000.00', '2026-09-30', 'partial', 'manual', '2026-09-15 10:00:00+08'),
      ('${UUID.apOct}',   '${PREFIX}APB0002', '${UUID.supplier}', '${UUID.project}', '800.00',  '0.00',    '2026-11-30', 'pending', 'manual', '2026-10-05 10:00:00+08'),
      ('${UUID.apVoided}','${PREFIX}APB0003', '${UUID.supplier}', '${UUID.project}', '777.00',  '0.00',    '2026-12-31', 'voided',  'manual', '2026-10-06 10:00:00+08');

    INSERT INTO erp_payment (id, code, ap_id, supplier_id, amount, used_amount, pay_date, method, status)
    VALUES
      ('${UUID.payOld}', '${PREFIX}PAY0001', '${UUID.apOld}', '${UUID.supplier}', '1000.00', '1000.00', '2026-09-25', 'bank', 'paid'),
      ('${UUID.payOct}', '${PREFIX}PAY0002', '${UUID.apOct}', '${UUID.supplier}', '400.50',  '0.00',    '2026-10-20', 'bank', 'approved');

    INSERT INTO erp_invoice (id, code, supplier_id, ap_id, invoice_type, amount, tax_rate, tax_amount, invoice_date, status, direction)
    VALUES ('${UUID.purInvOct}', '${PREFIX}INV0003', '${UUID.supplier}', '${UUID.apOct}', 'vat_special', '800.00', '6', '45.28', '2026-10-07', 'issued', 'purchase');
  `);
}

describe('C-11 对账单 SQL 集成（pglite + 真实 StatementService）', () => {
  let harness: Harness;
  let service: StatementService;
  let dataScope: DataScopeService;

  beforeAll(async () => {
    harness = await createHarness();
    await seed(harness);
    const orm = harness.orm as unknown as PostgresJsDatabase;
    dataScope = new DataScopeService(orm);
    service = new StatementService(orm, dataScope);
  }, FLOW_TIMEOUT_MS);

  afterAll(async () => {
    await harness?.close();
  });

  it('种子数据本身满足"应收/应付日期不落在期间边界之外"的假设', async () => {
    const rows = await queryRows<{ biz_date: string; total: string }>(
      harness.db,
      `SELECT (_created_at AT TIME ZONE 'Asia/Shanghai')::date::text AS biz_date,
              amount::text AS total
         FROM erp_ar WHERE id = $1`,
      [UUID.arOct31]
    );
    expect(rows[0].biz_date).toBe('2026-10-31');
    expect(Number(rows[0].total)).toBe(300);
  });

  it('客户对账单：期初/本期/期末与作废剔除、发票备查', async () => {
    const result: StatementResult = await service.getCustomerStatement(
      UUID.customer,
      '2026-10'
    );

    expect(result.counterparty.name).toBe(`${PREFIX} 客户甲`);
    expect(result.counterparty.uscc).toBe('91310000TEST0001X');
    expect(result.periodRange).toEqual({
      start: '2026-10-01',
      end: '2026-11-01',
      monthEnd: '2026-10-31',
    });

    // 期初 = 9 月及以前：1000.00 + 500.50 − 100.10 − 200.20
    expect(result.openingBalance).toBe(1200.2);
    expect(result.periodDebit).toBe(500.25);
    expect(result.periodCredit).toBe(50.05);
    expect(result.closingBalance).toBe(1650.4);
    expect(result.closingBalanceInWords).toBe('壹仟陆佰伍拾元肆角整');

    // 本期行：AR(10-01) / AR(10-31) / RCV(10-15) / 发票(10-08) = 4 行
    expect(result.lines.map((line) => line.docCode)).toEqual([
      `${PREFIX}ARR0003`,
      `${PREFIX}INV0001`,
      `${PREFIX}RCV0003`,
      `${PREFIX}ARR0004`,
    ]);
    expect(result.lines.map((line) => line.runningBalance)).toEqual([
      1400.45, null, 1350.4, 1650.4,
    ]);

    // 发票备查行：有金额但不参与余额
    const invoiceLine = result.lines[1];
    expect(invoiceLine.docType).toBe('invoice');
    expect(invoiceLine.affectsBalance).toBe(false);
    expect(invoiceLine.status).toBe('informational');
    expect(invoiceLine.debit).toBe(1060);
    expect(invoiceLine.runningBalance).toBeNull();
    expect(invoiceLine.relatedDocCode).toBe(`${PREFIX}ARR0002`);

    // 作废单据整单剔除：1 张作废应收 + 1 张作废回款 + 1 张作废发票
    expect(result.excludedLines.map((line) => line.docCode).sort()).toEqual([
      `${PREFIX}ARR0005`,
      `${PREFIX}INV0002`,
      `${PREFIX}RCV0004`,
    ]);
    expect(result.reconSummary.voidedExcluded).toBe(3);

    // 期初构成：4 笔（应收 2 + 回款 2）
    expect(result.openingLines).toHaveLength(4);
    expect(result.openingLines.every((line) => line.runningBalance === null)).toBe(
      true
    );

    // 核对进度：只统计参与余额的 3 笔（发票备查行不计）
    //   ARR0003 settled 20.25 / amount 200.25 → partial
    //   RCV0003 used 0 / amount 50.05          → open
    //   ARR0004 settled 0 / amount 300         → open
    expect(result.reconSummary).toEqual({
      reconciled: 0,
      partial: 1,
      open: 2,
      voidedExcluded: 3,
    });
    expect(result.lines[2].status).toBe('open');
  });

  it('期间边界：8 月与 9 月首尾相接，10-31 与 11-01 归属正确', async () => {
    const august = await service.getCustomerStatement(UUID.customer, '2026-08');
    expect(august.openingBalance).toBe(0);
    expect(august.periodDebit).toBe(1000);
    expect(august.closingBalance).toBe(1000);

    const september = await service.getCustomerStatement(UUID.customer, '2026-09');
    expect(september.openingBalance).toBe(august.closingBalance);
    expect(september.periodDebit).toBe(500.5);
    expect(september.periodCredit).toBe(300.3);
    expect(september.closingBalance).toBe(1200.2);

    const november = await service.getCustomerStatement(UUID.customer, '2026-11');
    expect(november.openingBalance).toBe(1650.4);
    expect(november.lines).toHaveLength(0);
    expect(november.closingBalance).toBe(1650.4);
  });

  it('对手方无任何单据：全零且不抛错', async () => {
    const result = await service.getCustomerStatement(UUID.customerB, '2026-10');
    expect(result.counterparty.name).toBe(`${PREFIX} 客户乙`);
    expect(result.openingBalance).toBe(0);
    expect(result.periodDebit).toBe(0);
    expect(result.periodCredit).toBe(0);
    expect(result.closingBalance).toBe(0);
    expect(result.lines).toEqual([]);
    expect(result.excludedLines).toEqual([]);
  });

  it('客户不存在 / 期间非法：可读中文报错', async () => {
    await expect(
      service.getCustomerStatement('99999999-9999-4999-8999-999999999999', '2026-10')
    ).rejects.toThrow('客户不存在');
    await expect(
      service.getCustomerStatement(UUID.customer, '2026-13')
    ).rejects.toThrow('period 格式必须为 YYYY-MM');
  });

  it('供应商对账单：应付为借、付款为贷，作废应付与备查进项发票处理正确', async () => {
    const result = await service.getSupplierStatement(UUID.supplier, '2026-10');

    expect(result.counterparty.name).toBe(`${PREFIX} 供应商甲`);
    expect(result.openingBalance).toBe(2000);
    expect(result.periodDebit).toBe(800);
    expect(result.periodCredit).toBe(400.5);
    // 2000 + 800 − 400.50
    expect(result.closingBalance).toBe(2399.5);
    expect(result.closingBalanceInWords).toBe('贰仟叁佰玖拾玖元伍角整');

    expect(result.lines.map((line) => line.docCode)).toEqual([
      `${PREFIX}APB0002`,
      `${PREFIX}INV0003`,
      `${PREFIX}PAY0002`,
    ]);
    const purchaseInvoice = result.lines[1];
    expect(purchaseInvoice.docType).toBe('invoice');
    expect(purchaseInvoice.affectsBalance).toBe(false);
    expect(purchaseInvoice.relatedDocCode).toBe(`${PREFIX}APB0002`);

    expect(result.excludedLines.map((line) => line.docCode)).toEqual([
      `${PREFIX}APB0003`,
    ]);
    expect(result.reconSummary).toMatchObject({
      open: 2, // APB0002 未付款、PAY0002 未核销
      voidedExcluded: 1,
    });
    // APB0002 未付款 → 未核销
    expect(result.lines[0].status).toBe('open');
    // PAY0002 未核销 → 未核销
    expect(result.lines[2].status).toBe('open');
  });

  it('对手方下拉：只列有业务的对手方，并给出最近业务日期', async () => {
    const customers = await service.listCounterparties('customer');
    const mine = customers.filter((item) => item.id === UUID.customer);
    expect(mine).toHaveLength(1);
    // 10-31 的应收登记日 > 10-15 回款日
    expect(mine[0].lastDocDate).toBe('2026-10-31');
    // 客户乙无任何业务，不应出现
    expect(customers.some((item) => item.id === UUID.customerB)).toBe(false);

    const suppliers = await service.listCounterparties('supplier');
    const supplierHit = suppliers.filter((item) => item.id === UUID.supplier);
    expect(supplierHit).toHaveLength(1);
    expect(supplierHit[0].lastDocDate).toBe('2026-10-20');
  });

  it('对手方下拉包含"本期无发生额、但有期初余额"的对手方', async () => {
    // 客户丁只有 8 月一笔应收（500.00）且**没有任何冲减**：
    // 10 月本期无发生额，但期初结转 500.00，期末仍是 500.00。
    // 它必须出现在下拉里 —— 否则用户没法对"本期看起来没有往来"的对手方出对账单，
    // 而它的账上明明还挂着余额。
    //
    // 注：这里刻意不用客户丙。丙的 8 月应收已被收入折让全额冲减
    // （见本文件"核销/折让结清"用例），其期初与期末都是 0，
    // 用它测"有期初余额"会让断言与业务含义脱节。
    const october = await service.getCustomerStatement(UUID.customerD, '2026-10');
    expect(october.openingBalance).toBe(500);
    expect(october.periodDebit).toBe(0);
    expect(october.periodCredit).toBe(0);
    expect(october.closingBalance).toBe(500);
    expect(october.lines).toEqual([]);
    expect(october.openingLines).toHaveLength(1);

    // 8 月那张单确实被算进了 8 月账期
    const august = await service.getCustomerStatement(UUID.customerD, '2026-08');
    expect(august.openingBalance).toBe(0);
    expect(august.periodDebit).toBe(500);
    expect(august.closingBalance).toBe(500);

    const customers = await service.listCounterparties('customer');
    const hit = customers.filter((item) => item.id === UUID.customerD);
    expect(hit).toHaveLength(1);
    expect(hit[0].lastDocDate).toBe('2026-08-25');
  });

  /**
   * 应收被"核销/收入折让"结清时，对账单必须体现这笔冲减。
   *
   * 背景（曾经是一个真实缺口）：`ArService.applyCredit` 冲减应收时**只增加
   * `erp_ar.settled_amount`，不产生回款行**。对账单的余额原先只由
   * 「应收增加 / 回款减少」驱动，于是这张单在对账单上**永远显示全额余额**，
   * 而台账里它已经是 settled —— 对外单据与台账不一致，对方会据此认为我们还欠钱。
   *
   * 修复：把 `erp_revenue_adjust`（`status='applied'`）的折让额作为
   * `docType='adjust'` 的**贷方行**纳入对账单（见 `collectCustomerTxns`）。
   *
   * ⚠️ 仍需财务确认：对账单上折让应当显示为"贷方冲减"（本实现）
   * 还是"红字应收"；两者余额结果相同，但外发单据的观感不同。
   */
  it('核销/折让结清的应收，对账单以「收入折让」贷方行体现冲减，期末余额归零', async () => {
    const august = await service.getCustomerStatement(UUID.customerC, '2026-08');
    // 台账 settled_amount = 300（已结清）→ 对账单期末必须是 0
    expect(august.closingBalance).toBe(0);
    // 且必须有一行 adjust 类型、落在贷方的折让行，而不是凭空消失
    const adjustLines = august.lines.filter((line) => line.docType === 'adjust');
    expect(adjustLines).toHaveLength(1);
    expect(adjustLines[0].credit).toBe(300);
    expect(adjustLines[0].debit).toBe(0);
    // 折让行必须参与余额滚动（否则余额还是错的）
    expect(adjustLines[0].affectsBalance).toBe(true);
  });

  it('B-02：self 范围按应收责任人放行/拦截（EXISTS 子查询真实取数）', async () => {
    await harness.db.exec(`
      INSERT INTO sys_data_scope (role_code, resource_type, scope, custom_ids, enabled)
      VALUES ('${PREFIX}self-role', 'finance_ledger', 'self', '[]', 1)
      ON CONFLICT (role_code, resource_type) DO UPDATE
        SET scope = EXCLUDED.scope, custom_ids = EXCLUDED.custom_ids, enabled = 1;
    `);
    try {
      // 注意：actor.userId 会用于查 `sys_user.id`（uuid 列），
      // 因此测试里的 userId 必须是合法 UUID，否则 pglite 会报 22P02
      // （生产环境 userId 来自 JWT，本身就是 UUID）。
      const owner = UUID.userA;
      await harness.db.exec(
        `UPDATE erp_ar SET owner_user_id = '${owner}' WHERE id = '${UUID.arSep}'`
      );
      const actor = {
        userId: owner,
        userName: `${PREFIX} 责任人`,
        roles: [`${PREFIX}self-role`],
      };
      // 客户甲有本人负责的应收 → 放行
      const allowed = await service.getCustomerStatement(UUID.customer, '2026-10', actor);
      expect(allowed.closingBalance).toBe(1650.4);
      // 客户丙的应收责任人是别人（NULL）→ 403
      await expect(
        service.getCustomerStatement(UUID.customerC, '2026-10', actor)
      ).rejects.toBeInstanceOf(ForbiddenException);
    } finally {
      await harness.db.exec(
        `UPDATE erp_ar SET owner_user_id = NULL WHERE id = '${UUID.arSep}'`
      );
      await harness.db.exec(
        `DELETE FROM sys_data_scope WHERE role_code = '${PREFIX}self-role'`
      );
    }
  });

  it('B-02：dept 范围按项目归属部门放行/拦截（EXISTS 子查询真实取数）', async () => {
    await harness.db.exec(`
      INSERT INTO sys_data_scope (role_code, resource_type, scope, custom_ids, enabled)
      VALUES ('${PREFIX}dept-role', 'finance_ledger', 'dept_and_child', '[]', 1)
      ON CONFLICT (role_code, resource_type) DO UPDATE
        SET scope = EXCLUDED.scope, custom_ids = EXCLUDED.custom_ids, enabled = 1;
    `);
    try {
      // 未绑定员工、sys_user 里也没有该用户 → 部门集合为空 → fail-closed 403
      const unknown = {
        userId: UUID.userNoDept,
        userName: `${PREFIX} 无部门用户`,
        roles: [`${PREFIX}dept-role`],
      };
      await expect(
        service.getCustomerStatement(UUID.customer, '2026-10', unknown)
      ).rejects.toBeInstanceOf(ForbiddenException);
    } finally {
      await harness.db.exec(
        `DELETE FROM sys_data_scope WHERE role_code = '${PREFIX}dept-role'`
      );
    }
  });

  it('B-02：custom 范围未授权该对手方时抛 403（fail-closed）', async () => {
    // 造一条 finance_ledger 的 custom 范围配置，只授权"客户乙"
    await harness.db.exec(`
      INSERT INTO sys_data_scope (role_code, resource_type, scope, custom_ids, enabled)
      VALUES ('${PREFIX}role', 'finance_ledger', 'custom', '["${UUID.customerB}"]', 1)
      ON CONFLICT (role_code, resource_type) DO UPDATE
        SET scope = EXCLUDED.scope, custom_ids = EXCLUDED.custom_ids, enabled = 1;
    `);
    const actor = {
      userId: `${PREFIX}user-1`,
      userName: `${PREFIX} 用户一`,
      roles: [`${PREFIX}role`],
    };

    // 未授权的客户甲 → 403
    await expect(
      service.getCustomerStatement(UUID.customer, '2026-10', actor)
    ).rejects.toBeInstanceOf(ForbiddenException);
    // 已授权的客户乙 → 放行（无单据，全零）
    const allowed = await service.getCustomerStatement(
      UUID.customerB,
      '2026-10',
      actor
    );
    expect(allowed.closingBalance).toBe(0);

    // 清理：不留 [API_TEST] 配置（AGENTS.md 约定接口自测数据用后即删）
    await harness.db.exec(
      `DELETE FROM sys_data_scope WHERE role_code = '${PREFIX}role'`
    );
  });

  /**
   * P1-7：未配置即拒绝（fail-closed）。
   *
   * ⚠️ **本用例推翻了需求书 B-02 的原契约**（原契约："未配置范围的角色按既有行为放行，
   * 不收紧"）。变更经确认后按"默认 fail-closed"落地，理由是没配置就等于没授权，
   * 而不是等于全部可见。为免新环境瞬间变空，收紧的**前提是"该资源类型已经在用行级权限"**
   * （存在 enabled 配置行）；一个从没配置过的资源仍按原行为放行。
   *
   * 逃生开关：`DATA_SCOPE_UNCONFIGURED_POLICY=allow` 可整体退回 B-02 原契约（排障用）。
   */
  it('P1-7：该资源已启用行级权限时，未配置角色按 fail-closed 拒绝；开关 allow 可回退', async () => {
    // 前置条件：让 finance_ledger 处于"已启用行级权限"状态（由另一角色持有配置行）
    await harness.db.exec(`
      INSERT INTO sys_data_scope (role_code, resource_type, scope, custom_ids, enabled)
      VALUES ('${PREFIX}in-use-role', 'finance_ledger', 'self', '[]', 1)
      ON CONFLICT (role_code, resource_type) DO UPDATE SET enabled = 1;
    `);
    const actor = {
      userId: `${PREFIX}user-2`,
      userName: `${PREFIX} 用户二`,
      roles: [`${PREFIX}no-such-role`],
    };
    try {
      // 默认策略（deny）：没有配置行 → 拒绝，而不是看到全部数据
      await expect(
        service.getCustomerStatement(UUID.customer, '2026-10', actor)
      ).rejects.toBeInstanceOf(ForbiddenException);

      // 逃生开关：退回 B-02 原契约（未配置 → 放行既有行为）
      process.env.DATA_SCOPE_UNCONFIGURED_POLICY = 'allow';
      const result = await service.getCustomerStatement(
        UUID.customer,
        '2026-10',
        actor
      );
      expect(result.closingBalance).toBe(1650.4);
    } finally {
      delete process.env.DATA_SCOPE_UNCONFIGURED_POLICY;
      await harness.db.exec(
        `DELETE FROM sys_data_scope WHERE role_code = '${PREFIX}in-use-role'`
      );
    }
  });
});

