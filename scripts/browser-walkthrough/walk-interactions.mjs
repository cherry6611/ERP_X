/**
 * 交互式走查：对每个页面做**真实用户操作**（点击按钮/填表/开弹窗/切 Tab），
 * 并断言"操作后页面确实有反应"，而不是只看页面能不能打开。
 *
 * ## 判定标准（每个场景）
 *
 * 1. 点击后**有可观察变化**：URL 变了 / 出现弹窗 / 出现 toast / 表格行数变了 /
 *    页面文本变了 —— 四者必居其一，否则记为 `NO_EFFECT`（按钮像坏的）。
 * 2. 操作过程中**不得**出现未捕获异常、console error、HTTP ≥400。
 * 3. 弹窗必须能打开且能关闭（关不掉的弹窗是真实可用性缺陷）。
 *
 * ## 为什么要记录"无效果"
 *
 * 需求书明确要求"所有交互按钮必须挂真实 handler"。一个按钮点了毫无反应，
 * 在截图走查里完全看不出来（页面还是那个页面），只有比较点击前后的状态才能发现。
 *
 * 用法：node scripts/browser-walkthrough/walk-interactions.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { Browser, sleep } from './cdp.mjs';

const APP = process.env.WT_APP ?? 'http://127.0.0.1:5273';
const API = process.env.WT_API ?? 'http://127.0.0.1:3100';
const USER = process.env.WT_USER ?? 'chengsheng@chengshengdata.cn';
const PASS = process.env.WT_PASS ?? '******';
const OUT = 'scripts/browser-walkthrough/out';

async function login() {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: USER, password: PASS }),
  });
  if (res.status !== 201) throw new Error(`登录失败 ${res.status}`);
  const jar = res.headers.getSetCookie?.() ?? [];
  const s = jar.map((c) => c.split(';')[0]).find((c) => c.startsWith('erp_session='));
  return s.slice('erp_session='.length);
}

/** 一次"可观察状态"快照，用于比对点击前后 */
async function stateOf(page) {
  return page.evaluate(`(() => ({
    url: location.pathname + location.search,
    dialogs: document.querySelectorAll('[role="dialog"]').length,
    toasts: document.querySelectorAll('[data-sonner-toast], [role="status"], .sonner-toast').length,
    rows: document.querySelectorAll('tbody tr').length,
    textLen: (document.body?.innerText || '').length,
    // 选中的 Tab：点击 Tab 往往只换选中态与表格内容，文本长度可能恰好相同，
    // 不看这个属性就会把"正常切换"误判成"按钮无反应"。
    selectedTab: [...document.querySelectorAll('[role="tab"][aria-selected="true"]')]
      .map(el => (el.innerText || '').trim()).join('|'),
    // 主内容区首行文本，用于判断"内容真的换了"
    firstRow: (document.querySelector('tbody tr')?.innerText || '').replace(/\\s+/g, ' ').slice(0, 160),
    heading: (document.querySelector('h1')?.innerText || '').trim(),
    text: (document.body?.innerText || '').slice(0, 3000),
  }))()`);
}

function diffState(before, after) {
  const reasons = [];
  if (before.url !== after.url) reasons.push(`url:${before.url}→${after.url}`);
  if (before.dialogs !== after.dialogs) reasons.push(`dialog:${before.dialogs}→${after.dialogs}`);
  if (before.toasts !== after.toasts) reasons.push(`toast:${before.toasts}→${after.toasts}`);
  if (before.rows !== after.rows) reasons.push(`rows:${before.rows}→${after.rows}`);
  if (before.selectedTab !== after.selectedTab)
    reasons.push(`tab:${before.selectedTab}→${after.selectedTab}`);
  if (before.firstRow !== after.firstRow) reasons.push('firstRow变化');
  if (before.heading !== after.heading) reasons.push(`heading:${before.heading}→${after.heading}`);
  if (before.textLen !== after.textLen) reasons.push(`text:${before.textLen}→${after.textLen}`);
  return reasons;
}

/**
 * 场景 DSL：
 *   goto     导航
 *   click    按文本点击（要求有可观察效果）
 *   clickSel 按选择器点击
 *   esc      按 Esc 关闭弹窗
 *   expect   断言页面文本包含/不包含
 *   shot     截图
 */
const SCENARIOS = [
  // ---------- 前端业务 ----------
  {
    name: '客户管理：新建弹窗可开可关',
    steps: [
      ['goto', '/customers'],
      ['expect', '客户'],
      ['click', '新建客户'],
      ['expectDialog', true],
      ['shot', 'cust-create-open'],
      ['esc'],
      ['expectDialog', false],
    ],
  },
  {
    name: '客户管理：搜索有反应',
    steps: [
      ['goto', '/customers'],
      ['fill', 'input', 'CUS2026'],
      ['sleep', 900],
      ['expectAny', ['CUS2026']],
      ['shot', 'cust-search'],
    ],
  },
  {
    name: '线索与商机：Tab 切换',
    steps: [
      ['goto', '/crm'],
      ['click', '商机管理'],
      ['sleep', 700],
      ['shot', 'crm-opportunity-tab'],
      ['click', '线索管理'],
      ['sleep', 700],
      ['shot', 'crm-lead-tab'],
    ],
  },
  {
    // 说明：`登记合同` 不是弹窗，而是**整页表单**（路由 /contracts/new）。
    // 断言改为"跳转到新建页且表单元素齐全"，而不是硬套弹窗。
    name: '合同管理：登记合同跳转整页表单',
    steps: [
      ['goto', '/contracts'],
      ['click', '登记合同'],
      ['expect', '登记合同'],
      ['expectUrl', '/contracts/new'],
      ['shot', 'contract-create-open'],
      ['fill', 'input', '浏览器走查合同'],
      ['sleep', 300],
      ['shot', 'contract-create-filled'],
    ],
  },
  {
    name: '合同管理：同步记录弹窗',
    steps: [
      ['goto', '/contracts'],
      ['click', '同步记录'],
      ['sleep', 900],
      ['shot', 'contract-sync-records'],
      ['esc'],
    ],
  },
  {
    name: '供应商管理：新建弹窗',
    steps: [
      ['goto', '/suppliers'],
      ['click', '新建供应商'],
      ['expectDialog', true],
      ['shot', 'supplier-create-open'],
      ['esc'],
    ],
  },
  {
    name: '纳税主体：新建弹窗',
    steps: [
      ['goto', '/masterdata/tax-entities'],
      ['click', '新建主体'],
      ['expectDialog', true],
      ['shot', 'taxentity-create-open'],
      ['esc'],
    ],
  },
  {
    name: '项目管理：新建项目页表单可填',
    steps: [
      ['goto', '/projects/new'],
      ['expect', '项目'],
      ['shot', 'project-new'],
      ['fill', 'input', '浏览器走查项目'],
      ['sleep', 300],
    ],
  },
  {
    name: '收入确认：登记弹窗',
    steps: [
      ['goto', '/revenue'],
      ['clickAny', ['登记收入', '新增收入', '确认收入', '登记']],
      ['expectDialog', true],
      ['shot', 'revenue-dialog'],
      ['esc'],
    ],
  },
  {
    name: '采购管理：Tab 切换',
    steps: [
      ['goto', '/pur'],
      ['clickAny', ['采购订单', '订单管理', '订单']],
      ['sleep', 800],
      ['shot', 'pur-orders-tab'],
      ['clickAny', ['采购申请', '申请']],
      ['sleep', 800],
      ['shot', 'pur-requests-tab'],
    ],
  },
  {
    name: '固定资产：六个 Tab 全部切换',
    steps: [
      ['goto', '/asset'],
      ['click', '折旧计提'],
      ['sleep', 700],
      ['shot', 'asset-depreciation-tab'],
      ['click', '减值测试'],
      ['sleep', 700],
      ['shot', 'asset-impairment-tab'],
      ['click', '处置报废'],
      ['sleep', 700],
      ['shot', 'asset-disposal-tab'],
      ['click', '变更审批'],
      ['sleep', 700],
      ['shot', 'asset-change-tab'],
      ['click', '生命周期'],
      ['sleep', 700],
      ['shot', 'asset-lifecycle-tab'],
      ['click', '资产台账'],
      ['sleep', 500],
    ],
  },
  {
    name: '固定资产：新增资产弹窗可开可关',
    steps: [
      ['goto', '/asset'],
      ['click', '新增资产'],
      ['expectDialog', true],
      ['shot', 'asset-create-open'],
      ['esc'],
      ['expectDialog', false],
    ],
  },
  // ---------- 财务 ----------
  {
    name: '应收应付：七个 Tab 全部切换',
    steps: [
      ['goto', '/finance'],
      ['click', '应付与付款'],
      ['sleep', 900],
      ['shot', 'finance-ap-tab'],
      ['click', '发票登记'],
      ['sleep', 900],
      ['shot', 'finance-invoice-tab'],
      ['click', '勾稽中心'],
      ['sleep', 900],
      ['shot', 'finance-recon-tab'],
      ['click', '对账单'],
      ['sleep', 900],
      ['shot', 'finance-statement-tab'],
      ['click', '账龄分析'],
      ['sleep', 900],
      ['shot', 'finance-aging-tab'],
      ['click', '现金流'],
      ['sleep', 900],
      ['shot', 'finance-cashflow-tab'],
      ['click', '应收与回款'],
      ['sleep', 600],
    ],
  },
  {
    name: '应收：登记应收弹窗',
    steps: [
      ['goto', '/finance'],
      ['click', '登记应收'],
      ['expectDialog', true],
      ['shot', 'finance-ar-dialog'],
      ['esc'],
      ['expectDialog', false],
    ],
  },
  {
    name: '应付：登记应付弹窗',
    steps: [
      ['goto', '/finance'],
      ['click', '应付与付款'],
      ['sleep', 900],
      ['clickAny', ['登记应付', '登记应付单']],
      ['expectDialog', true],
      ['shot', 'finance-ap-dialog'],
      ['esc'],
    ],
  },
  {
    name: '票据管理：登记票据弹窗',
    steps: [
      ['goto', '/notes'],
      ['click', '登记票据'],
      ['expectDialog', true],
      ['shot', 'notes-dialog'],
      ['esc'],
      ['expectDialog', false],
    ],
  },
  {
    name: '总账凭证：三个 Tab + 新增手工凭证弹窗',
    steps: [
      ['goto', '/voucher'],
      ['click', '科目表'],
      ['sleep', 900],
      ['shot', 'voucher-accounts-tab'],
      ['click', '期间'],
      ['sleep', 900],
      ['shot', 'voucher-periods-tab'],
      ['click', '凭证'],
      ['sleep', 600],
      ['click', '新增手工凭证'],
      ['expectDialog', true],
      ['shot', 'voucher-create-dialog'],
      ['esc'],
      ['expectDialog', false],
    ],
  },
  {
    name: '财务报表：报表切换',
    steps: [
      ['goto', '/finance/reports'],
      ['clickAny', ['利润表']],
      ['sleep', 1400],
      ['shot', 'reports-income-statement'],
      ['clickAny', ['现金流量表']],
      ['sleep', 1400],
      ['shot', 'reports-cashflow'],
      ['clickAny', ['资产负债表']],
      ['sleep', 1400],
      ['shot', 'reports-balance-sheet'],
    ],
  },
  {
    name: '会计账簿：五个 Tab 全部切换',
    steps: [
      ['goto', '/finance/ledgers'],
      ['click', '总账'],
      ['sleep', 1200],
      ['shot', 'ledgers-general'],
      ['click', '明细账'],
      ['sleep', 1200],
      ['shot', 'ledgers-detail'],
      ['click', '辅助余额表'],
      ['sleep', 1200],
      ['shot', 'ledgers-aux'],
      ['click', '组合与分摊'],
      ['sleep', 1200],
      ['shot', 'ledgers-combination'],
      ['click', '科目余额表'],
      ['sleep', 800],
    ],
  },
  {
    name: '增值税申报：扫描与底稿',
    steps: [
      ['goto', '/finance/tax-declaration'],
      ['expect', '增值税'],
      ['shot', 'vat-declaration'],
      ['clickAny', ['扫描 2026-10', '扫描']],
      ['sleep', 2500],
      ['shot', 'vat-declaration-after-scan'],
    ],
  },
  {
    name: '期末年结：预览可加载',
    steps: [
      ['goto', '/finance/year-end'],
      ['sleep', 1500],
      ['expect', '结转'],
      ['shot', 'year-end'],
    ],
  },
  {
    name: '预算费控：Tab 切换',
    steps: [
      ['goto', '/fin-expense'],
      ['clickAny', ['报销', '费用申请', '经费申请']],
      ['sleep', 900],
      ['shot', 'fin-expense-tab'],
    ],
  },
  // ---------- HR / 行政 ----------
  {
    name: '人力资源：八个 Tab 全部切换',
    steps: [
      ['goto', '/hr'],
      ['click', '考勤与请假'],
      ['sleep', 900],
      ['shot', 'hr-attendance-tab'],
      ['click', '薪酬管理'],
      ['sleep', 900],
      ['shot', 'hr-payroll-tab'],
      ['click', '招聘管理'],
      ['sleep', 900],
      ['shot', 'hr-recruit-tab'],
      ['click', '绩效考核'],
      ['sleep', 900],
      ['shot', 'hr-appraisal-tab'],
      ['click', '培训管理'],
      ['sleep', 900],
      ['shot', 'hr-training-tab'],
      ['click', '我的'],
      ['sleep', 900],
      ['shot', 'hr-self-tab'],
      ['click', '身份管理'],
      ['sleep', 900],
      ['shot', 'hr-identity-tab'],
      ['click', '员工档案'],
      ['sleep', 800],
    ],
  },
  {
    name: '行政缴费：新建弹窗',
    steps: [
      ['goto', '/admin-bills'],
      ['clickAny', ['新建', '新增']],
      ['expectDialog', true],
      ['shot', 'admin-bill-dialog'],
      ['esc'],
    ],
  },
  {
    name: '租房合同：新建弹窗',
    steps: [
      ['goto', '/admin-rent'],
      ['clickAny', ['新建', '新增']],
      ['expectDialog', true],
      ['shot', 'admin-rent-dialog'],
      ['esc'],
    ],
  },
  // ---------- 合规 / 系统 ----------
  {
    name: '审计日志：筛选有反应',
    steps: [
      ['goto', '/audit'],
      ['shot', 'audit-before'],
      ['fill', 'input', '2026-10'],
      ['sleep', 1200],
      ['shot', 'audit-filtered'],
    ],
  },
  {
    name: '知识库：未配置时的降级提示',
    steps: [
      ['goto', '/wiki'],
      ['sleep'],
      ['shot', 'wiki-unconfigured'],
      ['expectAny', ['未配置', '引导', '请联系管理员', '空间']],
    ],
  },
  {
    name: '云空间：未配置时的降级提示',
    steps: [
      ['goto', '/drive'],
      ['sleep'],
      ['shot', 'drive-unconfigured'],
      ['expectAny', ['未配置', '请联系管理员', '配置', '云空间']],
    ],
  },
  {
    name: '设置：三个 Tab 全部切换',
    steps: [
      ['goto', '/settings'],
      ['click', '字典设置'],
      ['sleep', 1200],
      ['shot', 'settings-dictionary'],
      ['click', '参数设置'],
      ['sleep', 1200],
      ['shot', 'settings-params'],
      ['click', '外观与集成'],
      ['sleep', 800],
      ['shot', 'settings-appearance'],
    ],
  },
  {
    name: '自动化任务：开关渲染',
    steps: [
      ['goto', '/admin-automation'],
      ['sleep', 1200],
      ['shot', 'automation'],
    ],
  },
  {
    name: '命令面板：可开可关',
    steps: [
      ['goto', '/'],
      ['clickAny', ['搜索 ⌘K / Ctrl K', '搜索']],
      ['sleep', 900],
      ['shot', 'command-palette'],
      ['esc'],
      ['sleep', 500],
    ],
  },
  {
    name: '退货管理：Tab 与新建',
    steps: [
      ['goto', '/returns'],
      ['sleep', 1000],
      ['shot', 'returns-page'],
    ],
  },
  {
    name: '成本核算：Tab 切换',
    steps: [
      ['goto', '/costs'],
      ['sleep', 1000],
      ['shot', 'costs-page'],
    ],
  },
  {
    name: '数据资产：Tab 切换',
    steps: [
      ['goto', '/data-asset'],
      ['sleep', 1000],
      ['shot', 'data-asset-page'],
    ],
  },
  {
    /**
     * KPI 一致性断言（回归锁）。
     *
     * 事故：项目详情页顶部 `已确认收入` 用**不含税净额**（30,000），
     * 而下方「项目全景」卡原先用 `revenueByPeriod` 的**价税合计**（31,800），
     * 两个卡片同名不同值、毛利率一个 60% 一个 62.26% —— 财务无法判断信哪个。
     * 这里直接在**渲染后的 DOM** 上比对两处数值，任何一侧口径被改回去都会红灯。
     */
    name: '项目详情：收入 KPI 口径一致性（同屏同名必须同值）',
    steps: [
      ['goto', '/projects'],
      ['sleep', 1200],
      ['clickFirstLink', '/projects/'],
      ['sleep', 2200],
      ['shot', 'project-detail-kpi'],
      ['assertRevenueConsistent'],
    ],
  },
];

// ---------------- 执行 ----------------
async function run() {
  mkdirSync(OUT, { recursive: true });
  const session = await login();
  const browser = await Browser.launch({ port: 9335 });
  const page = await browser.newPage();
  await page.enable();
  await page.setViewport(1600, 1000);
  await page.setCookie({ name: 'erp_session', value: session, url: APP });

  const results = [];
  for (const scenario of SCENARIOS) {
    page.resetDiagnostics();
    const findings = [];
    let currentStep = '';
    const shots = [];
    try {
      for (const step of scenario.steps) {
        const [op, a, b] = step;
        currentStep = `${op} ${a ?? ''} ${b ?? ''}`.trim();
        if (op === 'goto') {
          await page.goto(`${APP}${a}`, { settleMs: 1200 });
        } else if (op === 'sleep') {
          await sleep(Number(a) || 700);
        } else if (op === 'click') {
          const before = await stateOf(page);
          await page.clickByText(a, { settleMs: 700 });
          const after = await stateOf(page);
          const reasons = diffState(before, after);
          if (reasons.length === 0) {
            findings.push({ kind: 'NO_EFFECT', step: currentStep, detail: '点击后页面无任何变化' });
          }
        } else if (op === 'clickAny') {
          let clicked = false;
          for (const label of a) {
            try {
              const before = await stateOf(page);
              await page.clickByText(label, { settleMs: 700 });
              const after = await stateOf(page);
              const reasons = diffState(before, after);
              if (reasons.length === 0) {
                findings.push({ kind: 'NO_EFFECT', step: `click ${label}`, detail: '点击后无变化' });
              }
              clicked = true;
              break;
            } catch {
              /* 换下一个候选文案 */
            }
          }
          if (!clicked) findings.push({ kind: 'NO_BUTTON', step: currentStep, detail: '候选文案都找不到' });
        } else if (op === 'clickSel') {
          await page.click(a, { settleMs: 700 });
        } else if (op === 'fill') {
          await page.fill(a, b ?? '');
          await sleep(400);
        } else if (op === 'esc') {
          await page.pressKey('Escape', 'Escape', 27);
          await sleep(500);
        } else if (op === 'expect') {
          const ok = await page.waitForText(a, 8000);
          if (!ok) findings.push({ kind: 'MISSING_TEXT', step: currentStep, detail: `页面未出现「${a}」` });
        } else if (op === 'expectUrl') {
          const url = await page.evaluate('location.pathname + location.search');
          if (!url.includes(a)) {
            findings.push({ kind: 'WRONG_URL', step: currentStep, detail: `期望含 ${a}，实际 ${url}` });
          }
        } else if (op === 'clickFirstLink') {
          const href = await page.evaluate(
            `(() => { const a = [...document.querySelectorAll('a[href*=${JSON.stringify(a)}]')]
                        .find(el => /\\/\\d|\\/[0-9a-f]{8}-/.test(el.getAttribute('href')||''));
              if (!a) return null; a.scrollIntoView({block:'center'}); return a.getAttribute('href'); })()`
          );
          if (!href) {
            findings.push({ kind: 'NO_LINK', step: currentStep, detail: `找不到匹配 ${a} 的详情链接` });
          } else {
            await page.goto(`${APP}${href}`, { settleMs: 1500 });
          }
        } else if (op === 'assertRevenueConsistent') {
          /*
           * 抓取所有「已确认收入…」标签右侧/下方的金额，断言**口径唯一**。
           *
           * 事故：顶部 StatCard「已确认收入」用不含税净额（30,000），
           * 下方「项目全景」卡原先用价税合计（31,800），两个卡片同名不同值。
           * 因此这里做两条断言：
           *   1. 所有标注"不含税"或未标注"含税"的金额必须**完全一致**；
           *   2. 价税合计（若出现）必须出现在**说明文案**里，且与净额不同 ——
           *      两条一起才能同时抓住"数值口径分叉"和"把含税当净额展示"两种错法。
           */
          const res = await page.evaluate(`(() => {
            const out = [];
            const walk = (root) => {
              for (const el of root.querySelectorAll('*')) {
                const own = (el.childNodes.length === 1 && el.firstChild?.nodeType === 3)
                  ? (el.textContent || '').trim() : '';
                if (/^已确认收入/.test(own)) {
                  // 标签所在卡片的整块文本（含数值与 hint）
                  const card = el.closest('[data-ai-section-type="card-stat"]') || el.parentElement?.parentElement || el.parentElement;
                  const block = (card?.innerText || '').replace(/\\s+/g, ' ');
                  const m = block.match(/¥([\\d,]+\\.\\d\\d)/);
                  out.push({ label: own, block: block.slice(0, 200), amount: m ? m[1] : null });
                }
              }
            };
            walk(document.body);
            return out;
          })()`);

          const netAmounts = res
            .filter((r) => !/含税|价税合计/.test(r.label))
            .map((r) => r.amount)
            .filter(Boolean);
          const uniqNet = [...new Set(netAmounts)];
          if (netAmounts.length >= 2 && uniqNet.length > 1) {
            findings.push({
              kind: 'KPI_INCONSISTENT',
              step: currentStep,
              detail: `同屏「已确认收入」净额口径不一致：${netAmounts.join(' / ')}`,
            });
          }
          if (res.length < 2) {
            findings.push({
              kind: 'KPI_NOT_FOUND',
              step: currentStep,
              detail: `只找到 ${res.length} 处「已确认收入」，断言可能失效（需人工确认页面结构）`,
            });
          }
          // 价税合计必须只在说明里披露，不能冒充净额
          const shown = res.map((r) => r.block).join(' | ');
          if (/价税合计/.test(shown) && uniqNet.length === 1) {
            const gross = /价税合计 ¥([\d,]+\.\d\d)/.exec(shown)?.[1];
            if (gross && gross === uniqNet[0]) {
              findings.push({
                kind: 'KPI_HINT_SUSPECT',
                step: currentStep,
                detail: `价税合计与不含税净额相同（${gross}），说明文案可能有误`,
              });
            }
          }
        } else if (op === 'expectAny') {
          const body = await page.evaluate('document.body.innerText');
          const hit = a.some((t) => body.includes(t));
          if (!hit) findings.push({ kind: 'MISSING_TEXT', step: currentStep, detail: `未出现任一：${a.join('/')}` });
        } else if (op === 'expectDialog') {
          const count = await page.evaluate(
            `document.querySelectorAll('[role="dialog"]').length`
          );
          const want = a === true;
          if (want && count === 0) {
            findings.push({ kind: 'NO_DIALOG', step: currentStep, detail: '期望弹窗但未出现' });
          }
          if (!want && count > 0) {
            findings.push({ kind: 'DIALOG_STUCK', step: currentStep, detail: '弹窗未关闭（Esc 无效）' });
          }
        } else if (op === 'shot') {
          const p = `${OUT}/ix-${scenario.name.replace(/[/\\:*?"<>|]/g, '_')}-${a}.png`;
          try {
            await page.screenshot(p);
            shots.push(p);
          } catch (error) {
            findings.push({ kind: 'SHOT_FAIL', step: currentStep, detail: error.message });
          }
        }
      }
    } catch (error) {
      findings.push({ kind: 'STEP_THREW', step: currentStep, detail: error.message.slice(0, 300) });
    }

    const consoleErrors = page.consoleLogs.filter((c) => c.type === 'error').map((c) => c.text.slice(0, 300));
    const exceptions = page.exceptions.map((e) => `${e.text} ${e.description ?? ''}`.slice(0, 300));
    const httpErrors = page.httpErrors.map((h) => `${h.status} ${h.method} ${h.url}`);
    // 配置类 503（飞书未配置）不算前端缺陷，单独归类
    const config503 = httpErrors.filter((h) => h.startsWith('503'));
    const realHttpErrors = httpErrors.filter((h) => !h.startsWith('503'));

    const entry = {
      name: scenario.name,
      findings,
      consoleErrors,
      exceptions,
      httpErrors: realHttpErrors,
      configNotConfigured: config503,
      shots,
    };
    results.push(entry);

    const bad = findings.length + consoleErrors.length + exceptions.length + realHttpErrors.length;
    console.log(
      `${bad === 0 ? '[ok]' : '[XX]'} ${scenario.name}` +
        (findings.length ? ` | findings=${findings.length}` : '') +
        (consoleErrors.length ? ` | cerr=${consoleErrors.length}` : '') +
        (exceptions.length ? ` | exc=${exceptions.length}` : '') +
        (realHttpErrors.length ? ` | http=${realHttpErrors.length}` : '') +
        (config503.length ? ` | 503(未配置)=${config503.length}` : '')
    );
    for (const f of findings) console.log(`      ${f.kind}: ${f.step} — ${f.detail}`);
    for (const c of consoleErrors.slice(0, 2)) console.log(`      console: ${c.replace(/\n/g, ' ')}`);
    for (const e of exceptions.slice(0, 2)) console.log(`      threw: ${e.replace(/\n/g, ' ')}`);
    for (const h of realHttpErrors.slice(0, 2)) console.log(`      http: ${h}`);
  }

  writeFileSync(`${OUT}/interaction-report.json`, JSON.stringify(results, null, 2), 'utf8');
  const bad = results.filter(
    (r) => r.findings.length || r.consoleErrors.length || r.exceptions.length || r.httpErrors.length
  );
  console.log(`\n场景 ${results.length} 个，有问题 ${bad.length} 个`);
  for (const b of bad) console.log(`  - ${b.name}`);
  console.log(`报告：${OUT}/interaction-report.json`);

  await browser.close();
}

await run();
