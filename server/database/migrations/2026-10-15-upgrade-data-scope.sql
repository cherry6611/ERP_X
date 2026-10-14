-- 批次一 / B-02：数据级权限（行级可见范围）
-- requires: 2026-10-15-upgrade-batch1-auth-hardening.sql（sys_user / sys_role_member）
-- requires: 2026-10-15-upgrade-batch1-system-config.sql（sys_param，本次不依赖其表，仅保证 sys_ 前缀约定一致）
-- requires: 2026-10-15-upgrade-batch1-accounting-base.sql（fin_voucher / erp_ar / erp_ap_bill / erp_invoice）
--
-- 背景（需求书 §2.2 B-02）：
--   功能权限（B-01）之外还需要"数据权限"：项目可见范围、客户可见范围、
--   财务台账按主体/部门隔离、员工档案按部门隔离。核心约束是
--   **必须在 SQL 层注入过滤条件，不能只在 UI 隐藏**。
--
-- 设计：
--   sys_data_scope = 角色 × 资源类型 × 范围。
--   scope 语义（与 server/common/auth/data-scope.service.ts 的 DataScopeType 一致）：
--     all           全部（不注入条件）
--     dept          仅本部门
--     dept_and_child 本部门及下级部门
--     self          仅本人（比较列取"责任人/所属用户"列）
--     custom        自定义（custom_ids 显式列出允许的 id）
--   custom_ids 用 text 存 JSON 数组字符串（与 fin_account.aux_required 同一约定），
--   避免 jsonb 在 pglite 与本仓既有工具链上的额外差异。
--
-- 未命中任何配置时的行为由代码决定（见 data-scope.service.ts 的 DEFAULT_SCOPE），
-- 不在数据库层兜底，保证"未配置"与"配置为 all"可区分。

CREATE TABLE IF NOT EXISTS sys_data_scope (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 角色码，取值见 shared/rbac.ts 的 ROLE_CODES
  role_code varchar(64) NOT NULL,
  -- 资源类型：project / customer / finance_ledger / employee / attendance
  resource_type varchar(40) NOT NULL,
  -- all / dept / dept_and_child / self / custom
  scope varchar(20) NOT NULL DEFAULT 'all',
  -- custom 范围下的显式 id 列表（JSON 数组字符串；非 custom 范围忽略）
  custom_ids text NOT NULL DEFAULT '[]',
  enabled integer NOT NULL DEFAULT 1,
  remark varchar(200),
  _created_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  _updated_at timestamptz(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sys_data_scope_role_resource
  ON sys_data_scope (role_code, resource_type);

CREATE INDEX IF NOT EXISTS idx_sys_data_scope_resource
  ON sys_data_scope (resource_type, enabled);

DO $$ BEGIN
  ALTER TABLE sys_data_scope
    ADD CONSTRAINT chk_sys_data_scope_scope
    CHECK (scope IN ('all', 'dept', 'dept_and_child', 'self', 'custom'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE sys_data_scope
    ADD CONSTRAINT chk_sys_data_scope_resource
    CHECK (resource_type IN ('project', 'customer', 'finance_ledger', 'employee', 'attendance'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ============================================================
-- 种子数据
-- ============================================================
--
-- 口径说明（**需业务确认**）：
--   1) 只种子化"按需求书验收标准必须立刻生效"的两条 HR 规则；
--   2) finance_viewer × finance_ledger 种为 all —— 与当前行为一致（单主体场景）。
--      多主体/多部门部署必须改为 custom 并显式列出被授权的纳税主体 id，
--      否则 finance_viewer 仍可看到全部主体的台账。改法：
--        UPDATE sys_data_scope SET scope='custom', custom_ids='["<税主体uuid>", ...]'
--        WHERE role_code='finance_viewer' AND resource_type='finance_ledger';
--   3) project 资源刻意**不种子化**，让 ProjectAclService 的既有可见性规则继续生效
--      （需求书 B-02 要求"复用既有 ProjectAclService"）；需要收紧时再插入配置行。
--   4) customer 同理不种子化（当前无"销售负责人"字段，配置化会让 CRM 客户列表
--      在未配置时收窄，属行为变更，需业务确认后再启用）。

INSERT INTO sys_data_scope (role_code, resource_type, scope, custom_ids, enabled, remark)
SELECT v.role_code, v.resource_type, v.scope, '[]', 1, v.remark
FROM (VALUES
  ('hr_manager', 'employee', 'dept_and_child',
   'B-02 种子：人事经理仅可见本人所属部门及下级部门的员工档案（需求书验收标准①）'),
  ('hr_manager', 'attendance', 'dept_and_child',
   'B-02 种子：人事经理仅可见本人所属部门及下级部门的考勤记录（需求书验收标准①）'),
  ('finance_viewer', 'finance_ledger', 'all',
   'B-02 种子：财务只读默认全量（单主体）。多主体部署须改为 custom 并指定被授权主体（需求书验收标准②）')
) AS v(role_code, resource_type, scope, remark)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_data_scope d
  WHERE d.role_code = v.role_code AND d.resource_type = v.resource_type
);
