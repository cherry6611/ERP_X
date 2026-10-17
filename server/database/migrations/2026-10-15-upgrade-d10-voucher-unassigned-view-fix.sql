-- requires: 0000_baseline.sql（fin_voucher / fin_voucher_line 为基线表）；2026-10-15-upgrade-batch4-voucher-entity-backfill.sql（本迁移修的是它建立的 v_fin_voucher_unassigned_entity 视图）
-- B-1 / REQ-BE-01：修正 v_fin_voucher_unassigned_entity 的凭证张数口径
--
-- 缺陷：原视图（2026-10-15-upgrade-batch4-voucher-entity-backfill.sql:121-131）
--   SELECT v.period, coalesce(v.source_type,'(manual)') AS source_type,
--          count(*)::int AS voucher_count,
--          coalesce(sum(l.debit), 0) AS total_debit
--     FROM fin_voucher v
--     LEFT JOIN fin_voucher_line l ON l.voucher_id = v.id
--    GROUP BY v.period, coalesce(v.source_type,'(manual)')
--
--   JOIN 到分录行后 `count(*)` 统计的是**分录行数**而不是凭证张数：一张凭证有 N 条
--   分录就被算成 N 张。实测两借两贷的凭证会把缺口放大 2~4 倍（借方合计 sum(l.debit)
--   没有该问题，故原口径内部自相矛盾：张数虚高、金额正确）。
--
-- 影响面：B-1 自检接口 GET /api/voucher/unassigned-entity 直接读该视图，
-- "本期有 37 张未归属凭证" 会显示成 "74 张"，运营无法据此判断工作量。
-- 方向上属于高报（不会漏报），但自检数字不可信本身就等于自检失效。
--
-- 修法：count(DISTINCT v.id)。不改列名与列序，故 CREATE OR REPLACE VIEW 可直接覆盖
-- （CREATE OR REPLACE 只允许在不改变输出列清单时使用）。
-- 本文件排在 batch4 之后（文件名排序 d10 > batch4），且用 CREATE OR REPLACE，
-- 重复执行安全。

CREATE OR REPLACE VIEW v_fin_voucher_unassigned_entity AS
SELECT v.period,
       coalesce(v.source_type, '(manual)') AS source_type,
       count(DISTINCT v.id)::int AS voucher_count,
       coalesce(sum(l.debit), 0) AS total_debit
FROM fin_voucher v
LEFT JOIN fin_voucher_line l ON l.voucher_id = v.id
WHERE v.tax_entity_id IS NULL
  AND v.status <> 'voided'
GROUP BY v.period, coalesce(v.source_type, '(manual)')
ORDER BY v.period, source_type;

COMMENT ON VIEW v_fin_voucher_unassigned_entity IS
  'A-01/A-06 自检：按期间 + 来源类型统计未归属纳税主体的凭证数与借方合计。'
  'voucher_count 用 count(DISTINCT v.id)，避免 JOIN 分录行后把分录条数当凭证张数。'
  '这些凭证不会出现在任何主体的报表中，需补主体或确认是否应归属默认主体。';

-- 自检：修正后必须与"直接按凭证计数的口径"完全一致，不一致则迁移直接失败。
DO $$
DECLARE
  view_total integer;
  raw_total integer;
BEGIN
  SELECT coalesce(sum(voucher_count), 0) INTO view_total
    FROM v_fin_voucher_unassigned_entity;
  SELECT count(*) INTO raw_total
    FROM fin_voucher
   WHERE tax_entity_id IS NULL
     AND status <> 'voided';
  IF view_total <> raw_total THEN
    RAISE EXCEPTION 'v_fin_voucher_unassigned_entity 张数口径不一致：视图 % / 实际 %',
      view_total, raw_total;
  END IF;
  RAISE NOTICE 'v_fin_voucher_unassigned_entity 口径校验通过：未归属凭证 % 张', raw_total;
END $$;
