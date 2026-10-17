-- requires: 2026-10-15-upgrade-batch1z-b05-biz-labels-dict.sql, 2026-10-16-fix02-ar-ap-void-and-indexes.sql
--
-- 补齐状态字典的缺失键（审计 §5.8 / B1 收尾）。
--
-- ## 问题
--
-- B1 给应收/应付加了**作废路径**（`ArService.voidAr` / `ApService.voidAp`），
-- 服务端会把 `status` 写成 `'voided'`（`ar.service.ts:442`、`ap.service.ts`），
-- 契约类型 `ArStatus` / `ApStatus` 也都含 `'voided'`。但 **`sys_dict` 的种子
-- 与 `biz-labels.ts` 的兜底表都没跟上** —— 于是作废单据在列表里显示英文码
-- `voided`，而且 `ArTab.tsx:330` / `ApTab.tsx` 的**状态下拉是按
-- `Object.entries(AR_STATUS_LABELS)` 渲染的**，所以使用者连"筛出已作废"
-- 都做不到（下拉里根本没有那一项）。
--
-- 同一批缺口还有：
--   · `ap_status` 连 `'approved'`（已批准）都没种 —— 契约 `ApStatus` 明确有它，
--     而应付单审批通过后就是 `approved`，同样显示英文码；
--   · `ar_status` / `ap_status` 都缺 `'voided'`；
--   · `asset_disposal_status` 与 `note_status` **完全没有种子** ——
--     它们只靠 `biz-labels.ts` 的硬编码兜底，因此字典编辑页里看不到这两类，
--     B-05「改字典即生效」对它们不成立。
--
-- ## 为什么这是"补数据"而不是"改代码"
--
-- `withDictionaryFallback('ar_status', {...})` 的语义是**字典优先、兜底其次**。
-- 只改 `biz-labels.ts` 的兜底也能让界面显示对，但那样字典仍然是缺的：
-- 管理员在设置页看不到 `voided`，"改字典即生效"依然不成立。
-- 所以种子与兜底**两处都要补**，且键集合必须一致。
--
-- ## 为什么 `ap_status` 的 `approved` 排在 `partial` 之前
--
-- `sort_no` 决定下拉顺序，按业务流转顺序排：待付款 → 已批准 → 部分付款 → 已付清 → 已作废。
--
-- ## 幂等
--
-- 沿用 `b05` 的 `WHERE NOT EXISTS` 写法：已存在的键不覆盖，
-- 因此**不会覆盖管理员已经改过的字典文案**（这是有意的 —— 迁移不应该
-- 把用户在界面上改过的值重置回种子值）。

-- ar_status：补 voided
INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'ar_status', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('voided', '已作废', 40)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'ar_status' AND d.dict_key = v.key
);

-- ap_status：补 approved 与 voided
INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'ap_status', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('approved', '已批准', 15),
  ('voided', '已作废', 50)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'ap_status' AND d.dict_key = v.key
);

-- asset_disposal_status：原先完全没有种子（键集合对齐 AssetDisposalStatus 契约）
INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'asset_disposal_status', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('disposing', '处置中', 10),
  ('disposed', '已处置', 20),
  ('scrapped', '已报废', 30),
  ('rejected', '已驳回', 40)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d
  WHERE d.dict_type = 'asset_disposal_status' AND d.dict_key = v.key
);

-- note_status：原先完全没有种子（键集合对齐 NoteStatus 契约）
INSERT INTO sys_dict (dict_type, dict_key, dict_label, sort_no, builtin)
SELECT 'note_status', v.key, v.label, v.sort_no, 1
FROM (VALUES
  ('received', '已收到', 10),
  ('held', '持有中', 20),
  ('endorsed', '已背书', 30),
  ('discounted', '已贴现', 40),
  ('settled', '已结清', 50),
  ('dishonored', '已拒付', 60)
) AS v(key, label, sort_no)
WHERE NOT EXISTS (
  SELECT 1 FROM sys_dict d WHERE d.dict_type = 'note_status' AND d.dict_key = v.key
);
