import {
  UNIQUE_CONSTRAINT_MESSAGES,
  conflictMessage,
  constraintNameOf,
} from './pg-error-messages';

/**
 * 这组规格的**核心主张**：唯一约束冲突的文案必须说清"撞的是哪条业务规则、
 * 下一步做什么"，而不是一律「记录已存在，请勿重复提交」。
 *
 * 背景实测（`pg_indexes` 普查）：非 pkey、非纯 code 的唯一索引共 **40 个**，
 * 其中绝大多数是业务规则而非重复提交。本仓 `costs.service.ts:530` 已为这个
 * 措辞吃过一次亏并留了注释。
 */
describe('conflictMessage：唯一约束冲突的可执行文案', () => {
  it('⚠️ 一个合同只能立一个项目 —— 不能再说"请勿重复提交"', () => {
    const msg = conflictMessage({
      code: '23505',
      constraint: 'uq_erp_project_one_contract',
    });
    expect(msg).toBeTruthy();
    // 必须点明规则本身
    expect(msg).toContain('一个合同只能立一个项目');
    // 且必须给出下一步（只报错不给出路 = 使用者卡住）
    expect(msg).toMatch(/请|或|先/);
    // 不能复用那句误导的通用文案
    expect(msg).not.toContain('请勿重复提交');
  });

  it('沿 cause 链取约束名（drizzle 把原始 PG 错误包在 cause 里）', () => {
    const wrapped = {
      message: 'Failed query: insert into ...',
      cause: { code: '23505', constraint: 'uq_crm_opp_contract' },
    };
    expect(constraintNameOf(wrapped)).toBe('uq_crm_opp_contract');
    expect(conflictMessage(wrapped)).toContain('一个合同只能由一个商机转化');
  });

  it('⚠️ 认 postgres.js 的 `constraint_name`（它的字段名不是 `constraint`）', () => {
    /*
     * 实测 `Object.keys(err)` = name, severity_local, severity, code, detail,
     * schema_name, table_name, **constraint_name**, file, line, routine ——
     * 里面没有 `constraint`。只认 `constraint` 会让整张映射表永远不生效，
     * 且是**静默**回落（接口照样 409，只是文案退回通用那句），
     * 本会话就是这样先写错、再靠"改完文案没变"才发现的。
     */
    const pgStyle = {
      code: '23505',
      table_name: 'erp_project',
      constraint_name: 'uq_erp_project_one_contract',
    };
    expect(constraintNameOf(pgStyle)).toBe('uq_erp_project_one_contract');
    expect(conflictMessage(pgStyle)).toContain('一个合同只能立一个项目');
  });

  it('constraint_name 出现在 cause 链里也能取到', () => {
    const nested = {
      message: 'Failed query',
      cause: { code: '23505', constraint_name: 'uq_erp_note_no' },
    };
    expect(constraintNameOf(nested)).toBe('uq_erp_note_no');
  });

  it('约束名在更深的 cause 链（最多 5 层）也能找到', () => {
    const deep = { cause: { cause: { cause: { constraint: 'uq_erp_note_no' } } } };
    expect(constraintNameOf(deep)).toBe('uq_erp_note_no');
  });

  it('拿不到约束名 → 返回 null（调用方回落通用文案，不猜）', () => {
    expect(conflictMessage({ code: '23505' })).toBeNull();
    expect(conflictMessage(null)).toBeNull();
    expect(conflictMessage('boom')).toBeNull();
    expect(constraintNameOf({ constraint: '' })).toBeNull();
  });

  it('未登记的约束 → null（宁可笼统，不要瞎编）', () => {
    expect(conflictMessage({ constraint: 'uq_some_future_index' })).toBeNull();
  });

  it('每条文案都必须是中文且给出下一步（批量断言，防止新增时写半句）', () => {
    const entries = Object.entries(UNIQUE_CONSTRAINT_MESSAGES);
    expect(entries.length).toBeGreaterThan(30); // 覆盖面
    for (const [name, msg] of entries) {
      expect(msg.length).toBeGreaterThan(8);
      // 不能是英文/占位
      expect(msg).toMatch(/[\u4e00-\u9fa5]/u);
      // 通用文案不得出现在任何具体映射里（它就是被替代的对象）
      expect(msg).not.toBe('记录已存在，请勿重复提交');
      // 约束名不泄漏进面向使用者的文案
      expect(msg).not.toContain(name);
    }
  });

  it('覆盖本轮实测到的几个高频业务规则（回归锚点）', () => {
    const expectHit = (constraint: string, keyword: string) => {
      const msg = conflictMessage({ constraint });
      expect(msg).toBeTruthy();
      expect(msg).toContain(keyword);
    };
    expectHit('uq_erp_project_revenue_project_period', '只能确认一次');
    expectHit('uq_erp_timesheet_employee_project_date', '只能填报一次');
    expectHit('uq_fin_year_end_close_year', '已完成年结');
    expectHit('uq_fin_vat_declaration_period_entity', '已存在');
    expectHit('uq_erp_invoice_no_date_issued', '发票号码');
    expectHit('uq_ast_disposal_active', '处置单');
  });
});
