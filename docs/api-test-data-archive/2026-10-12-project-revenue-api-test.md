
# 追加（同日）：详情页写入口补验数据
- 附件：POST /api/attachments (erp_project, feishu_doc, "[需求书] [API_TEST] 项目需求说明书") → 201；GET 读回 200；DELETE 后已清理
- 成本：POST /api/costs (outsource, 50, [API_TEST]) → 201 CST2026100002（自动归集期间 2026-10/合同）；已通过 +db-execute 删除
