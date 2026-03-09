-- ============================================
-- 监控范围条件核对：单账户 act_1155891202142879，名称 包含 0
-- 界面：已勾选 621 个对象（广告层级）
-- 用下面三条 COUNT 与界面「已勾选 N 个」对比，应一致
-- ============================================

-- 1. 广告（Ad）：名称包含 "0"
-- 期望与界面「已勾选 621 个对象」一致（当前截图为广告层级）
SELECT COUNT(*) AS ad_name_contains_0
FROM structure_ads
WHERE account_id = 'act_1155891202142879'
  AND name LIKE '%0%';


-- 2. 广告组（AdSet）：名称包含 "0"
SELECT COUNT(*) AS adset_name_contains_0
FROM structure_adsets
WHERE account_id = 'act_1155891202142879'
  AND name LIKE '%0%';


-- 3. 广告系列（Campaign）：名称包含 "0"
SELECT COUNT(*) AS campaign_name_contains_0
FROM structure_campaigns
WHERE account_id = 'act_1155891202142879'
  AND name LIKE '%0%';


-- ============================================
-- 若界面还选了「状态 = 所有投放中」，在各自 WHERE 中增加：
--   AND effective_status = 'ACTIVE'
-- 例如广告层级：
-- ============================================
-- SELECT COUNT(*) AS ad_active_name_contains_0
-- FROM structure_ads
-- WHERE account_id = 'act_1155891202142879'
--   AND effective_status = 'ACTIVE'
--   AND name LIKE '%0%';
