-- ============================================================
-- 规则能否看到其下的广告组、广告及各广告数据 — 核对用 SQL
-- 规则 id=400（0226测试），账户 act_1155891202142879，目标层级为「广告系列」
-- ============================================================

-- 使用前请确认：下面两个变量与你的规则一致
SET @rule_id = 400;
SET @account_id = 'act_1155891202142879';

-- ------------------------------------------------------------
-- 0. 【一键】从规则自动解析目标系列 ID，列出该系列下的广告（MySQL 8 需支持 JSON_TABLE）
-- 若报错则跳过，用下面 2a 查 target_ids_for_account 后手动设 @campaign_ids 再跑 3～5
-- ------------------------------------------------------------
SELECT
  a.ad_id,
  a.adset_id,
  a.campaign_id,
  a.name AS ad_name,
  a.effective_status
FROM structure_ads a
WHERE a.account_id = @account_id
  AND a.campaign_id IN (
    SELECT TRIM(BOTH '"' FROM JSON_UNQUOTE(jt.cid))
    FROM rules r,
    JSON_TABLE(
      COALESCE(JSON_EXTRACT(r.target_by_account, CONCAT('$.', @account_id)), r.target_ids),
      '$[*]' COLUMNS (cid VARCHAR(80) PATH '$')
    ) jt
    WHERE r.id = @rule_id
  )
ORDER BY a.campaign_id, a.adset_id, a.ad_id;

-- ------------------------------------------------------------
-- 1. 规则的目标配置（看 target_level、target_ids、target_by_account）
-- ------------------------------------------------------------
SELECT
  id,
  rule_name,
  account_id,
  target_level,
  target_ids,
  target_by_account
FROM rules
WHERE id = @rule_id;

-- ------------------------------------------------------------
-- 2. 该规则「能看到的」目标 ID 列表（系列 ID 或 广告组 ID 或 广告 ID）
-- 优先用 target_by_account[当前账户]，否则用 target_ids；多账户时 target_ids 可能带 "账户:id" 前缀
-- ------------------------------------------------------------
-- 2a) 若用 target_by_account（推荐）：直接取当前账户下的 id 数组
SELECT
  id,
  rule_name,
  target_level,
  JSON_UNQUOTE(JSON_EXTRACT(target_by_account, CONCAT('$.', @account_id))) AS target_ids_for_account
FROM rules
WHERE id = @rule_id;

-- 2b) 若用 target_ids：看原始数组（可能含 "act_xxx:id" 格式）
SELECT
  id,
  rule_name,
  target_level,
  target_ids AS target_ids_raw
FROM rules
WHERE id = @rule_id;


-- ========== 以下用「系列 ID」查：请把 '你的系列ID' 换成上面查到的实际 campaign_id（多个用逗号隔开）==========
-- 若 2a 返回如 ["123456789"], 则把下面 @campaign_ids 设为 '123456789'；多个则 'id1,id2,id3'
SET @campaign_ids = '你的系列ID';   -- 例如 '123456789012345' 或 '111,222,333'

-- ------------------------------------------------------------
-- 3. 该系列下的「广告组」列表（规则能看到的广告组）
-- ------------------------------------------------------------
SELECT
  s.adset_id,
  s.campaign_id,
  s.name           AS adset_name,
  s.effective_status,
  s.account_id
FROM structure_adsets s
WHERE s.account_id = @account_id
  AND s.campaign_id IN (
    SELECT TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(@campaign_ids, ',', n.n), ',', -1)) AS cid
    FROM (SELECT 1 n UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9 UNION SELECT 10) n
    WHERE n.n <= 1 + (LENGTH(@campaign_ids) - LENGTH(REPLACE(@campaign_ids, ',', '')))
  );
-- 若你只有一个系列 ID，可简化为：
-- WHERE s.account_id = @account_id AND s.campaign_id = '单个系列ID';


-- ------------------------------------------------------------
-- 4. 该系列下的「广告」列表（规则能看到的广告，含 adset/campaign 信息）
-- ------------------------------------------------------------
SELECT
  a.ad_id,
  a.adset_id,
  a.campaign_id,
  a.name           AS ad_name,
  a.effective_status,
  a.account_id
FROM structure_ads a
WHERE a.account_id = @account_id
  AND a.campaign_id IN (
    SELECT TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(@campaign_ids, ',', n.n), ',', -1))
    FROM (SELECT 1 n UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9 UNION SELECT 10) n
    WHERE n.n <= 1 + (LENGTH(@campaign_ids) - LENGTH(REPLACE(@campaign_ids, ',', '')))
  );
-- 若只有一个系列 ID，可简化为：
-- WHERE a.account_id = @account_id AND a.campaign_id = '单个系列ID';


-- ------------------------------------------------------------
-- 5. 各广告的「最近一条」数据（与规则评估用的 today 快照口径一致）
-- 每个 ad_id 一行，含 spend / 点击 / 购买 等，用于核对规则能否看到各广告数据
-- ------------------------------------------------------------
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
  WHERE account_id = @account_id
    AND data_date = CURDATE()   -- 今日快照（与规则 time_window=today 一致；若库按 UTC 存日请改用相应日期）
    AND campaign_id IN (
      SELECT TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(@campaign_ids, ',', n.n), ',', -1))
      FROM (SELECT 1 n UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9 UNION SELECT 10) n
      WHERE n.n <= 1 + (LENGTH(@campaign_ids) - LENGTH(REPLACE(@campaign_ids, ',', '')))
    )
) t
WHERE t.rn = 1
ORDER BY t.ad_id;

-- 若你库中 ad_snapshots 没有 data_date 或按 UTC 存日，可改用「最近同步时间」取每个 ad 最新一条：
/*
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
  t.synced_at
FROM (
  SELECT
    account_id, ad_id, ad_name, ad_set_id, campaign_id, status,
    spend, purchases, link_clicks, unique_link_clicks, purchase_value,
    cpc, roas, cpa,
    synced_at,
    ROW_NUMBER() OVER (PARTITION BY account_id, ad_id ORDER BY synced_at DESC, id DESC) AS rn
  FROM ad_snapshots
  WHERE account_id = @account_id
    AND campaign_id IN ( ... )  -- 同上，替换为你的系列 ID
) t
WHERE t.rn = 1;
*/


-- ------------------------------------------------------------
-- 6. 汇总：规则能看到的广告数量 vs 有快照数据的广告数量
-- ------------------------------------------------------------
-- 能看到的广告数（structure_ads）
SELECT COUNT(DISTINCT a.ad_id) AS rule_visible_ads_count
FROM structure_ads a
WHERE a.account_id = @account_id
  AND a.campaign_id IN (
    SELECT TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(@campaign_ids, ',', n.n), ',', -1))
    FROM (SELECT 1 n UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5) n
    WHERE n.n <= 1 + (LENGTH(@campaign_ids) - LENGTH(REPLACE(@campaign_ids, ',', '')))
  );

-- 今日有快照的广告数（ad_snapshots，每个 ad 算一条）
SELECT COUNT(DISTINCT ad_id) AS ads_with_snapshot_today
FROM ad_snapshots
WHERE account_id = @account_id
  AND data_date = CURDATE()
  AND campaign_id IN (
    SELECT TRIM(SUBSTRING_INDEX(SUBSTRING_INDEX(@campaign_ids, ',', n.n), ',', -1))
    FROM (SELECT 1 n UNION SELECT 2 UNION SELECT 3 UNION SELECT 4 UNION SELECT 5) n
    WHERE n.n <= 1 + (LENGTH(@campaign_ids) - LENGTH(REPLACE(@campaign_ids, ',', '')))
  );
