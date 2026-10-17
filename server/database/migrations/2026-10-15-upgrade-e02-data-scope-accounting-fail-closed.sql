-- S2 收口：会计资料行级权限由「未配置即全量可见」改为**默认 fail-closed**，
-- 本迁移把当前**事实上存在**的访问权显式登记下来，使行为可审计、可撤销。
-- requires: 2026-10-15-upgrade-data-scope.sql（sys_data_scope 表）
-- requires: 2026-10-15-upgrade-e01-data-scope-finance-resources.sql（resource_type 约束含 voucher/ledger/report）
--
-- 文件名用 e02（字典序排在 e01 之后）：迁移链按文件名排序执行，
-- e01 必须先建好 CHECK 约束的取值范围，否则本迁移插入 voucher/ledger/report 会被约束拒绝。
--
-- ============================ 背景 ============================
--
-- `DataScopeService.resolveScope()` 原语义：资源类型在 sys_data_scope 中
-- **一行配置都没有**时返回 `scope:'all'`（不收紧）。而 voucher / ledger / report
-- 这三类会计资料**从未被种子化**（e01 迁移在 26-29 行明确说明"保持无配置行 = 不收紧"），
-- 于是"默认全量可见"成了永久状态：
--   · 多主体部署下，任何持有 finance 读能力的角色都能看到**全部主体**的
--     凭证、账簿、法定报表（含子公司看母公司），且账面/日志上完全看不出这是越权；
--   · 排障时看到"凭证列表有数据"不会意识到那其实是 fail-open 而不是配置生效。
--
-- 现已把该资源类的默认改为 fail-closed（未登记配置行 → 空集 / 403），
-- 因此必须同时把"本来就应该有这个权限"的角色显式登记，否则升级即等于
-- 把财务只读的凭证/账簿/报表入口全部关掉（属于功能回归，不是安全收紧）。
--
-- 依据：`shared/rbac.ts` 的 MATRIX 中 `finance_viewer` 对
--   finance / voucher(经 finance) / tax_entity 均为 `r`（只读），
-- 且历史上其可见范围就是全量（升级前 `resolveScope` 返回 all）。
-- 本迁移把这一既有事实固化为一行显式配置（scope='all'，单主体口径）。
--
-- ⚠️ 多主体部署必须改为 custom 并逐主体授权（与 e01 的指引一致），例如：
--   UPDATE sys_data_scope SET scope='custom',
--          custom_ids='["<子公司纳税主体uuid>", "<另一个uuid>"]'
--    WHERE role_code='finance_viewer' AND resource_type='voucher';
--   -- ledger / report 同理
-- ============================ 种子 ============================

INSERT INTO sys_data_scope (role_code, resource_type, scope, custom_ids, enabled, remark)
SELECT v.role_code, v.resource_type, 'all', '[]', 1, v.remark
FROM (VALUES
  ('finance_viewer', 'voucher',
   'S2 收口：会计资料默认 fail-closed，此处显式固化 finance_viewer 对凭证的既有全量可见（多主体部署须改为 custom）'),
  ('finance_viewer', 'ledger',
   'S2 收口：会计资料默认 fail-closed，此处显式固化 finance_viewer 对账簿的既有全量可见（多主体部署须改为 custom）'),
  ('finance_viewer', 'report',
   'S2 收口：会计资料默认 fail-closed，此处显式固化 finance_viewer 对法定报表的既有全量可见（多主体部署须改为 custom）')
) AS v(role_code, resource_type, remark)
WHERE EXISTS (SELECT 1 FROM sys_role r WHERE r.code = v.role_code)
  AND NOT EXISTS (
    SELECT 1 FROM sys_data_scope d
     WHERE d.role_code = v.role_code
       AND d.resource_type = v.resource_type
  );

-- 自检：角色存在时，三条配置行必须都已登记，否则本迁移等于静默失败
-- （后果是 finance_viewer 的凭证/账簿/报表入口被 fail-closed 全部关掉）。
DO $$
DECLARE
  role_present boolean;
  missing text[] := ARRAY[]::text[];
  candidate text;
BEGIN
  SELECT EXISTS (SELECT 1 FROM sys_role WHERE code = 'finance_viewer') INTO role_present;
  IF NOT role_present THEN
    RAISE NOTICE '角色 finance_viewer 不存在，跳过自检（本迁移未插入任何行）';
    RETURN;
  END IF;
  FOREACH candidate IN ARRAY ARRAY['voucher', 'ledger', 'report'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM sys_data_scope
       WHERE role_code = 'finance_viewer'
         AND resource_type = candidate
         AND enabled = 1
    ) THEN
      missing := missing || candidate;
    END IF;
  END LOOP;
  IF array_length(missing, 1) > 0 THEN
    RAISE EXCEPTION 'finance_viewer 的会计资料数据权限缺失：%', array_to_string(missing, ', ');
  END IF;
  RAISE NOTICE '会计资料数据权限已显式化：finance_viewer × voucher/ledger/report = all';
END $$;
