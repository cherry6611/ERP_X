# 2026-10-12 全系统整改 P0 批次 — 接口自测数据留档

自测日期：2026-10-12。本轮自测数据均带 `[API_TEST]` 标记，无法物理删除的（有业务状态约束）留库说明如下。

## 留库数据（不可删除 / 留库合理）

| 数据 | 标识 | 状态 | 说明 |
| ---- | ---- | ---- | ---- |
| 测试工时 | TS2026100001（id 2f7e64eb-5a3a-4943-add4-2df5f82271d1） | submitted | 角色「[API_TEST]无费率角色」费率缺失卡点验证用，事务回滚后保持 submitted、未生成成本；留库用于后续复核费率校验行为 |
| 测试发票 | INV2026100002（id cad6db1a-32f7-488f-b2d5-28b8e44b1f08） | voided | 发票作废链路验证用（真实合同 74b77f86-8177-41ee-aedf-4c9f09bda242 开 1 元后作废，可开金额已释放，不影响真实台账） |

## 已验证结论

- 鉴权：anon 打 GET /api/finance/summary、/api/bi/overview 均 401；auth 200
- 多维汇总：dimension-summary 四维度 200，department 维度未分配 48000（存量无部门归属）
- 费率缺失卡点：confirm 无费率工时 → 400「角色「[API_TEST]无费率角色」未配置生效费率」，工时状态回滚不变、无脏成本
- 发票作废：void issued → 201 voided；重复 void → 400「仅已开票状态的发票可作废」
- 核销并发安全：ar/ap writeoff 改为事务内 FOR UPDATE 锁行校验（回归由既有核销链路保障，未做真实并发压测）
- 结项飞书通知：代码已接入 close 流程，发送链路复用已冒烟验证的 send_erp_approval_notification_1；未真实触发（避免向真实 admin 发送测试消息）
