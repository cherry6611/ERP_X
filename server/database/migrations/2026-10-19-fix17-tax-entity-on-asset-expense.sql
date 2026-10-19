-- requires: 2026-10-18-fix16-audit-created-at-index.sql
-- R2：资产、费用申请、报销增加我方纳税主体。列可空，多主体必填在服务层。
ALTER TABLE ast_asset ADD COLUMN IF NOT EXISTS tax_entity_id uuid;
ALTER TABLE fin_expense_apply ADD COLUMN IF NOT EXISTS tax_entity_id uuid;
ALTER TABLE fin_expense_claim ADD COLUMN IF NOT EXISTS tax_entity_id uuid;
CREATE INDEX IF NOT EXISTS idx_ast_asset_tax_entity ON ast_asset (tax_entity_id);
CREATE INDEX IF NOT EXISTS idx_fin_expense_apply_tax_entity ON fin_expense_apply (tax_entity_id);
CREATE INDEX IF NOT EXISTS idx_fin_expense_claim_tax_entity ON fin_expense_claim (tax_entity_id);
