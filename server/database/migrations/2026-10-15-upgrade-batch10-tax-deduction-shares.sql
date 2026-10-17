-- N-4 / N-5：专项附加扣除的「独生 / 非独生」「人数」「分摊比例」
-- requires: 0000_baseline.sql
--
-- 背景：上限口径**两端都错**，且两种错法都不会报错、不会不平账 ——
--   1) 赡养老人一律按独生子女 3000 元/月封顶；而非独生子女法定由兄弟姐妹分摊、
--      每人不超过 1500 元/月 → **超额扣除**（少缴个税，稽查可直接发现）；
--   2) 子女教育 / 婴幼儿照护按「每个子女 2000 元/月」设限，但登记表按
--      「员工 × 年度 × 类型」唯一，多子女无法累加 → **少扣除**（员工多缴个税）。
-- 另：父母（夫妻）分摊比例原先无法表达，双方都只能按 100% 登记。
--
-- 存量数据回填口径（保守优先：宁可少扣，不可多扣）：
--   - dependent_count 一律回填 1 —— 不放大任何既有扣除额；
--   - is_only_child 留 NULL（未声明）—— 不猜。再次编辑该条登记时服务层强制要求声明；
--   - share_ratio 回填 1（全额由本人扣除）—— 与迁移前行为完全一致。
--
-- > 财务待办：存量 `elderly_support` 若为非独生子女，当前扣除额已超额；
-- > 存量 `child_education` / `infant_care` 若为多子女，当前扣除额不足。
-- > 两类都需逐条复核后重新登记。迁移末尾会打印待复核条数。

ALTER TABLE hr_employee_tax_deduction
  ADD COLUMN IF NOT EXISTS is_only_child boolean;
ALTER TABLE hr_employee_tax_deduction
  ADD COLUMN IF NOT EXISTS share_amount numeric;
ALTER TABLE hr_employee_tax_deduction
  ADD COLUMN IF NOT EXISTS dependent_count integer NOT NULL DEFAULT 1;
ALTER TABLE hr_employee_tax_deduction
  ADD COLUMN IF NOT EXISTS share_ratio numeric NOT NULL DEFAULT 1;

-- 约束：PostgreSQL 无 ADD CONSTRAINT IF NOT EXISTS，用 pg_constraint 判断保证幂等
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_hr_emp_tax_deduction_rules'
  ) THEN
    ALTER TABLE hr_employee_tax_deduction
      ADD CONSTRAINT chk_hr_emp_tax_deduction_rules CHECK (
        (share_amount IS NULL OR (share_amount >= 0 AND share_amount <= 1500))
        AND dependent_count >= 1 AND dependent_count <= 20
        AND share_ratio > 0 AND share_ratio <= 1
      );
  END IF;
END $$;

COMMENT ON COLUMN hr_employee_tax_deduction.is_only_child IS
  'N-4：赡养老人是否独生子女。NULL=未声明；独生 3000 元/月，非独生分摊不超过 1500 元/月';
COMMENT ON COLUMN hr_employee_tax_deduction.share_amount IS
  'N-4：非独生子女赡养老人本人分摊额（元/月，不超过 1500）';
COMMENT ON COLUMN hr_employee_tax_deduction.dependent_count IS
  'N-5：子女教育 / 婴幼儿照护人数，月度上限 = 法定标准 × 人数';
COMMENT ON COLUMN hr_employee_tax_deduction.share_ratio IS
  '本人扣除比例（0~1，父母各扣 50% 填 0.5）';

-- 自检：存量待复核条目必须被显式打印，不允许静默
DO $$
DECLARE
  elderly_pending integer;
  child_pending integer;
BEGIN
  SELECT count(*) INTO elderly_pending
  FROM hr_employee_tax_deduction
  WHERE deduction_type = 'elderly_support' AND is_only_child IS NULL;

  SELECT count(*) INTO child_pending
  FROM hr_employee_tax_deduction
  WHERE deduction_type IN ('child_education', 'infant_care') AND dependent_count = 1;

  IF elderly_pending > 0 THEN
    RAISE NOTICE 'N-4：存量赡养老人扣除 % 条未声明是否独生，需逐条复核（非独生子女当前可能超额扣除）', elderly_pending;
  END IF;
  IF child_pending > 0 THEN
    RAISE NOTICE 'N-5：存量子女教育 / 婴幼儿照护扣除 % 条按 1 人回填，多子女家庭需改为实际人数并调增扣除额', child_pending;
  END IF;
END $$;
