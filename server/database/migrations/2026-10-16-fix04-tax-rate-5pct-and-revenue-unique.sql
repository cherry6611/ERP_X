-- 2026-10-16 审计修复 · 迁移 4
-- requires: 2026-10-14-final-audit.sql（税率 CHECK 已建）、2026-10-15-upgrade-batch8-vat-surcharge-wiring.sql（城建税率约束）
--
-- ============================================================================
-- 目的：修复审计报告 §4.7 (i)（VAT_RATES 缺 5% 征收率、一般纳税人禁用简易计税）
--       与 §4.7 (g)（城建税率 CHECK 只挡 (0,100]，挡不住小数口径误填 0.07）
--       以及 §4.6 T12（erp_project_revenue 无 (project_id, period) 唯一约束）
--
-- ## 一、税率档位补齐 5%（并放开一般纳税人的简易计税）
--
-- `shared/tax.ts` 的 `VAT_RATES` 原为 `[0,1,3,6,9,13]`，**缺 5% 征收率**。
-- 5% 是现行有效档位（一般纳税人简易计税：不动产经营租赁、房地产老项目、
-- 劳务派遣差额计税；小规模：销售/出租不动产）。缺失的后果是双向的：
--   · 前端选不到 5%，只能"就近选 6%" → 价税分离算错；
--   · **库层 CHECK 也按同一份错档位写死 → 合法的 5% 专票根本登记不进来**。
--
-- 同时原 `ALLOWED_RATES.general = [0,6,9,13]` 把一般纳税人的**简易计税**
-- 挡在外面 —— 那是法定选择权，系统不该拦。修法见 `shared/tax.ts`
-- （general 加 5%；small 加 5%）。
--
-- 本迁移把库层 CHECK 与代码口径对齐：**只做放宽**（新增 5%），
-- 不放宽任何其他取值 —— 放宽而不是替换，保证存量数据不会因约束收紧而失败。
--
-- ## 二、城建税率 CHECK 挡不住"小数口径误填"
--
-- 原约束是 `urban_maint_rate > 0 AND urban_maint_rate <= 100`，于是
-- **`0.07`（把 7% 写成小数）会被接受为"0.07%"**，附加税按 0.07% 计提 →
-- 少缴 99%，而账面上看不出来（金额很小，不像错误）。
-- 正确取值只有 {7, 5, 1} 三个法定档位（市区 / 县镇 / 其他）。
--
-- ⚠️ 收紧前必须先探查存量数据：把非法值置 NULL（= 未配置，附加税**拒绝出数**）
-- 而不是猜一个档位 —— 猜错就是少缴。置 NULL 会让底稿显式阻断，逼使用者补录。
--
-- ## 三、收入台账 (project_id, period) 唯一
--
-- `erp_project_revenue` 允许同一项目同一期间插入多行收入，且收入确认有**两个入口**
-- （`revenues.service.ts` 与 `projects.service.ts`）且无跨入口幂等键 →
-- 重复确认收入会同时产生双份应收与双份凭证，而 `reconcileRevenueChain`
-- **查不出**（它只查"有收入无应收/无凭证"）。
--
-- ⚠️ 冲突处理：唯一约束在存量重复数据上会失败。这里先**探测**并按
-- "保留最早一行、其余备注标记"处理是危险的（会改变已入账口径），
-- 因此改为：**仅在无冲突时建立约束**，有冲突则抛出明确异常中断迁移，
-- 由人工核对后重跑。宁可迁移失败让人看见，也不要静默改动金额。
-- ============================================================================

-- ── 一、税率档位放宽到含 5% ──────────────────────────────────────────────────
-- 写法：先 DROP 再 ADD（CHECK 不支持 ALTER），逐步幂等。
DO $$
DECLARE
  target record;
BEGIN
  FOR target IN
    SELECT * FROM (VALUES
      ('erp_contract',       'chk_contract_tax_rate',          'tax_rate',          false),
      ('erp_invoice',        'chk_invoice_tax_rate',           'tax_rate',          false),
      ('erp_contract_item',  'chk_contract_item_tax_rate',     'tax_rate',          false),
      ('crm_quotation',      'chk_quotation_tax_rate',         'tax_rate',          false),
      ('pur_order',          'chk_pur_order_tax_rate',         'tax_rate',          false),
      ('crm_opportunity',    'chk_opp_tax_rate',               'tax_rate',          false),
      ('md_customer',        'chk_customer_default_tax_rate',  'default_tax_rate',  true),
      ('md_supplier',        'chk_supplier_default_tax_rate',  'default_tax_rate',  true)
    ) AS t(table_name, constraint_name, column_name, nullable)
  LOOP
    -- 表不存在就跳过（迁移链按文件名排序，历史迁移可能已改名）
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = target.table_name
    ) THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',
                   target.table_name, target.constraint_name);
    IF target.nullable THEN
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I IS NULL OR %I IN (0, 1, 3, 5, 6, 9, 13))',
        target.table_name, target.constraint_name, target.column_name, target.column_name);
    ELSE
      EXECUTE format(
        'ALTER TABLE %I ADD CONSTRAINT %I CHECK (%I IN (0, 1, 3, 5, 6, 9, 13))',
        target.table_name, target.constraint_name, target.column_name);
    END IF;
  END LOOP;
END $$;

-- 自检：5% 必须能写进 erp_invoice（这是"合法 5% 专票登记不进来"的直接回归锁）
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    WHERE t.relname = 'erp_invoice'
      AND c.conname = 'chk_invoice_tax_rate'
      AND pg_get_constraintdef(c.oid) NOT LIKE '%5%'
  ) THEN
    RAISE EXCEPTION 'chk_invoice_tax_rate 未包含 5%% 档位，合法 5%% 专票仍会被库约束拒绝，已中断';
  END IF;
END $$;

-- ── 二、城建税率收敛为法定档位 {1, 5, 7} ─────────────────────────────────────
-- 先把非法值置 NULL（= 未配置，附加税拒绝出数），再收紧约束。
-- 不猜 7% —— 猜错就是少缴，且账面上看不出来。
UPDATE md_tax_entity
SET urban_maint_rate = NULL
WHERE urban_maint_rate IS NOT NULL
  AND urban_maint_rate NOT IN (1, 5, 7);

DO $$ BEGIN
  ALTER TABLE md_tax_entity DROP CONSTRAINT IF EXISTS chk_tax_entity_urban_maint_rate;
  ALTER TABLE md_tax_entity
    ADD CONSTRAINT chk_tax_entity_urban_maint_rate
    CHECK (urban_maint_rate IS NULL OR urban_maint_rate IN (1, 5, 7));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMENT ON COLUMN md_tax_entity.urban_maint_rate IS
  '城建税率（百分数，法定档位 1=其他 / 5=县镇 / 7=市区）。NULL=未配置，附加税计提拒绝出数。'
  '不接受小数口径（0.07 会被误解为 0.07%，少缴 99%）。';

-- ── 三、收入台账 (project_id, period) 唯一 ───────────────────────────────────
-- 先探测冲突：有重复就中断迁移并列出，交人工核对，绝不静默合并金额。
DO $$
DECLARE
  dup_count int;
  sample text;
BEGIN
  SELECT count(*), string_agg(project_id::text || '@' || period, ', ')
  INTO dup_count, sample
  FROM (
    SELECT project_id, period
    FROM erp_project_revenue
    WHERE project_id IS NOT NULL AND period IS NOT NULL
    GROUP BY project_id, period
    HAVING count(*) > 1
  ) d;

  IF dup_count > 0 THEN
    RAISE EXCEPTION
      '存在 % 组「同项目同期间」的重复收入台账（如 %），无法建立唯一约束。'
      '请先人工核对并冲回多确认的收入（注意：冲回会同时影响应收与凭证口径），'
      '核对完成后再重跑本迁移。本迁移**不会**自动合并或删除任何金额。',
      dup_count, sample;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_project_revenue_project_period
  ON erp_project_revenue (project_id, period)
  WHERE project_id IS NOT NULL AND period IS NOT NULL;

COMMENT ON INDEX uq_erp_project_revenue_project_period IS
  'T12：同一项目同一期间只允许一条收入台账。收入确认有两个入口'
  '（revenues.service / projects.service）且原先无跨入口幂等键，'
  '重复确认会同时产生双份应收与双份凭证，且 reconcileRevenueChain 查不出。';
