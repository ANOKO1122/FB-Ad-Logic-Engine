-- ============================================================
-- 规则能否看到其下的广告组、广告及各广告数据（无变量版）
-- 规则 id=400，账户 act_1155891202142879；改规则/账户时直接改 SQL 里的 400 和 act_1155891202142879
-- ============================================================

-- 1. 规则的目标配置
SELECT
  id,
  rule_name,
  account_id,
  target_level,
  target_ids,
  target_by_account
FROM rules
WHERE id = 400;

-- 2. 该规则当前账户下的目标 ID 列表（系列/广告组/广告 ID）
SELECT
  id,
  rule_name,
  target_level,
  JSON_UNQUOTE(JSON_EXTRACT(target_by_account, '$.act_1155891202142879')) AS target_ids_for_account
FROM rules
WHERE id = 400;

-- 3. 规则能看到的广告列表（从 target 自动解析，MySQL 8 需 JSON_TABLE）
SELECT
  a.ad_id,
  a.adset_id,
  a.campaign_id,
  a.name AS ad_name,
  a.effective_status
FROM structure_ads a
WHERE a.account_id = 'act_1155891202142879'
  AND a.campaign_id IN (
    SELECT TRIM(BOTH '"' FROM JSON_UNQUOTE(jt.cid))
    FROM rules r,
    JSON_TABLE(
      COALESCE(JSON_EXTRACT(r.target_by_account, '$.act_1155891202142879'), r.target_ids),
      '$[*]' COLUMNS (cid VARCHAR(80) PATH '$')
    ) jt
    WHERE r.id = 400
  )
ORDER BY a.campaign_id, a.adset_id, a.ad_id;

-- 4. 该系列下的广告组列表
SELECT
  s.adset_id,
  s.campaign_id,
  s.name AS adset_name,
  s.effective_status,
  s.account_id
FROM structure_adsets s
WHERE s.account_id = 'act_1155891202142879'
  AND s.campaign_id IN (
    SELECT TRIM(BOTH '"' FROM JSON_UNQUOTE(jt.cid))
    FROM rules r,
    JSON_TABLE(
      COALESCE(JSON_EXTRACT(r.target_by_account, '$.act_1155891202142879'), r.target_ids),
      '$[*]' COLUMNS (cid VARCHAR(80) PATH '$')
    ) jt
    WHERE r.id = 400
  )
ORDER BY s.campaign_id, s.adset_id;

-- 5. 各广告的最近一条数据（今日快照，与规则评估一致）
SELECT
  t.account_id,
  t.ad_id,
  t.ad_name,
  t.ad_set_id,
  t.campaign_id,
  t.status,
  t.spend,
  t.purchases,
  t.link_clicks,
  t.unique_link_clicks,
  t.purchase_value,
  t.cpc,
  t.roas,
  t.cpa,
  t.add_to_cart_count,
  t.initiate_checkout_count,
  t.add_payment_info_count,
  t.synced_at
FROM (
  SELECT
    account_id,
    ad_id,
    ad_name,
    ad_set_id,
    campaign_id,
    status,
    spend,
    purchases,
    link_clicks,
    unique_link_clicks,
    purchase_value,
    cpc,
    roas,
    cpa,
    add_to_cart_count,
    initiate_checkout_count,
    add_payment_info_count,
    synced_at,
    ROW_NUMBER() OVER (
      PARTITION BY account_id, ad_id
      ORDER BY synced_at DESC, id DESC
    ) AS rn
  FROM ad_snapshots
  WHERE account_id = 'act_1155891202142879'
    AND data_date = CURDATE()
    AND campaign_id IN (
      SELECT TRIM(BOTH '"' FROM JSON_UNQUOTE(jt.cid))
      FROM rules r,
      JSON_TABLE(
        COALESCE(JSON_EXTRACT(r.target_by_account, '$.act_1155891202142879'), r.target_ids),
        '$[*]' COLUMNS (cid VARCHAR(80) PATH '$')
      ) jt
      WHERE r.id = 400
    )
) t
WHERE t.rn = 1
ORDER BY t.ad_id;

-- 6. 汇总：规则能看到的广告数
SELECT COUNT(DISTINCT a.ad_id) AS rule_visible_ads_count
FROM structure_ads a
WHERE a.account_id = 'act_1155891202142879'
  AND a.campaign_id IN (
    SELECT TRIM(BOTH '"' FROM JSON_UNQUOTE(jt.cid))
    FROM rules r,
    JSON_TABLE(
      COALESCE(JSON_EXTRACT(r.target_by_account, '$.act_1155891202142879'), r.target_ids),
      '$[*]' COLUMNS (cid VARCHAR(80) PATH '$')
    ) jt
    WHERE r.id = 400
  );

-- 7. 今日有快照的广告数
SELECT COUNT(DISTINCT ad_id) AS ads_with_snapshot_today
FROM ad_snapshots
WHERE account_id = 'act_1155891202142879'
  AND data_date = CURDATE()
  AND campaign_id IN (
    SELECT TRIM(BOTH '"' FROM JSON_UNQUOTE(jt.cid))
    FROM rules r,
    JSON_TABLE(
      COALESCE(JSON_EXTRACT(r.target_by_account, '$.act_1155891202142879'), r.target_ids),
      '$[*]' COLUMNS (cid VARCHAR(80) PATH '$')
    ) jt
    WHERE r.id = 400
  );
