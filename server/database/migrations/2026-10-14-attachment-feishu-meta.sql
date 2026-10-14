-- 附件飞书元数据：token / 文档类型 / 规范化 URL

ALTER TABLE comp_attachment
  ADD COLUMN IF NOT EXISTS feishu_token varchar(255);

ALTER TABLE comp_attachment
  ADD COLUMN IF NOT EXISTS feishu_doc_type varchar(50);

ALTER TABLE comp_attachment
  ADD COLUMN IF NOT EXISTS feishu_url text;

CREATE INDEX IF NOT EXISTS idx_comp_attachment_feishu_token
  ON comp_attachment (feishu_token)
  WHERE feishu_token IS NOT NULL;
