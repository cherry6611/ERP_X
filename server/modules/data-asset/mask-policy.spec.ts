import {
  GRANT_REVOKE_REASONS,
  MASK_LEVELS,
  MASK_LEVEL_LABELS,
  MASK_LEVEL_DESCRIPTIONS,
  MASK_BLOCKED,
  amountBucket,
  isMaskLevel,
  maskFieldValue,
  maskKeepEdges,
  maskLevelRank,
  maskRows,
  normalizeMaskLevel,
  requiresDestructionProof,
  validateRevoke,
  type MaskLevel,
} from './mask-policy';

/**
 * C-13 数据资产脱敏等级与授权回收审计的单测。
 *
 * 这组测试的定位是**合规回归**：脱敏规则一旦被改错（例如把身份证掩码改成
 * 可逆、或把 L4 的阻断降级为掩码），必须立刻失败，而不是等审计时才发现。
 */
describe('C-13 脱敏等级', () => {
  it('等级是封闭枚举，且排序递增（L1 < L2 < L3 < L4）', () => {
    expect(MASK_LEVELS).toEqual(['L1', 'L2', 'L3', 'L4']);
    expect(maskLevelRank('L1')).toBeLessThan(maskLevelRank('L2'));
    expect(maskLevelRank('L2')).toBeLessThan(maskLevelRank('L3'));
    expect(maskLevelRank('L3')).toBeLessThan(maskLevelRank('L4'));
  });

  it('每个等级都有中文标签与说明（供前端下拉与审计报告使用）', () => {
    for (const level of MASK_LEVELS) {
      expect(MASK_LEVEL_LABELS[level]).toContain(level);
      const description = MASK_LEVEL_DESCRIPTIONS[level] ?? '';
      expect(description.length).toBeGreaterThan(5);
      expect(/[\u4e00-\u9fff]/.test(description)).toBe(true);
    }
  });

  it('未知等级归一化为最严格的 L4（不能因为填错值就不脱敏）', () => {
    expect(normalizeMaskLevel(null)).toBe('L4');
    expect(normalizeMaskLevel('')).toBe('L4');
    expect(normalizeMaskLevel('乱填')).toBe('L4');
    expect(normalizeMaskLevel('L9')).toBe('L4');
  });

  it('兼容历史写法 level2 / lv3 / 2', () => {
    expect(normalizeMaskLevel('level2')).toBe('L2');
    expect(normalizeMaskLevel('lv3')).toBe('L3');
    expect(normalizeMaskLevel('2')).toBe('L2');
    expect(normalizeMaskLevel('l4')).toBe('L4');
  });

  it('isMaskLevel 只接受枚举成员', () => {
    expect(isMaskLevel('L1')).toBe(true);
    expect(isMaskLevel('level2')).toBe(false);
    expect(isMaskLevel(2)).toBe(false);
  });
});

describe('C-13 字段级脱敏规则', () => {
  it('L1 原样保留', () => {
    expect(maskFieldValue('phone', '13800138000', 'L1')).toBe('13800138000');
    expect(maskFieldValue('id_card', '110101199001011234', 'L1')).toBe(
      '110101199001011234'
    );
  });

  it('L2 起手机号掩码，保留前 3 后 4 以便业务核对', () => {
    const masked = maskFieldValue('phone', '13800138000', 'L2');
    expect(masked).toBe('138****8000');
    expect(String(masked)).not.toContain('13800138000');
  });

  it('邮箱只掩码 @ 前部分，保留域名', () => {
    const masked = maskFieldValue('email', 'zhangsan@example.com', 'L2');
    expect(String(masked)).toMatch(/^z\*+@example\.com$/);
  });

  it('L2 不掩码姓名（内部业务需要区分同名），L3 起掩码', () => {
    expect(maskFieldValue('name', '张三', 'L2')).toBe('张三');
    expect(maskFieldValue('name', '张三', 'L3')).toBe('张*');
  });

  it('身份证号在 L4 下禁止导出（返回 MASK_BLOCKED 而非掩码）', () => {
    expect(maskFieldValue('id_card', '110101199001011234', 'L3')).not.toBe(
      MASK_BLOCKED
    );
    expect(maskFieldValue('id_card', '110101199001011234', 'L4')).toBe(
      MASK_BLOCKED
    );
  });

  it('银行账号在 L4 下禁止导出', () => {
    expect(maskFieldValue('bank_account', '6222021234567890123', 'L3')).not.toBe(
      MASK_BLOCKED
    );
    expect(maskFieldValue('bank_account', '6222021234567890123', 'L4')).toBe(
      MASK_BLOCKED
    );
  });

  it('地址在 L3/L4 只保留省市区前缀，不泄露门牌号', () => {
    const masked = String(
      maskFieldValue('address', '北京市朝阳区建国路88号SOHO现代城A座1001', 'L3')
    );
    expect(masked.startsWith('北京市朝阳')).toBe(true);
    expect(masked).not.toContain('1001');
    expect(masked).not.toContain('SOHO');
  });

  it('金额在 L3/L4 区间化，避免反推具体客户', () => {
    expect(maskFieldValue('amount', '1234.56', 'L2')).toBe('1234.56');
    expect(maskFieldValue('amount', '1234.56', 'L3')).toBe('1千~1万');
    expect(maskFieldValue('amount', '99999999', 'L4')).toBe('≥1000万');
  });

  it('空值一律返回空串（不产生 "null" 字面量）', () => {
    expect(maskFieldValue('phone', null, 'L3')).toBe('');
    expect(maskFieldValue('phone', undefined, 'L3')).toBe('');
    expect(maskFieldValue('phone', '', 'L3')).toBe('');
  });
});

describe('C-13 金额分档边界', () => {
  it('各档边界正确且相邻档不重叠', () => {
    expect(amountBucket(0)).toBe('0');
    expect(amountBucket(999)).toBe('<1千');
    expect(amountBucket(1000)).toBe('1千~1万');
    expect(amountBucket(9999)).toBe('1千~1万');
    expect(amountBucket(10000)).toBe('1万~10万');
    expect(amountBucket(99999)).toBe('1万~10万');
    expect(amountBucket(100000)).toBe('10万~100万');
    expect(amountBucket(999999)).toBe('10万~100万');
    expect(amountBucket(1000000)).toBe('100万~1000万');
    expect(amountBucket(9999999)).toBe('100万~1000万');
    expect(amountBucket(10000000)).toBe('≥1000万');
  });

  it('负数按绝对值分档（冲销/红字也适用）', () => {
    expect(amountBucket(-5000)).toBe('1千~1万');
  });
});

describe('C-13 整表脱敏', () => {
  const rows = [
    {
      customerName: '张三',
      phone: '13800138000',
      idCard: '110101199001011234',
      amount: 12345.67,
      remark: '正常客户',
    },
    {
      customerName: '李四',
      phone: '13900139000',
      idCard: '110101199101011234',
      amount: 200,
      remark: '小额',
    },
  ];
  const kinds = {
    customerName: 'name',
    phone: 'phone',
    idCard: 'id_card',
    amount: 'amount',
  } as const;

  it('L2：手机掩码、身份证掩码、金额保留原值、姓名保留', () => {
    const { rows: masked, blockedColumns } = maskRows(rows, { ...kinds }, 'L2');
    expect(masked[0].phone).toBe('138****8000');
    expect(masked[0].customerName).toBe('张三');
    expect(masked[0].amount).toBe(12345.67);
    expect(String(masked[0].idCard)).not.toContain('110101199001011234');
    expect(blockedColumns).toEqual([]);
  });

  it('L4：身份证列进入 blockedColumns（调用方必须跳过写入，而不是写空串）', () => {
    const { rows: masked, blockedColumns } = maskRows(rows, { ...kinds }, 'L4');
    expect(blockedColumns).toContain('idCard');
    expect(masked[0].idCard).toBeUndefined();
  });

  it('L4：未登记的列一并阻断（防止新增列悄悄绕过脱敏）', () => {
    const { rows: masked, blockedColumns } = maskRows(rows, { ...kinds }, 'L4');
    // remark 未登记且是字符串 → other 在 L4 下整体掩码
    expect(String(masked[0].remark)).toMatch(/^\*+$/);
    expect(Object.keys(masked[0])).not.toContain('idCard');
    expect(blockedColumns.length).toBeGreaterThan(0);
  });

  it('L4：未登记的非字符串列也被阻断（JSON 字段可能夹带敏感内容）', () => {
    const { blockedColumns } = maskRows(
      [{ meta: { a: 1 }, customerName: '张三' }],
      { customerName: 'name' },
      'L4'
    );
    expect(blockedColumns).toContain('meta');
  });

  it('脱敏不改变行数，且每行都产出新对象（不原地修改入参）', () => {
    const original = JSON.parse(JSON.stringify(rows));
    const { rows: masked } = maskRows(rows, { ...kinds }, 'L3');
    expect(masked.length).toBe(rows.length);
    expect(rows).toEqual(original);
  });
});

describe('C-13 授权回收审计', () => {
  it('L1~L3 的常规回收不要求销毁凭证与双人复核', () => {
    for (const level of ['L1', 'L2', 'L3'] as MaskLevel[]) {
      expect(requiresDestructionProof(level)).toBe(false);
      expect(
        validateRevoke({
          maskLevel: level,
          reason: 'manual',
          operator: 'u1',
        })
      ).toEqual([]);
    }
  });

  it('L4 必须双人复核：reviewedBy 为空报错', () => {
    const errors = validateRevoke({
      maskLevel: 'L4',
      reason: 'manual',
      operator: 'u1',
      destructionProof: 'DOC-1',
    });
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('复核');
  });

  it('L4 复核人不能与操作人相同（否则双人确认形同虚设）', () => {
    const errors = validateRevoke({
      maskLevel: 'L4',
      reason: 'manual',
      operator: 'u1',
      reviewedBy: 'u1',
      destructionProof: 'DOC-1',
    });
    expect(errors.some((e) => e.includes('复核人不能与操作人相同'))).toBe(true);
  });

  it('L4 必须登记销毁凭证', () => {
    const errors = validateRevoke({
      maskLevel: 'L4',
      reason: 'manual',
      operator: 'u1',
      reviewedBy: 'u2',
    });
    expect(errors.some((e) => e.includes('销毁凭证'))).toBe(true);
  });

  it('L4 满足全部要求时校验通过', () => {
    expect(
      validateRevoke({
        maskLevel: 'L4',
        reason: 'contract_terminated',
        operator: 'u1',
        reviewedBy: 'u2',
        destructionProof: 'DOC-2026-001',
      })
    ).toEqual([]);
  });

  it('违规回收无论等级都必须登记销毁凭证', () => {
    const errors = validateRevoke({
      maskLevel: 'L2',
      reason: 'violation',
      operator: 'u1',
    });
    expect(errors.some((e) => e.includes('违规回收'))).toBe(true);
  });

  it('未知等级按 L4 严格处理（不因填错等级而放松回收要求）', () => {
    const errors = validateRevoke({
      maskLevel: '乱填',
      reason: 'manual',
      operator: 'u1',
    });
    expect(errors.length).toBeGreaterThanOrEqual(2);
  });

  it('回收原因是封闭枚举', () => {
    expect(GRANT_REVOKE_REASONS).toContain('expired');
    expect(GRANT_REVOKE_REASONS).toContain('contract_terminated');
    expect(GRANT_REVOKE_REASONS).toContain('violation');
  });
});

describe('C-13 掩码工具函数', () => {
  it('maskKeepEdges 在长度不足时整体掩码（不泄露原文）', () => {
    expect(maskKeepEdges('ab', 3, 4)).toBe('***');
    expect(maskKeepEdges('', 1, 1)).toBe('***');
  });

  it('maskKeepEdges 中间替换为等长 *', () => {
    expect(maskKeepEdges('13800138000', 3, 4)).toBe('138****8000');
  });
});

