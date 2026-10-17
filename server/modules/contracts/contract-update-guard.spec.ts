import {
  CONTRACT_AMOUNT_LOCKED_MESSAGE,
  CONTRACT_CUSTOMER_LOCKED_MESSAGE,
  CONTRACT_DRAFT_ONLY_FIELDS,
  CONTRACT_FROZEN_FIELDS,
  CONTRACT_FROZEN_MESSAGE,
  CONTRACT_FROZEN_STATUSES,
  contractUpdateBlockReason,
} from './contract-update-guard';

/**
 * 合同更新守卫规格（合同编辑入口落地同批）。
 *
 * ## 为什么这些断言值得存在
 *
 * 合同编辑此前**没有前端入口**（服务端 `updateContract` 已实现、全仓 0 处调用），
 * 于是它那两条内联守卫从来没有被任何前端流程走过。本轮补上编辑弹窗后它第一次可达，
 * 而最容易出的错不是"拦住太多"而是**漏拦**：
 *
 * | 漏拦的字段 | 界面上看不到任何异常 | 真实后果 |
 * |---|---|---|
 * | 非 draft 的 `customerId` | 保存成功、提示"合同已更新" | 发票/应收仍挂原客户 → `applyWriteoffInTx` 的「回款客户与应收客户不一致」守卫让这批应收**永远无法核销** |
 * | 冻结状态的 `billingModel` | 保存成功 | 已关闭合同的历史报表口径被改写（金额怎么摊的解释方式变了） |
 * | 非 draft 的 `amount` | 保存成功 | 绕过「合同变更流程」，金额改动无留痕（这是**原有**设计，规格在此钉住不许放宽） |
 *
 * 三档判据（普通 / 冻结 / 限草稿）都写成常量并在下面**逐个字段**断言，是为了让
 * "将来加字段时忘了同步常量"这类改动至少有一条断言变红。
 */
describe('contractUpdateBlockReason', () => {
  describe('普通字段：任何非冻结状态都可改', () => {
    it.each(['draft', 'approving', 'active', 'performing', 'completed'])(
      '%s 状态下改 signDate 放行',
      (status) => {
        expect(contractUpdateBlockReason(status, { signDate: '2026-10-16' })).toBeNull();
      },
    );

    it('执行中（performing）改 计费模式 / 签订日期 / 付款条款 均放行', () => {
      expect(
        contractUpdateBlockReason('performing', {
          billingModel: 'quantity',
          signDate: '2026-01-01',
          paymentTerms: '验收后 30 天',
        }),
      ).toBeNull();
    });

    it('空请求体（什么都没改）放行', () => {
      expect(contractUpdateBlockReason('active', {})).toBeNull();
    });
  });

  describe('限草稿字段：非 draft 一律被拒（本轮新增 customerId）', () => {
    it.each(['approving', 'active', 'performing', 'completed'])(
      '%s 状态改 customerId → 拒绝，且文案说明"发票与应收挂在原客户上"',
      (status) => {
        expect(contractUpdateBlockReason(status, { customerId: 'c-2' })).toBe(
          CONTRACT_CUSTOMER_LOCKED_MESSAGE,
        );
      },
    );

    it('draft 状态改 customerId 放行（登录后即可用编辑弹窗换客户）', () => {
      expect(contractUpdateBlockReason('draft', { customerId: 'c-2' })).toBeNull();
    });

    it('非 draft 改 amount → 仍是原有那句「须走合同变更流程」（不许放宽、不许改文案）', () => {
      expect(contractUpdateBlockReason('active', { amount: 100 })).toBe(
        CONTRACT_AMOUNT_LOCKED_MESSAGE,
      );
    });

    it('draft 状态改 amount 放行', () => {
      expect(contractUpdateBlockReason('draft', { amount: 100 })).toBeNull();
    });

    it('amount 与 customerId 同时出现时先报金额（指向正式变更入口）', () => {
      expect(
        contractUpdateBlockReason('active', { amount: 1, customerId: 'c-2' }),
      ).toBe(CONTRACT_AMOUNT_LOCKED_MESSAGE);
    });

    it('判据是"字段出现即拒"，未改动的 customerId 也会被拒 —— 前端必须只下发改动字段', () => {
      // 与既有 amount 守卫同一语义；`contract-edit-model.spec.ts` 从另一侧钉住前端行为
      expect(contractUpdateBlockReason('active', { customerId: 'c-1' })).toBe(
        CONTRACT_CUSTOMER_LOCKED_MESSAGE,
      );
    });
  });

  describe('冻结状态（已关闭 / 已终止）', () => {
    it.each(CONTRACT_FROZEN_STATUSES)('%s 状态改 billingModel → 拒绝', (status) => {
      expect(contractUpdateBlockReason(status, { billingModel: 'framework' })).toBe(
        CONTRACT_FROZEN_MESSAGE,
      );
    });

    it.each(CONTRACT_FROZEN_STATUSES)('%s 状态改 name → 拒绝（原有守卫未放宽）', (status) => {
      expect(contractUpdateBlockReason(status, { name: '改名' })).toBe(
        CONTRACT_FROZEN_MESSAGE,
      );
    });

    it('冻结字段清单必须含 billingModel（否则上面的断言会变成空转）', () => {
      expect(CONTRACT_FROZEN_FIELDS).toContain('billingModel');
      expect(CONTRACT_FROZEN_FIELDS).toContain('name');
    });

    it('冻结状态下改 signDate / paymentTerms 放行（它们不在冻结集合里）', () => {
      expect(
        contractUpdateBlockReason('closed', {
          signDate: '2026-02-02',
          paymentTerms: '结清后 7 天',
        }),
      ).toBeNull();
    });

    it('冻结文案必须点名计费模式 —— 否则使用者按提示改别的字段仍会被拒', () => {
      expect(CONTRACT_FROZEN_MESSAGE).toContain('计费模式');
    });
  });

  describe('常量与判据的对应关系（防止"加了字段忘了加判据"）', () => {
    it('限草稿集合恰好是 amount 与 customerId', () => {
      expect([...CONTRACT_DRAFT_ONLY_FIELDS].sort()).toEqual(['amount', 'customerId']);
    });

    it('冻结集合与限草稿集合不相交（否则同一字段会有两条互相矛盾的判据）', () => {
      const frozen = new Set<string>(CONTRACT_FROZEN_FIELDS);
      expect(CONTRACT_DRAFT_ONLY_FIELDS.filter((f) => frozen.has(f))).toEqual([]);
    });
  });
});
