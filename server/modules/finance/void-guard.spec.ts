import {
  PAYABLE_AP_STATUSES,
  WRITEOFFABLE_AP_STATUSES,
  WRITEOFFABLE_AR_STATUSES,
  blockedReasonForWriteAction,
} from './void-guard';

/**
 * 作废单据的付款/核销守卫规格（B1 作废路径收尾）。
 *
 * ## 为什么这几条断言值得存在
 *
 * 三处守卫守的是"**钱能不能对一张已作废的单据流动**"。它们是同一轮里补上的，
 * 而补之前的状态是：
 *
 * | 入口 | 补守卫前的行为 |
 * |---|---|
 * | `ApService.createPayment` | 只校验"应付存在 + 余额"，**不看状态** → 作废单可登记付款 |
 * | `ApService.apWriteoff` | 不拦，且末尾状态重算把 `'voided'` **覆盖成** `'paid'`/`'partial'` → 作废单被"复活"，而冲回凭证还在账上 |
 * | `ArService.writeoff` | 只校验"未核销余额 > 0"，而作废单的余额**通常仍是正数** → 拦不住 |
 *
 * 关键在于：**余额校验无法替代状态校验**（作废单的 `amount − settled` 往往为正），
 * 所以"加个余额判断就够了"是错的。下面的用例专门钉住这一点。
 *
 * 判据用白名单而非 `!== 'voided'`：作废状态的集合将来会增长（`rejected`/
 * `cancelled`/…），白名单的失效方向是**拒绝**（安全），黑名单的失效方向是
 * **放行**（危险）。规格里有断言钉住这个方向。
 */
describe('blockedReasonForWriteAction', () => {
  describe('作废单据必须被拒（三处守卫的核心）', () => {
    it('应付作废 → 登记付款被拒，且文案点名"已作废"', () => {
      const reason = blockedReasonForWriteAction(
        'voided',
        PAYABLE_AP_STATUSES,
        '登记付款',
        '应付',
      );
      expect(reason).toBe('应付已作废，不可登记付款');
    });

    it('应付作废 → 核销被拒', () => {
      expect(
        blockedReasonForWriteAction(
          'voided',
          WRITEOFFABLE_AP_STATUSES,
          '核销',
          '应付',
        ),
      ).toBe('应付已作废，不可核销');
    });

    it('应收作废 → 核销被拒（`ArService.writeoff` 的那一处）', () => {
      expect(
        blockedReasonForWriteAction(
          'voided',
          WRITEOFFABLE_AR_STATUSES,
          '核销',
          '应收',
        ),
      ).toBe('应收已作废，不可核销');
    });

    it('文案必须是**中文**且含"作废"（不能是一句笼统的"状态不可操作"）', () => {
      /*
       * 为什么强调这点：作废是最常见的拦截原因，而排障者看到
       * "当前状态不可操作"时无从判断是作废、还是单据走到了别的非预期状态。
       * 文案里点名"已作废"能让使用者立刻知道该去看什么。
       */
      const reason = blockedReasonForWriteAction(
        'voided',
        PAYABLE_AP_STATUSES,
        '登记付款',
        '应付',
      );
      expect(reason).toContain('作废');
      expect(/[\u4e00-\u9fa5]/u.test(reason ?? '')).toBe(true);
      expect(reason).not.toContain('voided');
    });
  });

  describe('正常状态必须放行（守卫不能误伤主流程）', () => {
    it('应付的四种正常状态都可登记付款', () => {
      for (const status of ['pending', 'approved', 'partial', 'paid']) {
        expect(
          blockedReasonForWriteAction(
            status,
            PAYABLE_AP_STATUSES,
            '登记付款',
            '应付',
          ),
        ).toBeNull();
      }
    });

    it('应收的三种正常状态都可核销', () => {
      for (const status of ['open', 'partial', 'settled']) {
        expect(
          blockedReasonForWriteAction(
            status,
            WRITEOFFABLE_AR_STATUSES,
            '核销',
            '应收',
          ),
        ).toBeNull();
      }
    });

    it('**`paid` 仍放行是有意的**：让"为什么不能付"由余额口径回答', () => {
      /*
       * 反例防线：若有人"顺手"把 `paid` 从白名单里去掉，`createPayment` 会先在
       * 状态守卫处抛一句笼统的话，而不是走到余额校验给出
       * "付款金额超过应付可付余额 X（已占用 Y）"这种**带数字**的报错。
       * 后者对使用者有用得多（他需要知道还能付多少）。
       */
      expect(PAYABLE_AP_STATUSES).toContain('paid');
      expect(
        blockedReasonForWriteAction('paid', PAYABLE_AP_STATUSES, '登记付款', '应付'),
      ).toBeNull();
    });
  });

  describe('白名单的失效方向必须是"拒绝"而不是"放行"', () => {
    it('未知状态 → 拒绝（不能 fail-open）', () => {
      /*
       * 这是白名单相对 `!== 'voided'` 的**全部价值**所在：
       * 将来状态机新增 `rejected` / `cancelled` / `superseded` 时，
       * 黑名单写法会默默放行一笔本不该发生的付款；白名单会拒绝。
       * 这条断言把该方向钉死。
       */
      for (const unknown of [
        'rejected',
        'cancelled',
        'superseded',
        'closed',
        'weird',
        '',
      ]) {
        const reason = blockedReasonForWriteAction(
          unknown,
          PAYABLE_AP_STATUSES,
          '登记付款',
          '应付',
        );
        expect(reason).not.toBeNull();
      }
    });

    it('未知状态给通用文案（不谎称"已作废"）', () => {
      expect(
        blockedReasonForWriteAction('cancelled', PAYABLE_AP_STATUSES, '登记付款', '应付'),
      ).toBe('应付当前状态不可登记付款');
    });

    it('`null` / `undefined` 状态 → 拒绝（脏数据不能变成放行）', () => {
      /*
       * 数据库里 `status` 理论上有 NOT NULL 约束与默认值，但历史数据或
       * 异常写入都可能给出 null。若此时放行，等于"状态读不到就允许付钱"。
       */
      expect(
        blockedReasonForWriteAction(null, PAYABLE_AP_STATUSES, '登记付款', '应付'),
      ).not.toBeNull();
      expect(
        blockedReasonForWriteAction(undefined, PAYABLE_AP_STATUSES, '登记付款', '应付'),
      ).not.toBeNull();
    });
  });

  describe('白名单常量本身的完整性', () => {
    it('三个白名单都不含 voided（否则守卫等于不存在）', () => {
      expect(PAYABLE_AP_STATUSES).not.toContain('voided');
      expect(WRITEOFFABLE_AP_STATUSES).not.toContain('voided');
      expect(WRITEOFFABLE_AR_STATUSES).not.toContain('voided');
    });

    it('白名单非空（空白名单会让一切都拒绝，属于配置错误）', () => {
      expect(PAYABLE_AP_STATUSES.length).toBeGreaterThan(0);
      expect(WRITEOFFABLE_AP_STATUSES.length).toBeGreaterThan(0);
      expect(WRITEOFFABLE_AR_STATUSES.length).toBeGreaterThan(0);
    });

    it('应付与应收的可核销状态集合**有意不同**（`paid` vs `settled`）', () => {
      /*
       * 登记一处有意的不对称：本项目应付按"付款"（终态 `paid`），
       * 应收按"核销"（终态 `settled`）。若有人为统一而把两边合并成
       * 一个"通用可付状态"常量，这条断言会红 —— 合并会把一边的语义
       * 塞进另一边（应收没有 `paid` 这个状态，加进去是死键）。
       */
      expect(WRITEOFFABLE_AP_STATUSES).toContain('paid');
      expect(WRITEOFFABLE_AP_STATUSES).not.toContain('settled');
      expect(WRITEOFFABLE_AR_STATUSES).toContain('settled');
      expect(WRITEOFFABLE_AR_STATUSES).not.toContain('paid');
    });

    it('白名单里的每个值都是非空字符串（防手写常量时多打逗号）', () => {
      for (const list of [
        PAYABLE_AP_STATUSES,
        WRITEOFFABLE_AP_STATUSES,
        WRITEOFFABLE_AR_STATUSES,
      ]) {
        for (const v of list) {
          expect(typeof v).toBe('string');
          expect(v.length).toBeGreaterThan(0);
        }
        // 无重复
        expect(new Set(list).size).toBe(list.length);
      }
    });
  });
});
