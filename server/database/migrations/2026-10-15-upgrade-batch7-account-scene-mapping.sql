-- P2-11：业务场景 → 会计科目（显式映射）
--
-- 背景：工资计提等分录写死科目（`hr-pay.service.ts` 固定 6401 主营业务成本），
-- 业务想把人工成本按场景归集到别的科目只能改代码；而 6401 是一级**末级**科目
-- （见 2026-10-15-upgrade-batch1-chart-of-accounts.sql），不是汇总科目，
-- 所以 batch6 的 `default_leaf_code` 下钻机制覆盖不到它，必须靠场景映射。
--
-- 语义：**未配置即回落调用方的默认科目**，因此本迁移不改动任何存量行为。
-- 取值校验（存在性 / 启用 / 末级）由 `AccountResolverService` 运行时完成，
-- 配错时回落并告警，不阻断做账。

CREATE TABLE IF NOT EXISTS fin_account_mapping (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scene varchar(50) NOT NULL UNIQUE,
  account_code varchar(20) NOT NULL,
  remark text,
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _created_by uuid DEFAULT CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL
    ELSE current_setting('app.user_id'::text, true)::uuid
  END,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_by uuid DEFAULT CASE
    WHEN (current_setting('app.user_id'::text, true) = ''::text) THEN NULL
    ELSE current_setting('app.user_id'::text, true)::uuid
  END
);

COMMENT ON TABLE fin_account_mapping IS
  '业务场景 → 会计科目映射；未配置时回落到代码内默认科目（P2-11）';
COMMENT ON COLUMN fin_account_mapping.scene IS
  '业务场景键，如 payroll_accrual（工资计提）';
COMMENT ON COLUMN fin_account_mapping.account_code IS
  '目标科目编码；可为汇总科目，由 AccountResolverService 下钻到末级';
