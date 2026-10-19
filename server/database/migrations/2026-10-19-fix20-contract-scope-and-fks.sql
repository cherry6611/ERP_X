-- requires: 2026-10-19-fix19-core-fks-batch2.sql
--
-- 1. 行级权限资源类型增加 contract。不种子化配置行：没有配置时列表行为不变，
--    配了之后合同列表/详情才按纳税主体或负责人收窄。
-- 2. 再补两处 NOT VALID 外键：工时的项目、合同的客户。存量孤儿不删，也不在这里 VALIDATE。

DO $$ BEGIN
  ALTER TABLE sys_data_scope DROP CONSTRAINT IF EXISTS chk_sys_data_scope_resource;
  ALTER TABLE sys_data_scope
    ADD CONSTRAINT chk_sys_data_scope_resource
    CHECK (resource_type IN (
      'project', 'customer', 'finance_ledger', 'employee', 'attendance',
      'voucher', 'ledger', 'report', 'cost', 'revenue', 'contract'
    ));
END $$;

COMMENT ON COLUMN sys_data_scope.resource_type IS
  '资源类型：project / customer / finance_ledger / employee / attendance / '
  'voucher / ledger / report / cost / revenue / contract。'
  'contract 的 custom_ids 为纳税主体 id，self 比较 erp_contract.owner。';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_erp_timesheet_project') THEN
    ALTER TABLE erp_timesheet
      ADD CONSTRAINT fk_erp_timesheet_project
      FOREIGN KEY (project_id) REFERENCES erp_project(id)
      NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_erp_contract_customer') THEN
    ALTER TABLE erp_contract
      ADD CONSTRAINT fk_erp_contract_customer
      FOREIGN KEY (customer_id) REFERENCES md_customer(id)
      NOT VALID;
  END IF;
END $$;
