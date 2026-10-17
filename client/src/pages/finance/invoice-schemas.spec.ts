import {
  CERT_STATUS_LABELS,
  CERT_STATUS_VARIANTS,
  DIRECTION_LABELS,
  FORM_DEFAULTS,
  INVOICE_STATUS_LABELS,
  INVOICE_TYPE_LABELS,
  VERIFY_STATUS_LABELS,
  VERIFY_STATUS_VARIANTS,
  buildInvoiceCsv,
  csvCell,
  filterLinkableArs,
  invoiceCsvHeaderLine,
  invoiceCsvRowLine,
  invoiceSchema,
  isValidTaxPeriod,
  sumTaxAmountByDirection,
  toLocalDate,
} from './invoice-schemas';
import { VAT_RATES } from '@shared/tax';
import type {
  ArItem,
  InvoiceCertificationStatus,
  InvoiceDirection,
  InvoiceItem,
  InvoiceStatus,
  InvoiceType,
  InvoiceVerifyStatus,
} from '@shared/api.interface';

/**
 * 发票台账纯逻辑规格（§5.9 / F8）。
 *
 * ## 为什么这些断言值得存在
 *
 * 本文件钉住的都是**改坏了也照样能跑、界面上还看不出来**的地方：
 *
 * · **CSV 导出列**：导出照样成功、Excel 照样打开，只是「税额」列里放着开票金额。
 *   对账的人拿这份台账去勾稽，错位不会被任何人发现。因此这里逐列（按列头 zip）
 *   断言取值，并额外钉住"表头与取值两侧列数必须相等"。
 * · **展示字典**：漏一个键不会报错，只会让表格与导出里出现 `vat_special` /
 *   `failed` / `deducted` 这类英文 key。因此用 `Record<契约联合类型, true>` 白名单
 *   断言"每个值都有非空标签"，且**字典里没有多余键**。
 * · **schema 边界**：金额 0 被拒 / 税率 0 必须合法 / 税率必须落在 `VAT_RATES` 内。
 * · **`toLocalDate`**：日历日语义（本文件用**注入的固定日期**测，不依赖"此刻"）。
 *
 * 断言全部针对**行为**而不是实现细节：例如「往来方」列断言的是"销项取客户名、
 * 进项取供应商名"，而不是"调用了哪个字段"。
 */
describe('发票台账 CSV 导出列（invoiceCsv*）', () => {
  /**
   * 完整构造 `InvoiceItem`（**不用** `as unknown as` 跳过检查）。
   *
   * 这样写是有意的：`customerName: string` 与 `supplierName: string | null` 的
   * 空值差异由契约类型强制体现 —— 下文"往来方"一列的断言正是建立在
   * "客户名非空、供应商名可空"这个契约事实之上。
   */
  function invoice(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
    return {
      id: 'i1',
      code: 'INV-001',
      contractId: 'c1',
      contractName: '合同甲',
      customerId: 'cu1',
      customerName: '客户甲',
      projectId: 'p1',
      projectName: '项目甲',
      invoiceNo: 'NO-0001',
      invoiceType: 'vat_normal',
      direction: 'sales',
      supplierId: 'su1',
      supplierName: '供应商甲',
      arId: 'ar1',
      arCode: 'AR-0001',
      apId: null,
      apCode: 'AP-0001',
      amount: 1234.56,
      taxRate: 13,
      taxAmount: 142.05,
      invoiceDate: '2026-10-16',
      status: 'voided',
      verifyStatus: 'failed',
      verifyTime: null,
      verifyError: '税局无记录',
      certificationStatus: 'deducted',
      certificationPeriod: '2026-09',
      isRedLetter: false,
      declaredPeriodConfirmed: false,
      voidReason: null,
      voidedAt: null,
      voidedBy: null,
      remark: '备注甲',
      createdAt: '2026-10-16T02:00:00.000Z',
      ...overrides,
    };
  }

  /** 拆开一行 CSV：每个单元格都被 `csvCell` 加了引号，故按 `","` 切分即可 */
  const cellsOf = (line: string): string[] => line.slice(1, -1).split('","');

  /** 与 `ap-schemas.spec.ts` 同一手法：按列头 zip 表头与取值，逐列断言 */
  const byHeader = (row: InvoiceItem): Map<string, string> => {
    const headers = cellsOf(invoiceCsvHeaderLine());
    const values = cellsOf(invoiceCsvRowLine(row));
    return new Map(headers.map((h, i) => [h, values[i]]));
  };

  it('列头与列序固定（列序错 = 整份台账错位）', () => {
    expect(cellsOf(invoiceCsvHeaderLine())).toEqual([
      '申请编号',
      '方向',
      '往来方',
      '合同',
      '发票类型',
      '发票号码',
      '关联应收',
      '开票金额（含税）',
      '税率',
      '税额',
      '开票日期',
      '状态',
      '备注',
    ]);
  });

  it('表头与取值两侧列数相等（只往一边加列的改动会让整行错位）', () => {
    expect(cellsOf(invoiceCsvRowLine(invoice())).length).toBe(
      cellsOf(invoiceCsvHeaderLine()).length,
    );
  });

  it('每列取到对应字段（金额 / 税率 / 税额三者互不串位）', () => {
    const m = byHeader(invoice());
    expect(m.get('申请编号')).toBe('INV-001');
    expect(m.get('方向')).toBe('销项');
    expect(m.get('往来方')).toBe('客户甲');
    expect(m.get('合同')).toBe('合同甲');
    expect(m.get('发票类型')).toBe('增值税普通发票');
    expect(m.get('发票号码')).toBe('NO-0001');
    expect(m.get('关联应收')).toBe('AR-0001');
    expect(m.get('开票金额（含税）')).toBe('1234.56');
    expect(m.get('税率')).toBe('13');
    expect(m.get('税额')).toBe('142.05');
    expect(m.get('开票日期')).toBe('2026-10-16');
    expect(m.get('状态')).toBe('已作废');
    expect(m.get('备注')).toBe('备注甲');
    // 反例防线：税额与开票金额若被写反，上面两条同时失败；这里再显式钉一次
    expect(m.get('税额')).not.toBe(m.get('开票金额（含税）'));
  });

  it('整行为带引号的 CSV，且数字按原样（非本地化）输出', () => {
    /*
     * 逐列断言之外再钉一次**整行字面量**：`csvCell` 的加引号、`String()` 的数字
     * 格式化（不能出现千分位或货币符号）一旦被改，这条会最直接地失败。
     */
    expect(invoiceCsvRowLine(invoice())).toBe(
      '"INV-001","销项","客户甲","合同甲","增值税普通发票","NO-0001","AR-0001",' +
        '"1234.56","13","142.05","2026-10-16","已作废","备注甲"',
    );
  });

  it('「往来方」：销项取客户名，进项取供应商名', () => {
    expect(byHeader(invoice({ direction: 'sales' })).get('往来方')).toBe('客户甲');
    const purchase = byHeader(
      invoice({ direction: 'purchase', customerName: '' }),
    ).get('往来方');
    expect(purchase).toBe('供应商甲');
    // 反例防线：进项若误取客户名，这里会是空串
    expect(purchase).not.toBe('客户甲');
  });

  it('null 字段导出空串（不是 "null" / "undefined" 字符串）', () => {
    const m = byHeader(
      invoice({
        direction: 'purchase',
        supplierName: null,
        invoiceNo: null,
        arCode: null,
        invoiceDate: null,
        remark: null,
      }),
    );
    expect(m.get('往来方')).toBe('');
    expect(m.get('发票号码')).toBe('');
    expect(m.get('关联应收')).toBe('');
    expect(m.get('开票日期')).toBe('');
    expect(m.get('备注')).toBe('');
    expect(m.get('备注')).not.toBe('null');
  });

  it('状态 / 发票类型走字典，契约外取值原样透出（不留空白格）', () => {
    expect(byHeader(invoice({ status: 'issued' })).get('状态')).toBe('已开票');
    expect(byHeader(invoice({ invoiceType: 'vat_special' })).get('发票类型')).toBe(
      '增值税专用发票',
    );
    /*
     * 契约类型不允许未知值，运行时却会遇到（后端新增状态、历史数据、脏数据）。
     * 此时必须是"原样透出"而不是 undefined —— 后者会在 Excel 里留空白格，
     * 接收方无法分辨"没有状态"与"数据丢了"。
     */
    const unknownStatus = { status: 'weird' } as unknown as Partial<InvoiceItem>;
    expect(byHeader(invoice(unknownStatus)).get('状态')).toBe('weird');
    const unknownType = { invoiceType: 'weird' } as unknown as Partial<InvoiceItem>;
    expect(byHeader(invoice(unknownType)).get('发票类型')).toBe('weird');
  });

  it('csvCell：空值 → 空串单元格，内部引号双写转义', () => {
    expect(csvCell(null)).toBe('""');
    expect(csvCell(undefined)).toBe('""');
    expect(csvCell(0)).toBe('"0"');
    expect(csvCell('a"b')).toBe('"a""b"');
  });

  it('buildInvoiceCsv：BOM + 表头 + 逐行，行间以 \\n 连接', () => {
    const csv = buildInvoiceCsv([invoice(), invoice({ code: 'INV-002' })]);
    expect(csv).toBe(
      `\uFEFF${invoiceCsvHeaderLine()}\n${invoiceCsvRowLine(invoice())}\n${invoiceCsvRowLine(
        invoice({ code: 'INV-002' }),
      )}`,
    );
    // BOM 是 Excel 正确识别 UTF-8 中文的前提，丢了会整份乱码 —— 显式钉住首字符
    expect(csv.startsWith('\uFEFF')).toBe(true);
    // 空列表只导出表头（组件层在此之前已用 toast 拦掉"无数据导出"）
    expect(buildInvoiceCsv([])).toBe(`\uFEFF${invoiceCsvHeaderLine()}`);
  });
});

describe('发票展示字典（表格与导出共用）', () => {
  /*
   * 白名单用 `Record<契约联合类型, true>` 写死：漏一个成员 `tsc` 直接报错，
   * 多一个成员也报错。这样"字典是否覆盖契约全量"才是**编译期**保证的，
   * 而不是靠人记得同步。
   */
  const ALL_TYPES: Record<InvoiceType, true> = {
    vat_special: true,
    vat_normal: true,
    electronic: true,
  };
  const ALL_STATUSES: Record<InvoiceStatus, true> = {
    issued: true,
    voided: true,
  };
  const ALL_DIRECTIONS: Record<InvoiceDirection, true> = {
    sales: true,
    purchase: true,
  };
  const ALL_VERIFY: Record<InvoiceVerifyStatus, true> = {
    unverified: true,
    verifying: true,
    verified: true,
    failed: true,
  };
  const ALL_CERT: Record<InvoiceCertificationStatus, true> = {
    uncertified: true,
    certified: true,
    deducted: true,
  };

  const BADGE_VARIANTS = [
    'warning',
    'success',
    'secondary',
    'destructive',
    'info',
    'default',
    'outline',
  ];

  it('方向字典覆盖契约两个方向，且销项/进项不互换', () => {
    expect(Object.keys(DIRECTION_LABELS).sort()).toEqual(
      Object.keys(ALL_DIRECTIONS).sort(),
    );
    expect(DIRECTION_LABELS.sales).toBe('销项');
    expect(DIRECTION_LABELS.purchase).toBe('进项');
    for (const d of Object.keys(ALL_DIRECTIONS) as InvoiceDirection[]) {
      expect(DIRECTION_LABELS[d]).toBeTruthy();
    }
  });

  it('发票类型字典覆盖 InvoiceType 全量（漏一个 → 登记下拉里少一个选项）', () => {
    /*
     * 这条断言同时挡住一个很自然的"统一"改动：把本字典换成
     * `@client/src/utils/biz-labels` 的同名常量（那一份**只有两个键**，
     * 缺 `electronic`）。登记弹窗的类型下拉正是由本字典渲染的 ——
     * 换过去会让「电子发票」直接消失，且表格/导出里显示英文 key。
     */
    expect(Object.keys(INVOICE_TYPE_LABELS).sort()).toEqual(
      Object.keys(ALL_TYPES).sort(),
    );
    expect(INVOICE_TYPE_LABELS.vat_special).toBe('增值税专用发票');
    expect(INVOICE_TYPE_LABELS.vat_normal).toBe('增值税普通发票');
    expect(INVOICE_TYPE_LABELS.electronic).toBe('电子发票');
  });

  it('发票状态字典覆盖 InvoiceStatus 全量', () => {
    expect(Object.keys(INVOICE_STATUS_LABELS).sort()).toEqual(
      Object.keys(ALL_STATUSES).sort(),
    );
    expect(INVOICE_STATUS_LABELS.issued).toBe('已开票');
    expect(INVOICE_STATUS_LABELS.voided).toBe('已作废');
  });

  it('查验状态：文字与颜色都覆盖 InvoiceVerifyStatus 全量', () => {
    const keys = Object.keys(ALL_VERIFY).sort();
    expect(Object.keys(VERIFY_STATUS_LABELS).sort()).toEqual(keys);
    expect(Object.keys(VERIFY_STATUS_VARIANTS).sort()).toEqual(keys);
    expect(VERIFY_STATUS_LABELS.verified).toBe('已通过');
    expect(VERIFY_STATUS_LABELS.failed).toBe('查验失败');
    for (const k of keys) {
      expect(VERIFY_STATUS_LABELS[k]).toBeTruthy();
      expect(BADGE_VARIANTS).toContain(VERIFY_STATUS_VARIANTS[k]);
    }
  });

  it('认证状态：文字与颜色都覆盖 InvoiceCertificationStatus 全量', () => {
    const keys = Object.keys(ALL_CERT).sort();
    expect(Object.keys(CERT_STATUS_LABELS).sort()).toEqual(keys);
    expect(Object.keys(CERT_STATUS_VARIANTS).sort()).toEqual(keys);
    expect(CERT_STATUS_LABELS.certified).toBe('已认证');
    expect(CERT_STATUS_LABELS.deducted).toBe('已抵扣');
    for (const k of keys) {
      expect(CERT_STATUS_LABELS[k]).toBeTruthy();
      expect(BADGE_VARIANTS).toContain(CERT_STATUS_VARIANTS[k]);
    }
  });

  it('字典外取值查不到（表格据此回退原值 / secondary，而不是渲染空白）', () => {
    /*
     * 组件里的用法是 `LABELS[v] ?? v` 与 `VARIANTS[v] ?? 'secondary'`。
     * 这里钉住"未知键返回 undefined"这个前提：若有人把 `Record` 换成带默认值的
     * Proxy / 兜底函数，回退逻辑会同时失效（状态列会整列显示成同一个兜底色）。
     */
    expect(VERIFY_STATUS_LABELS.weird).toBeUndefined();
    expect(VERIFY_STATUS_VARIANTS.weird).toBeUndefined();
    expect(CERT_STATUS_LABELS.weird).toBeUndefined();
    expect(CERT_STATUS_VARIANTS.weird).toBeUndefined();
  });
});

describe('发票登记表单 schema（invoiceSchema）', () => {
  const base = {
    direction: 'sales' as const,
    contractId: 'c1',
    supplierId: '',
    invoiceType: 'vat_special',
    amount: 1130,
    taxRate: 13,
    arId: 'none',
    invoiceNo: '',
    invoiceDate: '',
    remark: '',
  };

  it('开票金额门槛是 0.01：0 被拒、0.01 通过（"金额必须大于 0"的落地写法）', () => {
    expect(invoiceSchema.safeParse({ ...base, amount: 0.009 }).success).toBe(false);
    expect(invoiceSchema.safeParse({ ...base, amount: 0.01 }).success).toBe(true);
    // 表单未填金额时 input 给的是空串 → Number('') = 0，必须被拦
    const empty = invoiceSchema.safeParse({ ...base, amount: '' });
    expect(empty.success).toBe(false);
    if (!empty.success) {
      expect(empty.error.issues[0]?.message).toBe('开票金额必须大于 0');
    }
  });

  it('金额门槛**不是** 1（0.5 元开票金额合法，与应付/应收单据的门槛不是一回事）', () => {
    /*
     * 应付单/应收单的金额门槛是 `min(1)`（0 元负债、0 元应收没有业务含义），
     * 发票不同：它是**税务凭证**，门槛只表达"> 0"。若有人为了"统一"把这里
     * 也改成 `min(1)`，一分钱发票 / 尾差发票将登记不进来 —— 这条会失败。
     */
    expect(invoiceSchema.safeParse({ ...base, amount: 0.5 }).success).toBe(true);
    expect(invoiceSchema.safeParse({ ...base, amount: 1 }).success).toBe(true);
  });

  it('金额字符串被 coerce 成数字（表单 input 给的是字符串）', () => {
    const parsed = invoiceSchema.safeParse({ ...base, amount: '1234.56' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.amount).toBe(1234.56);
  });

  it('税率必须落在 VAT_RATES 内（含 5% 征收率档位）', () => {
    for (const rate of VAT_RATES) {
      expect(invoiceSchema.safeParse({ ...base, taxRate: rate }).success).toBe(true);
    }
    /*
     * 5% 是现行有效档位（一般纳税人简易计税 / 小规模出租不动产）。
     * 档位数组缺 5% 的后果是双向的：下拉里选不到、库层 CHECK 也拒收 ——
     * 合法的 5% 专票根本登记不进来。这里显式钉住它。
     */
    expect(VAT_RATES as readonly number[]).toContain(5);
    for (const bad of [2, 7, 100, -6]) {
      const parsed = invoiceSchema.safeParse({ ...base, taxRate: bad });
      expect(parsed.success).toBe(false);
      if (!parsed.success) {
        expect(parsed.error.issues[0]?.message).toBe('请选择合法税率');
      }
    }
  });

  it('税率 0 合法、但金额 0 被拒 —— 两个数值闸门**有意不同**', () => {
    /*
     * 这是本 schema 里最容易"被统一掉"的一对：
     *   · `taxRate = 0` 是真实的免税/出口档位（`VAT_RATES` 含 0），必须放行；
     *   · `amount = 0` 是"没填金额"，必须拦。
     * 若有人给税率补 `.min(1)`、或给金额换成 `.positive()` 之外的宽松写法，
     * 二者之一会失败，从而强制一次有意识的决定。
     */
    expect(invoiceSchema.safeParse({ ...base, taxRate: 0 }).success).toBe(true);
    expect(invoiceSchema.safeParse({ ...base, amount: 0 }).success).toBe(false);
  });

  it('发票类型必填', () => {
    const parsed = invoiceSchema.safeParse({ ...base, invoiceType: '' });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toBe('请选择发票类型');
    }
  });

  it('销项必须选合同；进项必须选供应商（superRefine 条件必填）', () => {
    const salesNoContract = invoiceSchema.safeParse({ ...base, contractId: '' });
    expect(salesNoContract.success).toBe(false);
    if (!salesNoContract.success) {
      expect(salesNoContract.error.issues[0]?.path).toEqual(['contractId']);
      expect(salesNoContract.error.issues[0]?.message).toBe('请选择合同');
    }

    const purchaseNoSupplier = invoiceSchema.safeParse({
      ...base,
      direction: 'purchase',
      supplierId: '',
    });
    expect(purchaseNoSupplier.success).toBe(false);
    if (!purchaseNoSupplier.success) {
      expect(purchaseNoSupplier.error.issues[0]?.path).toEqual(['supplierId']);
      expect(purchaseNoSupplier.error.issues[0]?.message).toBe('请选择供应商');
    }
  });

  it('条件必填是**单向**的：销项不要求供应商、进项不要求合同', () => {
    expect(invoiceSchema.safeParse({ ...base, supplierId: '' }).success).toBe(true);
    expect(
      invoiceSchema.safeParse({
        ...base,
        direction: 'purchase',
        contractId: '',
        supplierId: 's1',
      }).success,
    ).toBe(true);
  });

  it('FORM_DEFAULTS 与默认态：默认税率必须是合法档位、默认 arId 是哨兵 "none"', () => {
    expect(FORM_DEFAULTS).toEqual({
      direction: 'sales',
      contractId: '',
      supplierId: '',
      invoiceType: 'vat_special',
      amount: 0,
      taxRate: 6,
      arId: 'none',
      invoiceNo: '',
      invoiceDate: '',
      remark: '',
    });
    /*
     * 默认税率若不在 `VAT_RATES` 内，表单**一打开就是非法状态**（用户什么都没动
     * 也会被"请选择合法税率"拦住），因此这条不是形式主义。
     * `arId: 'none'` 是"不关联应收"的哨兵值（提交时被过滤掉），不能写成空串 ——
     * 空串会让"未选择"与"选择不关联"两个状态混在一起。
     */
    expect(VAT_RATES as readonly number[]).toContain(FORM_DEFAULTS.taxRate);
    expect(FORM_DEFAULTS.arId).toBe('none');
  });

  it('未填写的默认表单不可提交（金额 0 与未选合同都被拦）', () => {
    const parsed = invoiceSchema.safeParse(FORM_DEFAULTS);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const paths = parsed.error.issues.map((i) => i.path.join('.'));
      expect(paths).toContain('amount');
      expect(paths).toContain('contractId');
    }
  });
});

describe('勾选认证税款所属期（isValidTaxPeriod）', () => {
  it('接受 YYYY-MM（月份 01–12 两端都合法）', () => {
    expect(isValidTaxPeriod('2026-01')).toBe(true);
    expect(isValidTaxPeriod('2026-03')).toBe(true);
    expect(isValidTaxPeriod('2026-10')).toBe(true);
    expect(isValidTaxPeriod('2026-12')).toBe(true);
  });

  it('拒绝月份 13 / 00（只查 \\d{2} 的正则会放进"13 月"这种脏期间）', () => {
    /*
     * 这类"月份不 range-check"的写法在本仓出现过：正则写成 `\d{2}` 时
     * `2026-13` 会被当成合法期间发给后端。此处月份必须落在 01–12。
     * 服务端 `CertifyInvoiceDto`（`finance.dto.ts`）与
     * `InvoiceVerifyService.PERIOD_PATTERN` 用的是同一条正则，两侧一致。
     */
    expect(isValidTaxPeriod('2026-13')).toBe(false);
    expect(isValidTaxPeriod('2026-00')).toBe(false);
    expect(isValidTaxPeriod('2026-99')).toBe(false);
  });

  it('拒绝非补零 / 非 YYYY-MM 的写法', () => {
    for (const bad of ['2026-3', '2026-1', '202603', '2026-03-01', '2026/03', '', 'x', '26-03']) {
      expect(isValidTaxPeriod(bad)).toBe(false);
    }
  });

  it('**不**限定年份范围（与后端 DTO 一致：只校验格式）', () => {
    /*
     * 登记现状而不是认可它：年份的合理性由后端校验，客户端这里只拦格式。
     * 若将来要加年份下界，这条会失败 —— 从而强制一次有意识的决定
     * （并同步改后端 DTO，否则前端放行、后端 400）。
     */
    expect(isValidTaxPeriod('0000-01')).toBe(true);
    expect(isValidTaxPeriod('9999-12')).toBe(true);
  });
});

describe('toLocalDate（用户选的那一天 → 日历日）', () => {
  it('按**本地日历日**格式化注入的固定日期', () => {
    expect(toLocalDate(new Date(2026, 0, 1))).toBe('2026-01-01');
    expect(toLocalDate(new Date(2026, 5, 15))).toBe('2026-06-15');
    expect(toLocalDate(new Date(2026, 11, 31))).toBe('2026-12-31');
  });

  it('月 / 日补零到两位（不补零会让后端把 2026-6-5 当非法日期）', () => {
    expect(toLocalDate(new Date(2026, 8, 9))).toBe('2026-09-09');
  });

  it('边界：当天 23:59:59 仍属于当天，不会进位到次日', () => {
    expect(toLocalDate(new Date(2026, 0, 1, 23, 59, 59))).toBe('2026-01-01');
    expect(toLocalDate(new Date(2026, 11, 31, 23, 59, 59, 999))).toBe('2026-12-31');
    // 反例防线：若误用 UTC 取日（或时区口径），东八区下的这一毫秒会变成 2027-01-01
    expect(toLocalDate(new Date(2026, 11, 31, 23, 59, 59))).not.toBe('2027-01-01');
  });

  it('与日历组件的往返一致（`selected` 的解析 → 格式化结果不变）', () => {
    /*
     * 组件里 `selected={new Date(`${field.value}T00:00:00`)}`、
     * `onChange(toLocalDate(date))` —— 这里钉住这个往返：
     * 用户选的那天存进去、再渲染回来，必须是同一天。
     * 这正是**不能**改成"上海时区口径"的原因：纽约用户选 10-16，
     * 按上海格式化会存成 10-17（日历日位移）。
     */
    for (const iso of ['2026-01-01', '2026-06-15', '2026-10-16', '2026-12-31']) {
      expect(toLocalDate(new Date(`${iso}T00:00:00`))).toBe(iso);
    }
  });
});

describe('可关联应收（filterLinkableArs）', () => {
  const ar = (code: string, status: ArItem['status']): ArItem =>
    ({ id: code, code, status }) as unknown as ArItem;

  it('只保留 open / partial（已核销完毕的应收不可再关联开票）', () => {
    const result = filterLinkableArs([
      ar('AR-OPEN', 'open'),
      ar('AR-PARTIAL', 'partial'),
      ar('AR-SETTLED', 'settled'),
      ar('AR-VOIDED', 'voided'),
    ]);
    expect(result.map((a) => a.code)).toEqual(['AR-OPEN', 'AR-PARTIAL']);
    // 反例防线：`settled` 若被放过，下拉里会出现已核销完毕的应收单
    expect(result.map((a) => a.code)).not.toContain('AR-SETTLED');
  });

  it('数据未加载（undefined）时返回空数组而不是抛错', () => {
    expect(filterLinkableArs(undefined)).toEqual([]);
  });
});

describe('税额合计（sumTaxAmountByDirection）', () => {
  function row(
    direction: InvoiceDirection,
    amount: number,
    taxAmount: number,
    code: string,
  ): InvoiceItem {
    return {
      id: code,
      code,
      direction,
      amount,
      taxAmount,
    } as unknown as InvoiceItem;
  }

  it('销项与进项分别汇总，且取的是税额而不是金额', () => {
    const rows = [
      row('sales', 1130, 130, 'S1'),
      row('sales', 1060, 60, 'S2'),
      row('purchase', 1010, 10, 'P1'),
    ];
    expect(sumTaxAmountByDirection(rows, 'sales')).toBe(190);
    expect(sumTaxAmountByDirection(rows, 'purchase')).toBe(10);
    // 反例防线：若误用 amount 汇总，销项会是 2190；若两个方向写反，两数互换
    expect(sumTaxAmountByDirection(rows, 'sales')).not.toBe(2190);
    expect(sumTaxAmountByDirection(rows, 'sales')).not.toBe(
      sumTaxAmountByDirection(rows, 'purchase'),
    );
  });

  it('空列表 / 无该方向时为 0（不是 NaN）', () => {
    expect(sumTaxAmountByDirection([], 'sales')).toBe(0);
    expect(sumTaxAmountByDirection([row('purchase', 100, 1, 'P1')], 'sales')).toBe(0);
  });
});
