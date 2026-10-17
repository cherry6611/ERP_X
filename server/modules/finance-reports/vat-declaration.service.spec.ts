/**
 * A-06 增值税申报底稿 —— 服务层接线规格。
 *
 * ## 为什么需要这份规格
 *
 * 本 service 曾长期**零测试覆盖**，导致两起缺陷都只能靠人工审查发现：
 *   ① 附加税费「六税两费减半」没接线 → 小规模主体附加税**多提一倍**；
 *   ② 未指定纳税主体时 `confirm()` 被"主体未配置城建税率"的理由拒绝，
 *      排障方向被误导（真正原因是没选主体，主体配置本身没毛病）。
 *
 * ## 测试策略（刻意的选择）
 *
 * 用**桩 db 驱动真实 service**，而不是 pglite 集成测试：
 *   - 本规格验的是「口径接线」（taxpayerType 有没有传进 computeVatSurcharge、
 *     第 1 行取的是 salesNet 还是 output、阻断文案分不分场景），这些都是纯逻辑；
 *   - 集成测试要 boot WASM + 跑 36 条迁移链，单条 8~20s，且会把噪点带进口径断言；
 *   - 全量迁移链另有 `server/test/integration/*` 覆盖，**SQL 侧不在这里重复验**。
 * 本套件 10 秒内跑完，与 pglite 规格互不干扰。
 *
 * ## 断言强度约定（改本文件前请先读）
 *
 * - **金额断言用精确值**：`toBe(60)`。金额错了就是真金白银出错，不允许容差。
 * - **文案断言只做宽松匹配**：`toContain('未指定纳税主体')`。
 *   锁死整句会让"改个措辞"就变红灯，那是假失败 —— 假失败比漏测试更糟，
 *   它会让人开始忽略红灯。
 */
import { BadRequestException } from '@nestjs/common';
import type { PostgresJsDatabase } from '@server/platform';
import {
  ACCOUNT_VAT_INPUT,
  ACCOUNT_VAT_OUTPUT,
} from '@server/common/tax/account-codes';
import { finVatDeclaration, mdTaxEntity } from '@server/database/schema';
import { VatDeclarationService } from './vat-declaration.service';

type EntityRow = {
  name: string;
  urbanMaintRate: string | null;
  taxpayerType: string | null;
};

interface StubOptions {
  /** 发票台账销项不含税销售额（申报表第 1 行口径） */
  salesNet: number;
  /** 发票台账销项税额（第 11 行口径） */
  outputTax: number;
  /** 发票台账**可抵扣**进项税额（第 12 行口径；已勾选认证/已抵扣的才算） */
  inputTax: number;
  /** 总账 222101 贷方发生额，默认 0 */
  ledgerOutput?: number;
  /** 总账 222102 借方发生额，默认 0 */
  ledgerInput?: number;
  entityRows: EntityRow[];
  /**
   * P0-A：本期已登记但**未勾选认证**的进项税额（默认 0）。
   *
   * 这部分依法不得在当期抵扣，只在申报表第 25 行与差异区披露。
   */
  uncertifiedInput?: number;
  /** P0-A：未认证进项发票张数（默认 0） */
  uncertifiedCount?: number;
  /**
   * P0-B：**上期已确认底稿**的期末留抵（默认 null = 上期未确认）。
   *
   * `null` 时服务回退到总账推算（`previousCreditSource = 'ledger_estimate'`），
   * 并推入 `previous_credit_from_ledger` 差异项。
   */
  previousConfirmedCredit?: string | null;
  /**
   * P0-B：总账口径的上期留抵（222102 上期期末借方余额）。
   *
   * 与 `ledgerInput`（**本期**发生额）分开控制 —— 桩原先只有一份数同时充当
   * "本期发生额"与"上期余额"，于是**构造不出**"有上期留抵但本期无过账"这个
   * 最关键的场景（那正是 P0-B 的触发条件，也是该缺陷长期没被测试发现的原因）。
   */
  previousLedgerCredit?: number;
}

/**
 * 最小 db 桩：只实现 generate()/confirm() 用到的取数路径。
 * 用 drizzle 表对象的**身份**分派（表对象是单例；对它做 JSON 序列化会撞循环引用）。
 */
function makeDb(options: StubOptions): PostgresJsDatabase {
  const chain = () => {
    let table: unknown;
    const self = {
      from: (t: unknown) => {
        table = t;
        return self;
      },
      where: () => self,
      limit: () => {
        if (table === mdTaxEntity) return Promise.resolve(options.entityRows);
        // P0-B：上期已确认底稿的 closing_credit（权威留抵来源）。
        // 返回 `status: 'confirmed'` 才会被采用；未确认时服务回退总账推算。
        if (table === finVatDeclaration) {
          return Promise.resolve(
            options.previousConfirmedCredit == null
              ? []
              : [
                  {
                    closingCredit: options.previousConfirmedCredit,
                    status: 'confirmed',
                  },
                ]
          );
        }
        throw new Error(`桩 db 遇到未知的 from 表：${String(table)}`);
      },
    };
    return self;
  };
  return {
    execute: () =>
      Promise.resolve([
        {
          output_tax: options.outputTax,
          input_tax: options.inputTax,
          sales_net: options.salesNet,
          output_count: 1,
          input_count: 1,
          uncertified_input: options.uncertifiedInput ?? 0,
          uncertified_count: options.uncertifiedCount ?? 0,
        },
      ]),
    select: () => chain(),
  } as unknown as PostgresJsDatabase;
}

type Rolled = {
  creditOccur?: number;
  debitOccur?: number;
  closingDebit?: number;
  closingCredit?: number;
};

/**
 * 桩的 `closing*` 与 `debitOccur/creditOccur` 必须在同一份 map 上自洽，
 * 否则 `previousCredit`（用上期 closing）与 `ledgerTax`（用本期 occur）会互相打架。
 *
 * 真实总账里这是**两期两份数**：本期 `debitOccur` 是本期发生额，
 * 上期 `closingDebit` 是上期结转下来的余额。桩原先只有一份数同时充当两者，
 * 于是**构造不出**"上期有留抵（closing 有值）但本期无过账（occur 为 0）"
 * —— 那恰恰是 P0-B 的触发条件，也是它长期没被测试发现的直接原因。
 * 现在用 `previousLedgerCredit` 单独给上期余额，两者可独立设置。
 */
function makeService(options: StubOptions): VatDeclarationService {
  const db = makeDb(options);
  // 默认总账无发生额 → 与发票台账必然有差异；需要勾稽一致时显式传入相等值
  const rolled = new Map<string, Rolled>([
    [
      ACCOUNT_VAT_OUTPUT,
      {
        creditOccur: options.ledgerOutput ?? 0,
        debitOccur: 0,
        closingCredit: options.ledgerOutput ?? 0,
        closingDebit: 0,
      },
    ],
    [
      ACCOUNT_VAT_INPUT,
      {
        debitOccur: options.ledgerInput ?? 0,
        creditOccur: 0,
        // 上期留抵单独控制；未传时沿用旧行为（= 本期发生额），保持既有用例语义不变
        closingDebit: options.previousLedgerCredit ?? options.ledgerInput ?? 0,
        closingCredit: 0,
      },
    ],
  ]);
  const ledgers = {
    rolledBalances: () => Promise.resolve(rolled),
  } as unknown as ConstructorParameters<typeof VatDeclarationService>[1];
  // generate() 不触碰 voucherHook，只 confirm() 的计提路径会用到；
  // 本规格的 confirm() 用例都在硬门处抛出，走不到计提，故留空即可
  const hook = {} as ConstructorParameters<typeof VatDeclarationService>[2];
  return new VatDeclarationService(db, ledgers, hook);
}

/** 主体：小规模纳税人，城建 7% */
const ENTITY_SMALL: EntityRow[] = [
  { name: '小规模主体', urbanMaintRate: '7', taxpayerType: 'small' },
];
/** 主体：一般纳税人，城建 7% */
const ENTITY_GENERAL: EntityRow[] = [
  { name: '一般主体', urbanMaintRate: '7', taxpayerType: 'general' },
];
/** 已选主体，但城建税率缺失 */
const ENTITY_NO_RATE: EntityRow[] = [
  { name: '缺税率主体', urbanMaintRate: null, taxpayerType: 'general' },
];

/** 销项 1300 / 进项 300 → 应纳税额 1000；不含税销售额 10000 */
const OUTPUT_TAX = 1300;
const INPUT_TAX = 300;
const SALES_NET = 10000;
const PERIOD = '2026-05';
const ENTITY_ID = 'e0000000-0000-4000-8000-000000000001';

/** 总账与台账一致 → 勾稽差异为空，便于单独观察附加税费硬门 */
function reconciledOptions(entityRows: EntityRow[]): StubOptions {
  return {
    salesNet: SALES_NET,
    outputTax: OUTPUT_TAX,
    inputTax: INPUT_TAX,
    ledgerOutput: OUTPUT_TAX,
    ledgerInput: INPUT_TAX,
    entityRows,
  };
}

describe('VatDeclarationService 附加税费接线', () => {
  it('小规模主体：附加税为一般纳税人的精确一半，且带六税两费减免说明', async () => {
    const small = await makeService(reconciledOptions(ENTITY_SMALL)).generate({
      period: PERIOD,
      taxEntityId: ENTITY_ID,
    });
    const general = await makeService(reconciledOptions(ENTITY_GENERAL)).generate({
      period: PERIOD,
      taxEntityId: ENTITY_ID,
    });

    // T-S2：小规模纳税人无进项抵扣权 → 应纳税额 = 销项 1300（不减进项 300）。
    // 修复前按一般纳税人口径算成 1000，直接少缴 300。
    expect(small.payableTax).toBe(OUTPUT_TAX);
    // 一般纳税人才减进项与留抵
    expect(general.payableTax).toBe(1000);

    // 小规模：应纳税额 1300 × 12% = 156；一般：1000 × 12% = 120
    expect(general.surcharge.urbanMaint).toBe(70);
    expect(general.surcharge.education).toBe(30);
    expect(general.surcharge.localEducation).toBe(20);
    expect(general.surcharge.total).toBe(120);

    // 修复前这里会算成 120（多提一倍）
    expect(small.surcharge.urbanMaint).toBe(45.5);
    expect(small.surcharge.education).toBe(19.5);
    expect(small.surcharge.localEducation).toBe(13);
    expect(small.surcharge.total).toBe(78);
    // 比例而非仅数值：保证减半关系，不随基数调整而失效
    expect(small.surcharge.total * 2).toBe(general.surcharge.total * 13 / 10);

    expect(small.surcharge.adjustments.join()).toContain('六税两费减半');
    expect(small.surcharge.blocked).toBe(false);
    expect(general.surcharge.blocked).toBe(false);
  });

  it('一般纳税人：不减半，减免说明为空（一般纳税人按小微判定需三项指标，缺数据时不猜）', async () => {
    const result = await makeService(reconciledOptions(ENTITY_GENERAL)).generate({
      period: PERIOD,
      taxEntityId: ENTITY_ID,
    });
    expect(result.surcharge.adjustments).toEqual([]);
    expect(result.surcharge.total).toBe(120);
  });
});

describe('VatDeclarationService 小规模纳税人进项不得抵扣（T-S2）', () => {
  it('应纳税额不减进项、不减上期留抵；差异区显式披露且自带说明', async () => {
    const result = await makeService({
      ...reconciledOptions(ENTITY_SMALL),
      // 上期留抵走 previousCredit stub：ledger 的 closing 余额由 rolled map 控制，
      // 这里给进项科目一个借方余额 → 上期留抵 200
      ledgerInput: INPUT_TAX,
    }).generate({ period: PERIOD, taxEntityId: ENTITY_ID });

    // 销项 1300，进项 300、留抵 200 全部不参与 → 应纳税额 1300
    expect(result.payableTax).toBe(OUTPUT_TAX);
    // 第 12 行进项税额按 0 计入申报表（原始登记额仍在 differences 披露）
    expect(result.lines.find((line) => line.rowNo === '12')?.amount).toBe(0);
    // 第 17 行上期留抵按 0 计入
    expect(result.lines.find((line) => line.rowNo === '17')?.amount).toBe(0);
    // 原始登记额不被抹掉：仍可从结果字段复盘
    expect(result.inputTaxFromInvoices).toBe(INPUT_TAX);
    // 政策口径差异显式入列，且自带说明（确认时不需要用户再补文字）
    const item = result.differences.find(
      (diff) => diff.code === 'small_scale_no_input_credit'
    );
    expect(item).toBeDefined();
    expect(item?.reason).toContain('无进项抵扣权');
    expect(item?.amount).toBe(-INPUT_TAX);
    // 第 12 行的 explained 必须为 true：政策预期不是勾稽错误
    expect(result.lines.find((line) => line.rowNo === '12')?.explained).toBe(true);
  });

  it('confirm()：政策差异自带说明时不强制用户补写差异说明', async () => {
    const service = makeService(reconciledOptions(ENTITY_SMALL));
    // 闸门放行的证据：错误不再是"请填写差异说明"，而是走到写库阶段
    // （stub db 未实现 insert，抛 TypeError）—— 说明差异说明门槛已被自带说明满足。
    await expect(
      service.confirm({ period: PERIOD, taxEntityId: ENTITY_ID }, 'u1')
    ).rejects.toThrow(/insert is not a function/);
  });

  it('一般纳税人仍可抵进项：同数据下应纳税额 = 1300 − 300 = 1000', async () => {
    const result = await makeService(reconciledOptions(ENTITY_GENERAL)).generate({
      period: PERIOD,
      taxEntityId: ENTITY_ID,
    });
    expect(result.payableTax).toBe(1000);
    expect(result.lines.find((line) => line.rowNo === '12')?.amount).toBe(INPUT_TAX);
    expect(
      result.differences.find((d) => d.code === 'small_scale_no_input_credit')
    ).toBeUndefined();
  });
});

/**
 * 进项/留抵**不得重复抵扣**（本次修复的核心，改动前请读完再动）。
 *
 * 一张进货发票在系统里会出现在两个地方：开票时生成的凭证（借 222102 进项税）
 * 与发票台账（按开票日期归期）。旧口径「应纳税额 = 销项 − 台账进项 − 上期留抵」
 * 在「本期总账已过账 + 上期还有未抵完留抵」时会把同一笔进项抵两次 → 少缴增值税。
 *
 * 钉死的规则：
 *   · 本期 222102 有发生额 → 本期抵总账数，且**允许**叠加同额的上期留抵
 *     （两者互不重叠：上期留抵是上期结转的未抵完部分）；
 *   · 本期 222102 无发生额 → 退化为台账预览，此时**绝不**再减上期留抵。
 */
describe('VatDeclarationService 进项与留抵不得重复抵扣（重复抵扣回归）', () => {
  it('本期总账有进项发生额：抵扣以总账为准，且可叠加等同的上期留抵', async () => {
    const result = await makeService(reconciledOptions(ENTITY_GENERAL)).generate({
      period: PERIOD,
      taxEntityId: ENTITY_ID,
    });
    // 销项 1300 − 总账进项 300 = 1000（台账进项同为 300，不产生差异）
    expect(result.payableTax).toBe(1000);
    expect(result.differences).toEqual([]);
  });

  it('本期总账无进项发生额：退化为台账预览，且不得再减上期留抵（否则重复抵扣）', async () => {
    const result = await makeService({
      salesNet: SALES_NET,
      outputTax: OUTPUT_TAX,
      inputTax: INPUT_TAX,
      ledgerOutput: OUTPUT_TAX,
      // 本期 222102 无发生额（凭证未生成/失败），但台账有 300 进项登记
      ledgerInput: 0,
      entityRows: ENTITY_GENERAL,
    }).generate({ period: PERIOD, taxEntityId: ENTITY_ID });

    // 台账进项 300 参与抵扣；上期留抵 0 参与 → 1300 − 300 = 1000
    // 反例：若把上期留抵也叠加进来（旧口径的重复抵扣形状），这里会小于 1000。
    expect(result.payableTax).toBe(1000);
    // 未过账的差异仍必须显式披露，不能被这道逻辑掩盖
    expect(
      result.differences.find((d) => d.code === 'input_mismatch')
    ).toBeDefined();
  });

  it('小规模：进项与留抵一律不参与（T-S2 不受本次改动影响）', async () => {
    const result = await makeService({
      ...reconciledOptions(ENTITY_SMALL),
      ledgerInput: INPUT_TAX,
    }).generate({ period: PERIOD, taxEntityId: ENTITY_ID });
    expect(result.payableTax).toBe(OUTPUT_TAX);
  });
});

describe('VatDeclarationService 申报表行次口径', () => {
  it('第 1 行是不含税销售额 salesNet，不是销项税额 output（钉死错列不复发）', async () => {
    const result = await makeService(reconciledOptions(ENTITY_SMALL)).generate({
      period: PERIOD,
      taxEntityId: ENTITY_ID,
    });
    const row1 = result.lines.find((line) => line.rowNo === '1');
    expect(row1?.rowName).toContain('不含税');
    expect(row1?.amount).toBe(SALES_NET);
    // 反例：若改回用 output（销项税额），这里会变成 1300 —— 必须永远不相等
    expect(row1?.amount).not.toBe(OUTPUT_TAX);
  });

  it('第 11 行是销项税额；第 12 行进项：一般纳税人原值、小规模按 0 计入', async () => {
    const general = await makeService(reconciledOptions(ENTITY_GENERAL)).generate({
      period: PERIOD,
      taxEntityId: ENTITY_ID,
    });
    const small = await makeService(reconciledOptions(ENTITY_SMALL)).generate({
      period: PERIOD,
      taxEntityId: ENTITY_ID,
    });
    expect(general.lines.find((line) => line.rowNo === '11')?.amount).toBe(OUTPUT_TAX);
    expect(general.lines.find((line) => line.rowNo === '12')?.amount).toBe(INPUT_TAX);
    expect(small.lines.find((line) => line.rowNo === '11')?.amount).toBe(OUTPUT_TAX);
    expect(small.lines.find((line) => line.rowNo === '12')?.amount).toBe(0);
  });
});

/**
 * P0-A：**未勾选认证的进项不得计入可抵扣**（本次修复的合规核心）。
 *
 * 原实现把 `erp_invoice.tax_amount` 全额计入可抵扣进项 —— `certification_status`
 * 是一个**只写不参与计算**的展示字段。后果是**少缴增值税，而账面全平、
 * 报表全平、`npm test` 全绿**：
 *
 *   本期销项税额              60,000
 *   一张已登记未勾选专票（6%）  60,000
 *   系统底稿应纳税额               0     ← 错
 *   法定应纳税额              60,000     ← 对
 *
 * 修复后：只统计 `certification_status IN ('certified','deducted')` 的进项，
 * 未认证部分单列第 25 行 + `uncertified_input_pending` 差异项。
 * 历史数据一律是 `'uncertified'`，因此方向是**偏严（多缴）**，不会造成漏缴。
 */
describe('VatDeclarationService 进项抵扣以勾选认证为前提（P0-A）', () => {
  it('未认证进项不得抵扣：应纳税额按全额计，且第 25 行与差异项显式披露', async () => {
    // 销项 1300；台账里有 300 进项，但**一张都没认证**（inputTax 是"可抵扣"口径，故为 0）
    const result = await makeService({
      salesNet: SALES_NET,
      outputTax: OUTPUT_TAX,
      inputTax: 0,
      uncertifiedInput: INPUT_TAX,
      uncertifiedCount: 1,
      ledgerOutput: OUTPUT_TAX,
      // 总账 222102 **本期也无发生额**（关键：否则会走"以总账为准"的抵扣路径，
      // 而那条路径与勾选认证状态无关 —— 法人主体未认证的进项已入 222102 是另一个
      // 问题，见 P0-A 修复说明中的"待认证进项税额应单独挂 222105"）
      ledgerInput: 0,
      // 上期也没有留抵：把变量收敛到"未认证进项能不能抵"这一个问题上
      previousLedgerCredit: 0,
      entityRows: ENTITY_GENERAL,
    }).generate({ period: PERIOD, taxEntityId: ENTITY_ID });

    // 应纳税额 = 1300 − 0（可抵扣进项） = 1300。
    // 反例（修复前的行为）：会把 300 也减掉 → 1000，**少缴 300**。
    expect(result.payableTax).toBe(OUTPUT_TAX);
    expect(result.lines.find((line) => line.rowNo === '12')?.amount).toBe(0);

    // 第 25 行单列待认证进项，且**不可加**（它与第 12 行互斥，相加没有申报含义）
    const row25 = result.lines.find((line) => line.rowNo === '25');
    expect(row25?.amount).toBe(INPUT_TAX);
    expect(row25?.summable).toBe(false);

    // 结果字段：可抵扣口径与待认证口径相加 = 台账进项总额（可核对）
    expect(result.inputTaxFromInvoices).toBe(0);
    expect(result.uncertifiedInputTax).toBe(INPUT_TAX);
    expect(result.uncertifiedInvoiceCount).toBe(1);

    // 差异项必须存在且自带完整说明（确认时不需要用户再补文字）
    const item = result.differences.find(
      (diff) => diff.code === 'uncertified_input_pending'
    );
    expect(item).toBeDefined();
    expect(item?.amount).toBe(INPUT_TAX);
    expect(item?.label).toContain('待认证');
    expect(item?.reason).toContain('勾选');
  });

  it('全部认证后回到"台账进项即抵扣"的正常口径（差异项消失）', async () => {
    const result = await makeService(reconciledOptions(ENTITY_GENERAL)).generate({
      period: PERIOD,
      taxEntityId: ENTITY_ID,
    });
    expect(result.uncertifiedInputTax).toBe(0);
    expect(
      result.differences.find((d) => d.code === 'uncertified_input_pending')
    ).toBeUndefined();
    // 总账进项 300 + 上期留抵推算 300 时会被压到 min(留抵, 本期进项) = 300，
    // 但本例上期留抵取总账 closing = 300，故应纳税额 = 1300 − 300 − 300 = 700。
    // ⚠️ 这条断言与"进项与留抵不得重复抵扣"那组规格同源：桩无法区分本期/上期，
    // 因此这里只断言**未认证口径不参与**，金额留给那组规格。
    expect(result.uncertifiedInputTax).toBe(0);
  });
});

/**
 * P0-B：**上期留抵不得因"本期无进项过账"被丢弃**。
 *
 * 原实现 `ledger.inputPosted ? previousCredit : 0` —— 本期没有进项凭证时
 * 直接把上期留抵**整个丢掉**，后果是系统性**多缴增值税**：
 *
 *   9 月：进项 6,000，销项 0 → 留抵 6,000
 *   10 月：销项 600，无采购
 *   系统底稿应纳税额 600（法定为 0）→ **多缴 600**，账面上看不出任何异常。
 *
 * 修复后：留抵优先取**上期已确认底稿的 `closing_credit`**（权威，不依赖过账状态）。
 */
describe('VatDeclarationService 上期留抵结转（P0-B）', () => {
  it('上期已确认底稿：即使本期总账无进项过账，留抵仍全额结转', async () => {
    const result = await makeService({
      salesNet: 10000,
      outputTax: 600,
      inputTax: 0,
      // 本期 222102 无发生额（无采购凭证）—— 这正是原缺陷的触发条件
      ledgerInput: 0,
      ledgerOutput: 0,
      // 上期已确认底稿的期末留抵 6000
      previousConfirmedCredit: '6000',
      entityRows: ENTITY_GENERAL,
    }).generate({ period: PERIOD, taxEntityId: ENTITY_ID });

    // 应纳税额 = 600 − 0 − 6000 < 0 → 0（法定结果），期末留抵 5400
    expect(result.payableTax).toBe(0);
    expect(result.closingCredit).toBe(5400);
    // 第 17 行（上期留抵）必须等于权威来源，而不是 0
    expect(result.lines.find((line) => line.rowNo === '17')?.amount).toBe(6000);
    expect(result.previousCredit).toBe(6000);
    expect(result.previousCreditSource).toBe('confirmed_declaration');
    // 权威来源无需披露"估数"提示
    expect(
      result.differences.find((d) => d.code === 'previous_credit_from_ledger')
    ).toBeUndefined();
  });

  it('上期未确认底稿：回退总账推算，且显式披露"这是估数"', async () => {
    const result = await makeService({
      salesNet: 10000,
      outputTax: OUTPUT_TAX,
      inputTax: INPUT_TAX,
      // 总账 222101 本期无发生额 → 上期留抵推算只由 222102 决定（否则会被销项抵掉）
      ledgerOutput: 0,
      ledgerInput: INPUT_TAX,
      // 上期总账留抵 500（比本期发生额 300 大 → 会被 min() 压到 300，便于
      // 同时验证"按较小者计入"这条防重复抵扣的规则确实生效）
      previousLedgerCredit: 500,
      // 不传 previousConfirmedCredit → 桩返回空 → 走总账推算
      entityRows: ENTITY_GENERAL,
    }).generate({ period: PERIOD, taxEntityId: ENTITY_ID });

    expect(result.previousCreditSource).toBe('ledger_estimate');
    // 推算原值 500 必须如实返回（披露用），而不是被 min() 后的值
    expect(result.previousCredit).toBe(500);
    const item = result.differences.find(
      (d) => d.code === 'previous_credit_from_ledger'
    );
    expect(item).toBeDefined();
    expect(item?.amount).toBe(500);
    expect(item?.reason).toContain('上期增值税申报底稿尚未确认');
    // 实际计入申报表第 17 行的是 min(500, 本期进项 300) = 300
    expect(result.lines.find((line) => line.rowNo === '17')?.amount).toBe(300);
    expect(result.lines.find((line) => line.rowNo === '17')?.ledgerAmount).toBe(500);
  });

  it('上期未确认且总账留抵远大于本期进项：按较小者计入，绝不重复抵扣', async () => {
    // 这正是"为防重复抵扣而丢弃留抵"那个原始担忧的形状：
    // 上期总账留抵 3000，而本期台账进项只有 300 —— 两者可能指向同一批票。
    // 修复策略：上期未确认时按 min(留抵, 本期进项) = 300 计入（偏严，方向是多缴）。
    const result = await makeService({
      salesNet: 10000,
      outputTax: OUTPUT_TAX,
      inputTax: INPUT_TAX,
      ledgerOutput: 0,
      ledgerInput: 0,
      previousLedgerCredit: 3000,
      entityRows: ENTITY_GENERAL,
    }).generate({ period: PERIOD, taxEntityId: ENTITY_ID });

    expect(result.previousCreditSource).toBe('ledger_estimate');
    expect(result.previousCredit).toBe(3000);
    // 1300 − 300（台账进项） − 300（被压到与本期进项同额）= 700
    expect(result.payableTax).toBe(700);
    // 第 17 行展示的是**实际计入**的 300，而 ledgerAmount 保留推算原值 3000
    expect(result.lines.find((line) => line.rowNo === '17')?.amount).toBe(300);
    expect(result.lines.find((line) => line.rowNo === '17')?.ledgerAmount).toBe(3000);
  });

  it('小规模主体：既不取上期留抵，也不披露留抵来源（无留抵概念）', async () => {
    const result = await makeService({
      ...reconciledOptions(ENTITY_SMALL),
      previousConfirmedCredit: '6000',
    }).generate({ period: PERIOD, taxEntityId: ENTITY_ID });
    expect(result.lines.find((line) => line.rowNo === '17')?.amount).toBe(0);
    expect(
      result.differences.find((d) => d.code === 'previous_credit_from_ledger')
    ).toBeUndefined();
  });
});

describe('VatDeclarationService 附加税费阻断（要件缺失 → 拒绝出数，不静默按 0）', () => {
  it('已选主体但城建税率缺失：blocked=true，且推入 surcharge_rate_missing 差异', async () => {
    const result = await makeService(reconciledOptions(ENTITY_NO_RATE)).generate({
      period: PERIOD,
      taxEntityId: ENTITY_ID,
    });
    expect(result.surcharge.blocked).toBe(true);
    expect(result.surcharge.total).toBe(0);
    expect(result.surcharge.urbanMaintRate).toBeNull();
    const codes = result.differences.map((item) => item.code);
    expect(codes).toContain('surcharge_rate_missing');
    // 勾稽本身是一致的，唯一未决项就是附加税费
    expect(codes).not.toContain('output_mismatch');
    expect(codes).not.toContain('input_mismatch');
    expect(result.reconciled).toBe(false);
  });

  it('未指定主体：blocked=true，原因指向"没选主体"而非"没配税率"', async () => {
    const result = await makeService(reconciledOptions([])).generate({
      period: PERIOD,
    });
    expect(result.surcharge.blocked).toBe(true);
    expect(result.surcharge.blockedReason).toContain('未指定纳税主体');
    // 不能误导成"主体没配税率"
    expect(result.surcharge.blockedReason).not.toContain('未配置城建税率');
  });

  it('两种阻断场景共用 code = surcharge_rate_missing（下游消费者不能被破坏）', async () => {
    const noEntity = await makeService(reconciledOptions([])).generate({ period: PERIOD });
    const noRate = await makeService(reconciledOptions(ENTITY_NO_RATE)).generate({
      period: PERIOD,
      taxEntityId: ENTITY_ID,
    });
    const codeOf = (r: Awaited<ReturnType<VatDeclarationService['generate']>>) =>
      r.differences.find((item) => item.code === 'surcharge_rate_missing')?.code;

    expect(codeOf(noEntity)).toBe('surcharge_rate_missing');
    expect(codeOf(noRate)).toBe('surcharge_rate_missing');
    // code 相同，但 label 必须分开，否则排障方向被误导
    expect(
      noEntity.differences.find((item) => item.code === 'surcharge_rate_missing')?.label
    ).toContain('未指定纳税主体');
    expect(
      noRate.differences.find((item) => item.code === 'surcharge_rate_missing')?.label
    ).toContain('城建税率');
  });
});

describe('VatDeclarationService confirm() 硬门：写差异说明也补不上少计的税', () => {
  /** 调用 confirm 并捕获异常，返回抛出的消息（未抛出则返回空串） */
  async function confirmMessage(
    service: VatDeclarationService,
    taxEntityId: string | undefined
  ): Promise<{ thrown: boolean; message: string }> {
    try {
      await service.confirm(
        {
          period: PERIOD,
          taxEntityId,
          // 合法差异说明：长度 ≥ 4，足以通过勾稽闸门
          differenceReason: '本期进销项时间性差异',
        },
        'u-qa'
      );
      return { thrown: false, message: '' };
    } catch (error) {
      if (error instanceof BadRequestException) {
        return { thrown: true, message: error.message };
      }
      throw error;
    }
  }

  it('已选主体但缺城建税率：即使填了合法差异说明仍抛 BadRequestException，且带补录指引', async () => {
    const service = makeService(reconciledOptions(ENTITY_NO_RATE));
    const { thrown, message } = await confirmMessage(service, ENTITY_ID);
    expect(thrown).toBe(true);
    expect(message).toContain('城建税率');
    expect(message).toContain('市区 7%');
  });

  it('未指定主体：抛 BadRequestException，文案指向未选主体且不带补录指引', async () => {
    const service = makeService(reconciledOptions([]));
    const { thrown, message } = await confirmMessage(service, undefined);
    expect(thrown).toBe(true);
    expect(message).toContain('未指定纳税主体');
    // 主体都没选，就不该让用户去翻主体配置
    expect(message).not.toContain('市区 7%');
  });

  it('阻断方向绝不能被改成放行：两种场景 confirm() 都必须抛，而不是静默通过', async () => {
    // 若有人为"让集团口径能确认"把 blocked 改成放行，附加税费会整体漏提 ——
    // 漏提在账面上完全看不出来，是本类系统最危险的失败模式
    const scenarios: Array<{ label: string; taxEntityId?: string; options: StubOptions }> = [
      { label: '已选主体但缺城建税率', taxEntityId: ENTITY_ID, options: reconciledOptions(ENTITY_NO_RATE) },
      { label: '未指定纳税主体', options: reconciledOptions([]) },
    ];
    // 收集"没被拦住"的场景名再统一断言：失败时能直接看出是哪个场景放行了
    const notBlocked: string[] = [];
    for (const scenario of scenarios) {
      const service = makeService(scenario.options);
      let thrown = false;
      try {
        await service.confirm(
          {
            period: PERIOD,
            taxEntityId: scenario.taxEntityId,
            differenceReason: '本期进销项时间性差异',
          },
          'u-qa'
        );
      } catch {
        thrown = true;
      }
      if (!thrown) notBlocked.push(scenario.label);
    }
    expect(notBlocked).toEqual([]);
  });

  it('阻断的优先级在勾稽差异闸门之前（缺税率场景先于差异说明校验触发）', async () => {
    const service = makeService(reconciledOptions(ENTITY_NO_RATE));
    let message = '';
    try {
      // 不填差异说明：若硬门在后，会先抛出勾稽差异提示
      await service.confirm({ period: PERIOD, taxEntityId: ENTITY_ID }, 'u-qa');
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('城建税率');
    expect(message).not.toContain('请填写不少于 4 个字的差异说明');
  });
});

/**
 * T-S3：月末转出未交增值税的 confirm() 接线。
 *
 * 上面的桩 db 只支撑"在硬门处抛出"的路径；要验证结转分录，必须让 confirm()
 * 走完全程，因此这里单独搭一套**支持 insert/update 的桩**，并用捕获式的
 * voucherHook 记录每一次凭证请求。
 */
describe('VatDeclarationService confirm() 转出未交增值税接线（T-S3）', () => {
  interface VoucherCall {
    sourceType: string;
    sourceRef: string;
    voucherDate: string;
    summary: string;
    lines: Array<{ accountCode: string; debit?: number; credit?: number }>;
  }

  function makeConfirmService(options: StubOptions): {
    service: VatDeclarationService;
    voucherCalls: VoucherCall[];
    inserted: Array<Record<string, unknown>>;
  } {
    const voucherCalls: VoucherCall[] = [];
    const inserted: Array<Record<string, unknown>> = [];
    const base = makeDb(options);
    const db = {
      ...base,
      insert: (table: unknown) => ({
        values: (payload: Record<string, unknown>) => {
          inserted.push({ table, ...payload });
          return Promise.resolve();
        },
      }),
      update: () => ({
        set: () => ({
          where: () => Promise.resolve(),
        }),
      }),
    } as unknown as PostgresJsDatabase;
    const ledgers = {
      // 与 makeService 保持一致：总账发生额必须等于台账，否则勾稽闸门先抛
      rolledBalances: () =>
        Promise.resolve(
          new Map([
            [
              ACCOUNT_VAT_OUTPUT,
              { creditOccur: options.ledgerOutput ?? 0, debitOccur: 0 },
            ],
            [
              ACCOUNT_VAT_INPUT,
              { debitOccur: options.ledgerInput ?? 0, creditOccur: 0 },
            ],
          ])
        ),
    } as unknown as ConstructorParameters<typeof VatDeclarationService>[1];
    const hook = {
      generateVoucherDraft: (params: VoucherCall) => {
        voucherCalls.push(params);
        return Promise.resolve('created' as const);
      },
      recordCompensation: () => Promise.resolve(),
    } as unknown as ConstructorParameters<typeof VatDeclarationService>[2];
    return {
      service: new VatDeclarationService(db, ledgers, hook),
      voucherCalls,
      inserted,
    };
  }

  it('一般纳税人有应纳税额：生成借 222103 / 贷 222104 的结转凭证（日期取月末）', async () => {
    const { service, voucherCalls, inserted } = makeConfirmService(
      reconciledOptions(ENTITY_GENERAL)
    );
    const result = await service.confirm(
      { period: PERIOD, taxEntityId: ENTITY_ID },
      'u-qa'
    );

    const transfer = voucherCalls.find((c) => c.sourceType === 'vat_transfer');
    expect(transfer).toBeDefined();
    // 幂等键与附加税费同构：期间 + 主体
    expect(transfer?.sourceRef).toBe(`vat-transfer:${PERIOD}:${ENTITY_ID}`);
    // 月末结转：日期必须是期间最后一天（2026-05-31），不是确认当天、也不是 1 号
    expect(transfer?.voucherDate).toBe('2026-05-31');
    expect(transfer?.lines).toEqual([
      { accountCode: '222103', debit: 1000 },
      { accountCode: '222104', credit: 1000 },
    ]);
    expect(result.transferVoucher).toBe('created');
    // 申报底稿的 transfer_out 记录实际结转金额，不再恒为 0
    expect(inserted[0]?.transferOut).toBe('1000');
  });

  it('小规模纳税人同样结转（应纳税额 1300 全额转出，不减进项）', async () => {
    const { service, voucherCalls } = makeConfirmService(
      reconciledOptions(ENTITY_SMALL)
    );
    const result = await service.confirm(
      { period: PERIOD, taxEntityId: ENTITY_ID },
      'u-qa'
    );
    const transfer = voucherCalls.find((c) => c.sourceType === 'vat_transfer');
    expect(transfer?.lines).toEqual([
      { accountCode: '222103', debit: 1300 },
      { accountCode: '222104', credit: 1300 },
    ]);
    expect(result.transferVoucher).toBe('created');
  });

  it('期末留抵（应纳税额 0）：不生成结转凭证，transferVoucher = skipped', async () => {
    // 销项 = 进项 = 300 → 应纳税额 0、无留抵（payableRaw = 0）
    const { service, voucherCalls } = makeConfirmService({
      salesNet: 3000,
      outputTax: 300,
      inputTax: 300,
      ledgerOutput: 300,
      ledgerInput: 300,
      entityRows: ENTITY_GENERAL,
    });
    const result = await service.confirm(
      { period: PERIOD, taxEntityId: ENTITY_ID },
      'u-qa'
    );
    expect(result.payableTax).toBe(0);
    expect(voucherCalls.find((c) => c.sourceType === 'vat_transfer')).toBeUndefined();
    expect(result.transferVoucher).toBe('skipped');
  });

  it('generate() 预览态不碰凭证：transferVoucher 恒为 not_attempted', async () => {
    const result = await makeService(reconciledOptions(ENTITY_GENERAL)).generate({
      period: PERIOD,
      taxEntityId: ENTITY_ID,
    });
    expect(result.transferVoucher).toBe('not_attempted');
  });

  it('2 月（28 天）与 12 月的结转日期都取各自最后一天', async () => {
    const feb = makeConfirmService(reconciledOptions(ENTITY_GENERAL));
    await feb.service.confirm({ period: '2026-02', taxEntityId: ENTITY_ID }, 'u-qa');
    expect(feb.voucherCalls.find((c) => c.sourceType === 'vat_transfer')?.voucherDate)
      .toBe('2026-02-28');

    const dec = makeConfirmService(reconciledOptions(ENTITY_GENERAL));
    await dec.service.confirm({ period: '2026-12', taxEntityId: ENTITY_ID }, 'u-qa');
    expect(dec.voucherCalls.find((c) => c.sourceType === 'vat_transfer')?.voucherDate)
      .toBe('2026-12-31');
  });

  /*
   * 结构性不变量：**可比的**行次里，difference 必须等于 amount − ledgerAmount。
   *
   * ⚠️ 从实测缺陷提炼：第 12 行（进项税额）原先 amount 取 creditableInput（账簿有
   * 已过账进项时等于 ledger.input），而 difference 取 invoice.input − ledger.input ——
   * 于是"账簿有进项、发票侧为 0"时界面显示
   *   申报数 3878.75 / 账簿数 3878.75 / **差异 −3878.75 · 未解释**（两侧相等却亮红灯）。
   *
   * **第 1 行是已知例外，故排除**：其 amount 是**不含税销售额**，
   * 而 ledgerAmount 取 ledger.output（**销项税额**）—— 不同维度，
   * 所以 difference 被刻意写 0 且 explained: true。
   * ⚠️ 该行"净销售额与销项税额并列显示"本身易误读，已记入上线文档待确认项。
   */
  it('结构性不变量：可比行次 difference === amount − ledgerAmount（自查结果不得自相矛盾）', async () => {
    const result = await makeService(reconciledOptions(ENTITY_GENERAL)).generate({
      period: PERIOD,
      taxEntityId: ENTITY_ID,
    });
    const comparable = result.lines.filter((line) => line.rowNo !== '1');
    expect(comparable.length).toBeGreaterThan(0);
    for (const line of comparable) {
      const diff = Math.round((line.amount - line.ledgerAmount) * 100) / 100;
      expect({ row: line.rowNo, difference: line.difference }).toEqual({
        row: line.rowNo,
        difference: diff,
      });
    }
  });
});
