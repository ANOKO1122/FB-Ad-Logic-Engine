-- ============================================
-- 查询「未匹配的 5 个广告」在 structure_ads 与 ad_snapshots 中的状态和数据
-- ============================================

-- （1）结构表：这 5 个广告在 structure_ads 里的名称、状态、最近同步时间
SELECT
  account_id,
  ad_id,
  name AS ad_name,
  effective_status,
  status,
  configured_status,
  last_synced_at
FROM structure_ads
WHERE (account_id, ad_id) IN (
  ('act_1120871463163565', '120241350385510374'),
  ('act_1313346806321636', '120239286193540446'),
  ('act_1313346806321636', '120239286193560446'),
  ('act_1498921711073041', '120240679780870639'),
  ('act_1498921711073041', '120240679780950639')
)
ORDER BY account_id, ad_id;


-- （2）快照表：这 5 个广告在 ad_snapshots 里是否有数据、最近日期与花费（不限 data_date）
SELECT
  account_id,
  ad_id,
  data_date,
  spend,
  status,
  synced_at
FROM ad_snapshots
WHERE (account_id, ad_id) IN (
  ('act_1120871463163565', '120241350385510374'),
  ('act_1313346806321636', '120239286193540446'),
  ('act_1313346806321636', '120239286193560446'),
  ('act_1498921711073041', '120240679780870639'),
  ('act_1498921711073041', '120240679780950639')
)
ORDER BY account_id, ad_id, data_date DESC;


-- （3）今天是否有快照：仅看 data_date = 今天
SELECT
  account_id,
  ad_id,
  data_date,
  spend,
  status,
  synced_at
FROM ad_snapshots
WHERE (account_id, ad_id) IN (
  ('act_1120871463163565', '120241350385510374'),
  ('act_1313346806321636', '120239286193540446'),
  ('act_1313346806321636', '120239286193560446'),
  ('act_1498921711073041', '120240679780870639'),
  ('act_1498921711073041', '120240679780950639')
)
AND data_date = CURDATE()
ORDER BY account_id, ad_id;
