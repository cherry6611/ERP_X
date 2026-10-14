/**
 * 全量业务样例验收：登录 → 造数 → 财税断言 → 输出 JSON 报告
 * node scripts/full-acceptance.mjs
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.API_BASE || 'http://127.0.0.1:3000';
const USER = process.env.ACCEPT_USER;
const PASS = process.env.ACCEPT_PASS;
if (!USER || !PASS) {
  console.error('缺少 ACCEPT_USER / ACCEPT_PASS（勿在脚本中内置口令）');
  process.exit(1);
}
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');

const issues = [];
const samples = {};
const results = [];
let cookie = '';
let actorUserId = '';

function splitTax(amount, rate) {
  const tax = Math.round(((amount * rate) / (100 + rate)) * 100) / 100;
  const net = Math.round((amount - tax) * 100) / 100;
  return { net, tax };
}

function issue(id, severity, module, detail, repro = '') {
  issues.push({ id, severity, module, detail, repro, status: 'OPEN' });
}

function absorbCookies(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  const raw = res.headers.get('set-cookie');
  const all = list.length ? list : raw ? [raw] : [];
  const jar = new Map(
    cookie
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((p) => {
        const i = p.indexOf('=');
        return [p.slice(0, i), p.slice(i + 1)];
      }),
  );
  for (const c of all) {
    const part = String(c).split(';')[0];
    const i = part.indexOf('=');
    if (i > 0) jar.set(part.slice(0, i), part.slice(i + 1));
  }
  cookie = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function req(method, path, body, expectOk = true) {
  const headers = {};
  if (cookie) headers.Cookie = cookie;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  absorbCookies(res);
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  const ok = res.status >= 200 && res.status < 300;
  if (expectOk && !ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  return { status: res.status, ok, data };
}

async function step(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail ?? null });
    console.log(`✓ ${name}`);
    return detail;
  } catch (e) {
    results.push({ name, ok: false, error: String(e.message || e) });
    console.log(`✗ ${name}: ${e.message || e}`);
    issue(`T-${results.length}`, 'P1', name, String(e.message || e));
    return null;
  }
}

async function main() {
  await step('登录', async () => {
    const r = await req('POST', '/api/auth/login', { username: USER, password: PASS });
    if (!r.data?.user?.roles?.includes('admin')) throw new Error('非 admin 角色');
    if (!cookie.includes('erp_session=')) throw new Error('未拿到 erp_session cookie');
    actorUserId = r.data.user.userId;
    return { user: r.data.user.userName, userId: actorUserId };
  });

  // 财税负例：小规模不允许 13%
  await step('财税负例·小规模不可用13%', async () => {
    const r = await req(
      'POST',
      '/api/master-data/tax-entities',
      {
        code: `TE-BAD-${stamp}`,
        name: '非法税率主体',
        taxpayerType: 'small',
        defaultOutputRate: 13,
        defaultInputRate: 3,
      },
      false,
    );
    if (r.ok) {
      issue('TAX-01', 'P0', '纳税主体', '小规模纳税人允许创建销项13%，应拒绝', 'POST tax-entities small+13');
      throw new Error('应拒绝却成功');
    }
    return { status: r.status, msg: r.data?.message || r.data };
  });

  const tax = await step('创建纳税主体·一般纳税人6%', async () => {
    const listed = await req('GET', '/api/master-data/tax-entities');
    const existing = (listed.data || []).find(
      (t) => t.taxpayerType === 'general' && Number(t.defaultOutputRate) === 6,
    );
    if (existing) {
      samples.taxEntity = existing;
      await req('POST', `/api/master-data/tax-entities/${existing.id}/set-default`, {}, false);
      return { id: existing.id, code: existing.code, reused: true };
    }
    const r = await req('POST', '/api/master-data/tax-entities', {
      code: `TE-${stamp}`,
      name: '晟笙数据科技（测试）有限公司',
      uscc: `91110000MA${stamp.slice(-8)}`,
      taxpayerType: 'general',
      defaultOutputRate: 6,
      defaultInputRate: 6,
      invoiceTitle: '晟笙数据科技（测试）有限公司',
      remark: '全量验收样例',
    });
    samples.taxEntity = r.data;
    await req('POST', `/api/master-data/tax-entities/${r.data.id}/set-default`);
    return { id: r.data.id, code: r.data.code };
  });

  const customer = await step('创建客户·默认税率6%', async () => {
    const r = await req('POST', '/api/master-data/customers', {
      name: `验收客户-${stamp}`,
      industry: '软件和信息技术服务业',
      creditLevel: 'A',
      creditLimit: 500000,
      termsDays: 30,
      taxEntityId: tax?.id,
      defaultTaxRate: 6,
      remark: '全量验收样例客户',
    });
    samples.customer = r.data;
    return { id: r.data.id, code: r.data.code, name: r.data.name };
  });

  await step('客户联系人', async () => {
    if (!customer) throw new Error('无客户');
    const r = await req('POST', `/api/master-data/customers/${customer.id}/contacts`, {
      name: '张经理',
      phone: '13800138000',
      email: 'zhang@example.com',
      position: '采购',
      isPrimary: true,
    });
    samples.contact = r.data;
    return r.data;
  });

  const supplier = await step('创建供应商', async () => {
    const r = await req('POST', '/api/master-data/suppliers', {
      name: `验收供应商-${stamp}`,
      type: '外协',
      contactName: '李供应',
      contactPhone: '13900139000',
      taxEntityId: tax?.id,
      defaultTaxRate: 6,
      remark: '全量验收样例供应商',
    });
    samples.supplier = r.data;
    return { id: r.data.id, name: r.data.name };
  });

  const lead = await step('创建线索并转化商机', async () => {
    if (!customer) throw new Error('无客户');
    const created = await req('POST', '/api/crm/leads', {
      customerName: customer.name,
      customerId: customer.id,
      source: '验收测试',
      contactName: '张经理',
      contactPhone: '13800138000',
      remark: '验收线索',
    });
    samples.lead = created.data;
    const conv = await req('POST', `/api/crm/leads/${created.data.id}/convert`);
    samples.opportunityFromLead = conv.data;
    return { leadId: created.data.id, opportunityId: conv.data?.id || conv.data?.opportunityId };
  });

  const opportunity = await step('创建商机', async () => {
    if (!customer) throw new Error('无客户');
    const r = await req('POST', '/api/crm/opportunities', {
      customerId: customer.id,
      title: `数据中台建设商机-${stamp}`,
      amount: 106000,
      winRate: 60,
      remark: '验收商机',
    });
    samples.opportunity = r.data;
    return { id: r.data.id, title: r.data.title };
  });

  const quotation = await step('创建报价·明细金额与毛利', async () => {
    if (!customer) throw new Error('无客户');
    const r = await req('POST', '/api/crm/quotations', {
      customerId: customer.id,
      opportunityId: opportunity?.id,
      title: `数据中台一期报价-${stamp}`,
      quoteDate: '2026-10-14',
      validUntil: '2026-11-14',
      discountPct: 0,
      items: [
        {
          itemName: '咨询实施',
          unit: '人天',
          quantity: 20,
          unitPrice: 3000,
          discountPct: 0,
          estUnitCost: 1800,
        },
        {
          itemName: '平台授权',
          unit: '套',
          quantity: 1,
          unitPrice: 46000,
          discountPct: 0,
          estUnitCost: 10000,
        },
      ],
    });
    samples.quotation = r.data;
    const expectedTotal = 20 * 3000 + 46000; // 106000
    if (Math.abs(Number(r.data.totalAmount ?? r.data.amount ?? 0) - expectedTotal) > 0.01) {
      // try common field names
      const total = Number(r.data.totalAmount ?? r.data.amountInclTax ?? r.data.grossAmount ?? NaN);
      if (!Number.isNaN(total) && Math.abs(total - expectedTotal) > 0.01) {
        issue('Q-01', 'P1', '报价', `总额期望 ${expectedTotal} 实际 ${total}`, 'create quotation');
      }
    }
    await req('POST', `/api/crm/quotations/${r.data.id}/submit`);
    await req('POST', `/api/crm/quotations/${r.data.id}/approve`);
    return { id: r.data.id, code: r.data.code, total: r.data.totalAmount ?? r.data.amount };
  });

  await step('报价云文档·/file/ 链接应被后端识别或给出清晰错误', async () => {
    const fileUrl = 'https://chengshengdata.feishu.cn/file/ObV6bEa0yoB6eZxu9uocgEv6nNd';
    const r = await req('POST', '/api/crm/quotations/parse-doc', { docUrl: fileUrl }, false);
    if (r.ok) return { parsed: true };
    const msg = JSON.stringify(r.data);
    if (msg.includes('/docx/') && !msg.includes('/file/')) {
      issue(
        'B-01',
        'P0',
        '报价·云文档',
        '前端与后端仅接受 /docx/，真实飞书 file 链接无法解析',
        fileUrl,
      );
    }
    return { status: r.status, msg: r.data?.message || r.data };
  });

  const contract = await step('登记合同·价税拆分6%', async () => {
    if (!customer || !tax) throw new Error('缺客户/税主体');
    const amount = 106000;
    const rate = 6;
    const expect = splitTax(amount, rate);
    const r = await req('POST', '/api/contracts', {
      name: `数据中台一期合同-${stamp}`,
      customerId: customer.id,
      billingModel: 'project',
      amount,
      taxRate: rate,
      taxEntityId: tax.id,
      signDate: '2026-10-14',
      startDate: '2026-10-15',
      endDate: '2027-04-15',
      paymentTerms: '验收后30天',
      milestones: [
        { name: '启动款', amount: 31800, dueDate: '2026-10-20' },
        { name: '中期款', amount: 42400, dueDate: '2027-01-15' },
        { name: '尾款', amount: 31800, dueDate: '2027-04-15' },
      ],
    });
    samples.contract = r.data;
    const net = Number(r.data.netAmount);
    const taxAmt = Number(r.data.taxAmount);
    if (Math.abs(net - expect.net) > 0.02) {
      issue('TAX-02', 'P0', '合同财税', `不含税期望 ${expect.net} 实际 ${net}`, 'create contract 106000@6%');
    }
    if (Math.abs(taxAmt - expect.tax) > 0.02) {
      issue('TAX-03', 'P0', '合同财税', `税额期望 ${expect.tax} 实际 ${taxAmt}`, 'create contract 106000@6%');
    }
    // 业务规则：提交前必须有明细行。里程碑不足以提交——记为产品摩擦点，并自动补明细以继续链路。
    if (quotation?.id) {
      const imp = await req(
        'POST',
        `/api/contracts/${r.data.id}/items/import-quotation`,
        { quotationId: quotation.id },
        false,
      );
      if (!imp.ok) {
        issue(
          'CTR-01',
          'P1',
          '合同',
          '创建合同时有里程碑仍无法提交（需明细）；从报价导入明细失败: ' + JSON.stringify(imp.data),
          'contract submit without items',
        );
        await req('POST', `/api/contracts/${r.data.id}/items`, {
          itemName: '数据中台一期服务',
          quantity: 1,
          unitPrice: amount,
          taxRate: rate,
        });
      }
    } else {
      await req('POST', `/api/contracts/${r.data.id}/items`, {
        itemName: '数据中台一期服务',
        quantity: 1,
        unitPrice: amount,
        taxRate: rate,
      });
      issue(
        'CTR-01',
        'P1',
        '合同',
        '创建合同仅填金额/里程碑时无法提交生效，必须另加明细行（易踩坑）',
        '合同登记后直接提交',
      );
    }
    await req('POST', `/api/contracts/${r.data.id}/status`, { action: 'submit' });
    await req('POST', `/api/contracts/${r.data.id}/status`, { action: 'approve' });
    await req('POST', `/api/contracts/${r.data.id}/status`, { action: 'start' });
    const fresh = await req('GET', `/api/contracts/${r.data.id}`);
    samples.contract = fresh.data;
    return {
      id: fresh.data.id,
      code: fresh.data.code,
      expect,
      net: fresh.data.netAmount,
      tax: fresh.data.taxAmount,
      taxRate: fresh.data.taxRate,
      status: fresh.data.status,
    };
  });

  // 一般纳税人禁止 3% 输出（若业务有校验）
  await step('财税·一般纳税人合同税率3%应拒绝或纠正', async () => {
    if (!customer || !tax) throw new Error('缺前置');
    const r = await req(
      'POST',
      '/api/contracts',
      {
        name: `非法税率合同-${stamp}`,
        customerId: customer.id,
        billingModel: 'project',
        amount: 10000,
        taxRate: 3,
        taxEntityId: tax.id,
      },
      false,
    );
    if (r.ok) {
      issue(
        'TAX-04',
        'P1',
        '合同财税',
        '一般纳税人主体下合同税率3%被接受（小规模税率），与 ALLOWED_RATES 不一致',
        'create contract general+3%',
      );
      return { accepted: true, id: r.data?.id };
    }
    return { rejected: true, status: r.status, msg: r.data?.message };
  });

  const project = await step('项目立项', async () => {
    if (!contract) throw new Error('无合同');
    const r = await req('POST', '/api/projects', {
      name: `数据中台一期项目-${stamp}`,
      contractId: contract.id,
      budget: 80000,
      estimatedTotalCost: 56000,
      startDate: '2026-10-15',
      endDate: '2027-04-15',
      remark: '验收项目',
    });
    samples.project = r.data;
    await req('POST', `/api/projects/${r.data.id}/status`, { action: 'approve' }).catch(() => null);
    return { id: r.data.id, code: r.data.code };
  });

  await step('成本归集', async () => {
    if (!project) throw new Error('无项目');
    const r = await req('POST', '/api/costs', {
      projectId: project.id,
      costType: 'outsource',
      amount: 12000,
      occurredDate: '2026-10-16',
      sourceRef: `COST-${stamp}`,
      supplierId: supplier?.id,
      remark: '外协验收成本',
    });
    samples.cost = r.data;
    return { id: r.data.id, amount: r.data.amount };
  });

  // HR 前置：工时登记要求当前账号绑定员工
  await step('部门与员工', async () => {
    const dept = await req('POST', '/api/hr/departments', {
      name: `验收部门-${stamp}`,
      remark: '全量验收',
    });
    samples.dept = dept.data;
    const emp = await req('POST', '/api/hr/employees', {
      name: `验收员工-${stamp}`,
      departmentId: dept.data.id,
      hireDate: '2026-01-01',
      employmentType: 'full_time',
      status: 'active',
      phone: '13700137000',
      platformUserId: actorUserId || undefined,
    });
    samples.employee = emp.data;
    return { deptId: dept.data.id, empId: emp.data.id, bound: Boolean(actorUserId) };
  });

  await step('工时登记', async () => {
    if (!project) throw new Error('无项目');
    const r = await req('POST', '/api/costs/timesheets', {
      projectId: project.id,
      employeeId: samples.employee?.id,
      employeeName: samples.employee?.name || '验收工程师',
      roleName: '实施顾问',
      workDate: '2026-10-16',
      hours: 8,
      remark: '验收工时',
    });
    samples.timesheet = r.data;
    return r.data;
  });

  await step('收入确认', async () => {
    if (!project) throw new Error('无项目');
    const r = await req('POST', '/api/revenues', {
      projectId: project.id,
      period: '2026-10',
      method: 'milestone',
      amount: 31800,
      basis: '启动款里程碑',
      remark: '验收收入',
    });
    samples.revenue = r.data;
    return { id: r.data.id, amount: r.data.amount };
  });

  await step('应收·开票·回款核销', async () => {
    if (!contract || !customer) throw new Error('缺前置');
    const ar = await req('POST', '/api/finance/ars', {
      contractId: contract.id,
      amount: 31800,
      dueDate: '2026-11-20',
      projectId: project?.id,
      remark: '启动款应收',
    });
    samples.ar = ar.data;
    // 先开票（需未核销应收余额），再回款核销
    const inv = await req('POST', '/api/finance/invoices', {
      contractId: contract.id,
      invoiceType: 'vat_special',
      direction: 'sales',
      arId: ar.data.id,
      amount: 31800,
      taxRate: 6,
      projectId: project?.id,
      invoiceNo: `INV${stamp}`,
      invoiceDate: '2026-10-20',
      remark: '启动款销项票',
    });
    samples.invoice = inv.data;
    const receipt = await req('POST', '/api/finance/receipts', {
      customerId: customer.id,
      amount: 31800,
      receiptDate: '2026-10-20',
      method: 'bank',
      remark: '启动款回款',
    });
    samples.receipt = receipt.data;
    const wo = await req('POST', '/api/finance/ar-writeoffs', {
      arId: ar.data.id,
      receiptId: receipt.data.id,
      amount: 31800,
    });
    samples.arWriteoff = wo.data;
    return { arId: ar.data.id, invoiceId: inv.data.id, receiptId: receipt.data.id };
  });

  await step('应付与付款', async () => {
    if (!supplier) throw new Error('无供应商');
    const ap = await req('POST', '/api/finance/aps', {
      supplierId: supplier.id,
      amount: 12000,
      dueDate: '2026-11-16',
      projectId: project?.id,
      remark: '外协应付',
    });
    samples.ap = ap.data;
    const pay = await req('POST', '/api/finance/payments', {
      apId: ap.data.id,
      amount: 12000,
      payDate: '2026-10-18',
      method: 'bank',
      remark: '外协付款',
    });
    samples.payment = pay.data;
    if (pay.data?.id) {
      await req('POST', `/api/finance/payments/${pay.data.id}/approve`, {}).catch(() => null);
    }
    return { apId: ap.data.id, paymentId: pay.data?.id };
  });

  await step('采购申请', async () => {
    const r = await req('POST', '/api/pur/requests', {
      title: `验收采购申请-${stamp}`,
      requestType: 'service',
      amount: 5000,
      projectId: project?.id,
      supplierId: supplier?.id,
      reason: '验收采购',
      remark: '验收采购',
    });
    samples.purRequest = r.data;
    return r.data;
  });

  await step('固定资产', async () => {
    const r = await req('POST', '/api/asset/assets', {
      name: `验收笔记本-${stamp}`,
      category: 'office',
      originalValue: 8000,
      purchaseDate: '2026-10-01',
      usefulMonths: 36,
      remark: '验收资产',
    });
    samples.asset = r.data;
    return r.data;
  });

  await step('租房合同', async () => {
    const r = await req('POST', '/api/admin/rent-contracts', {
      name: `验收租房-${stamp}`,
      propertyAddress: '北京市海淀区验收路1号',
      lessor: '房东甲',
      monthlyRent: 15000,
      deposit: 30000,
      startDate: '2026-01-01',
      endDate: '2026-12-31',
    });
    samples.rent = r.data;
    return r.data;
  });

  await step('预算', async () => {
    const r = await req('POST', '/api/fin-budget/budgets', {
      departmentId: samples.dept?.id,
      projectId: project?.id,
      expenseCategory: '项目实施',
      period: '2026-10',
      budgetAmount: 200000,
      remark: '验收预算',
    });
    samples.budget = r.data;
    return r.data;
  });

  await step('身份管理·列表', async () => {
    const r = await req('GET', '/api/identity/users');
    if (!Array.isArray(r.data) || r.data.length < 1) throw new Error('用户列表空');
    return { count: r.data.length };
  });

  await step('设置·品牌可读', async () => {
    const r = await req('GET', '/api/settings/brand');
    return r.data;
  });

  await step('云空间·列表', async () => {
    const r = await req('GET', '/api/drive/root', undefined, false);
    if (!r.ok) {
      issue('DRV-01', 'P2', '云空间', `根目录失败 ${r.status}: ${JSON.stringify(r.data)}`, 'GET /api/drive/root');
      throw new Error(JSON.stringify(r.data));
    }
    return { ok: true, keys: Object.keys(r.data || {}) };
  });

  await step('知识库', async () => {
    const r = await req('GET', '/api/wiki/space', undefined, false);
    if (!r.ok) {
      issue('WIKI-01', 'ENV', '知识库', `空间未配置或接口失败: ${JSON.stringify(r.data)}`, 'GET /api/wiki/space');
      throw new Error(JSON.stringify(r.data));
    }
    return r.data;
  });

  await step('审计日志', async () => {
    const r = await req('GET', '/api/audit/logs?limit=20');
    return { count: Array.isArray(r.data) ? r.data.length : r.data?.items?.length };
  });

  await step('经营看板指标非全零（有样例后）', async () => {
    const r = await req('GET', '/api/bi/overview');
    samples.bi = r.data;
    const amt = Number(r.data?.contractAmount ?? 0);
    if (!(amt > 0)) {
      issue('BI-01', 'P2', '经营看板', '已创建合同后 contractAmount 仍为 0', 'GET /api/bi/overview');
    }
    return r.data;
  });

  const report = {
    at: new Date().toISOString(),
    user: USER,
    stamp,
    pass: results.filter((r) => r.ok).length,
    fail: results.filter((r) => !r.ok).length,
    results,
    issues,
    samples: Object.fromEntries(
      Object.entries(samples).map(([k, v]) => [
        k,
        v && typeof v === 'object'
          ? { id: v.id, code: v.code, name: v.name || v.title, status: v.status }
          : v,
      ]),
    ),
  };

  const outDir = join(dirname(fileURLToPath(import.meta.url)), '../../deliverables');
  const outPath = join(outDir, `全量验收运行报告-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  console.log('\n=== SUMMARY ===');
  console.log(`pass=${report.pass} fail=${report.fail} issues=${issues.length}`);
  console.log(`report=${outPath}`);
  console.log(JSON.stringify(issues, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
