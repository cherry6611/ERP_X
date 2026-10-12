# 2026-10-12 报价/成本凭证/验收单 API 测试数据留档（已删除）

## 范围

本期功能（报价单全生命周期、报价附件、交付物验收结论）接口自测产生的 `[API_TEST]` 数据，测试完成后已全部删除。

## 测试记录

| 用例 | 请求 | 结果 |
| --- | --- | --- |
| 创建报价（2 明细行 + 整单折扣 5%） | POST /api/crm/quotations | 201，QUO2026100001，totalAmount=14820 / estimatedCost=8000 / marginPct=46.02 计算正确 |
| 提交送审 | POST /api/crm/quotations/:id/submit | 201，status=pending_approval |
| 审批通过 | POST /api/crm/quotations/:id/approve | 201，status=approved |
| 转合同草稿 | POST /api/crm/quotations/:id/convert | 201，合同 CTR2026100002，amount=14820、taxRate=6 |
| 重复转合同 | POST /api/crm/quotations/:id/convert | 400 仅已生效的报价单可转合同 |
| 驳回退回修改 | POST /api/crm/quotations/:id/reject | 201，pending_approval→draft |
| 作废 | POST /api/crm/quotations/:id/void | 201，draft→void |
| 报价附件登记/读取 | POST、GET /api/attachments (crm_quotation) | 201 / 200 正常返回 |
| 交付物验收带结论 | POST /api/projects/deliverables/:id/accept | 201，acceptConclusion 写入并读回 |

## 已清理数据

- `crm_quotation`：QUO2026100001 / QUO2026100002（及对应 `crm_quotation_item` 明细行）
- `erp_contract`：CTR2026100002（[API_TEST] 报价转出的合同草稿）
- `comp_attachment`：[API_TEST] 报价方案.txt（crm_quotation 挂载）
- `erp_deliverable`：DLV2026100001（[API_TEST] 验收单测试交付物，含验收结论）

清理 SQL（+db-execute 已执行）：

```sql
DELETE FROM crm_quotation_item WHERE quotation_id IN (SELECT id FROM crm_quotation WHERE title LIKE '[API_TEST]%');
DELETE FROM crm_quotation WHERE title LIKE '[API_TEST]%';
DELETE FROM erp_contract WHERE name LIKE '[API_TEST]%';
DELETE FROM comp_attachment WHERE file_name LIKE '[API_TEST]%';
DELETE FROM erp_deliverable WHERE name LIKE '[API_TEST]%';
```
