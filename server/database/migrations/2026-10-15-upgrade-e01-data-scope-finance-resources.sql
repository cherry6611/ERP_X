-- B-2 / REQ-BE-02：把行级数据权限的资源类型补齐到会计资料
-- requires: 2026-10-15-upgrade-data-scope.sql（sys_data_scope / chk_sys_data_scope_resource）
--
-- 文件名用 e01 而不是 d11：迁移链按**文件名字典序**执行，
-- `upgrade-data-scope.sql` 的 'da' > 'd1'，d 开头的编号会排在它前面（pglite dryrun 实测报
-- relation "sys_data_scope" does not exist），故必须用 e 前缀排在其后。
--
-- 背景（需求书 §2.2 B-2）：
--   原 CHECK 只允许 project / customer / finance_ledger / employee / attendance。
--   凭证、账簿、报表、成本、收入五类会计资料**无法配置行级权限**，
--   而这些恰恰是"按纳税主体隔离"最需要覆盖的对象：多主体部署下，
--   子公司的财务人员能看到母公司全部凭证与报表。
--
-- 本次新增 5 个资源类型：
--   voucher  凭证（口径：fin_voucher.tax_entity_id）
--   ledger   账簿（科目余额表/总账/明细账/辅助余额表，口径同上；`finance_ledger` 保留给对账单）
--   report   报表（资产负债表/利润表/现金流量表/打印包，口径同上）
--   cost     项目成本（口径：erp_project_cost.project_id → 沿用项目可见范围）
--   revenue  项目收入（口径：erp_project_revenue.project_id → 沿用项目可见范围）
--
-- 语义约束（**重要，代码侧同样强制**）：
--   voucher / ledger / report 只支持 scope = all 或 custom（custom_ids 为**纳税主体 id**）。
--   self / dept / dept_and_child 对"会计资料"没有业务含义（凭证没有责任人/部门列），
--   配置成这些值时运行时按 fail-closed 处理（返回空集 + warn），而不是猜一个列去过滤。
--
-- 为什么**不**种子化配置行：一旦某资源类型存在 enabled 配置行，
-- `DataScopeService.resolveScope()` 就会对"未配置该资源的角色"转为 fail-closed
-- （见 data-scope.service.ts:318-352）。在业务方确认各角色的可见主体之前，
-- 新增的这 5 类资源保持"无配置行"= 不收紧，行为与升级前完全一致。
-- 收紧方法（业务确认后执行）：
--   INSERT INTO sys_data_scope (role_code, resource_type, scope, custom_ids, remark)
--   VALUES ('finance_viewer', 'voucher', 'custom', '["<税主体uuid>"]', '仅可见子公司凭证')
--   ON CONFLICT (role_code, resource_type) DO UPDATE SET scope = excluded.scope,
--     custom_ids = excluded.custom_ids, enabled = 1;

DO $$ BEGIN
  ALTER TABLE sys_data_scope DROP CONSTRAINT IF EXISTS chk_sys_data_scope_resource;
  ALTER TABLE sys_data_scope
    ADD CONSTRAINT chk_sys_data_scope_resource
    CHECK (resource_type IN (
      'project', 'customer', 'finance_ledger', 'employee', 'attendance',
      'voucher', 'ledger', 'report', 'cost', 'revenue'
    ));
END $$;

COMMENT ON COLUMN sys_data_scope.resource_type IS
  '资源类型：project / customer / finance_ledger（对账单）/ employee / attendance / '
  'voucher（凭证）/ ledger（账簿）/ report（报表）/ cost（项目成本）/ revenue（项目收入）。'
  'voucher/ledger/report 的 custom_ids 为纳税主体 id，且仅支持 all|custom。';

-- 自检：约束必须真的包含新资源类型，否则本迁移等于没生效（静默失败）。
DO $$
DECLARE
  def text;
  missing text[] := ARRAY[]::text[];
  candidate text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'sys_data_scope'
     AND c.conname = 'chk_sys_data_scope_resource';
  IF def IS NULL THEN
    RAISE EXCEPTION 'chk_sys_data_scope_resource 约束不存在，迁移未生效';
  END IF;
  FOREACH candidate IN ARRAY ARRAY['voucher', 'ledger', 'report', 'cost', 'revenue'] LOOP
    IF position('''' || candidate || '''' IN def) = 0 THEN
      missing := missing || candidate;
    END IF;
  END LOOP;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION '资源类型约束缺少：%', array_to_string(missing, ', ');
  END IF;
  RAISE NOTICE 'sys_data_scope 资源类型已扩展到 voucher/ledger/report/cost/revenue';
END $$;
