-- requires: 2026-10-19-fix17-tax-entity-on-asset-expense.sql
-- 发票登记的客户端幂等键。同一张表单重试（响应丢失、连点）命中已有发票，不再插第二张。
ALTER TABLE erp_invoice ADD COLUMN IF NOT EXISTS client_request_id varchar(64);
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_invoice_client_request
  ON erp_invoice (client_request_id)
  WHERE client_request_id IS NOT NULL;
