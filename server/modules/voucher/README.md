# 总账凭证模块（`server/modules/voucher/`）

覆盖需求书 **A-10（科目表与末级校验）/ A-11（凭证来源单据关联与分录备注）** 以及凭证的生成、过账、期间管理。

## 职责

| 文件 | 职责 |
|---|---|
| `voucher.service.ts` | 科目读写、凭证增删改查、过账/作废、期间结账与反结账、来源单据解析、分录备注编辑 |
| `voucher-hook.service.ts` | **事件驱动凭证草稿生成**：业务模块调用 `generateVoucherDraft` 落凭证，失败写 `comp_voucher_job` 供重试 |
| `account-resolver.service.ts` | 把分录模板里的**语义编码**（`1002`/`6602`）下钻到**末级科目**（`100201`/`660201`） |
| `voucher-retry.automation.ts` | `voucher_job_retry`（每 10 分钟）重试失败队列 |

## 涉及表

- `fin_account`：科目（多级，`parent_code`/`level`/`is_leaf`/`direction`/`aux_required`）
- `fin_voucher` / `fin_voucher_line`：凭证与分录（`account_code` 为账簿取数冗余列）
- `fin_period_close` / `fin_period_close_audit`：期间结账与留痕
- `comp_voucher_job`：凭证生成失败队列（`uq_comp_voucher_job_source` 保证同源单据只入队一次）
- `comp_biz_code_seq`：编号流水（原子递增）

## 对外接口

| 方法 | 路径 | 权限 |
|---|---|---|
| GET | `/api/voucher/accounts` | `finance`（读） |
| POST | `/api/voucher/accounts` | `finance_write` |
| GET | `/api/voucher/vouchers` | `finance` |
| POST | `/api/voucher/vouchers` | `finance_write` |
| POST | `/api/voucher/vouchers/:id/actions/:action`（`post` / `void`） | `finance_write` |
| GET | `/api/voucher/vouchers/:id/source` | `finance` |
| PATCH | `/api/voucher/vouchers/:voucherId/lines/:lineId` | `finance_write`（仅草稿） |
| GET | `/api/voucher/periods` | `finance` |
| POST | `/api/voucher/periods/:period/close`、`.../unclose` | `finance_write` |

## 状态机

- 凭证：`draft → posted`；任一状态 → `voided`（作废后账务取数一律排除）。
- 分录摘要：**仅 `draft` 可改**；已过账凭证改摘要必须走"作废 + 重开"（账证相符要求）。
- 期间：`fin_period_close` 存在的期间只读；反结账需不存在更晚的已结账期间。

## 关键约束与易踩的坑

1. **只能对末级科目做账**：`fin_account.is_leaf = 0` 会被拒（400）。
   分录模板写一级编码没问题 —— `AccountResolverService` 会自动下钻。
   ⚠️ 但 `1002 银行存款` 与 `1001 库存现金` 是**两个不同科目**，
   银行类业务模板必须用 `ACCOUNT_BANK_PRIMARY`（`100201`）而不是 `1001`。
2. **借贷必须平衡**：`Math.round(debit*100) !== Math.round(credit*100)` 即拒绝；
   金额按分四舍五入，不用浮点直接比较。
3. **幂等**：`uq_fin_voucher_source (source_type, source_ref)` 唯一索引兜底，
   同一业务单据不会重复出凭证。`sourceRef` 命名规范：`<业务类型>:<业务编码>`（见 `posting.ts`）。
4. **辅助核算必填校验**：科目 `aux_required` 里声明的维度，凭证行必须提供，
   否则 400（A-05）。
5. **分录顺序稳定性**：`getVoucherLines` 按 `(_created_at, debit DESC, account_code, id)` 排序。
   同一事务写入的多行 `_created_at` 相同，若只按随机 uuid 排序会导致**同一张凭证刷新两次顺序不同**。

## 测试入口

```bash
npx jest --config jest.config.cjs server/modules/voucher server/common/tax
```

- `server/common/tax/posting.spec.ts`：分录模板借贷平衡与科目编码正确性。
- `server/test/integration/accounting-chain.spec.ts`：用 pglite 构造**真实 `VoucherService`**，
  覆盖 建科目 → 建凭证 → 过账 → 试算平衡 → 结账 → 余额恒等 → 作废回退，
  以及"借贷不平被拒"。
