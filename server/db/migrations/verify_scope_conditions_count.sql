-- ============================================
-- 监控范围条件数量核对（所有广告账户）
-- 使用前：确认 account_mappings 中 is_active=1 的账户即你「多选所有账户」的集合
-- 若你只核对「当前登录用户」的账户，在下面子查询中加上 AND owner_id = <你的owner_id>
-- ============================================

-- 1. 广告层级：状态 = 所有投放中（effective_status = 'ACTIVE'）
-- 期望：与界面「已勾选 134 个对象」等一致
SELECT COUNT(*) AS ad_active_count
FROM structure_ads a
WHERE a.account_id IN (SELECT fb_account_id FROM account_mappings WHERE is_active = 1)
  AND a.effective_status = 'ACTIVE';


-- 2. 广告组层级：状态 = 所有投放中 AND 名称包含 0224
-- 期望：与界面「已勾选 64 个对象」一致
SELECT COUNT(*) AS adset_active_name0224_count
FROM structure_adsets s
WHERE s.account_id IN (SELECT fb_account_id FROM account_mappings WHERE is_active = 1)
  AND s.effective_status = 'ACTIVE'
  AND s.name LIKE '%0224%';


-- 3. 广告系列层级：状态 = 所有投放中 AND 名称包含 0224
-- 期望：与界面「已勾选 27 个对象」一致
SELECT COUNT(*) AS campaign_active_name0224_count
FROM structure_campaigns c
WHERE c.account_id IN (SELECT fb_account_id FROM account_mappings WHERE is_active = 1)
  AND c.effective_status = 'ACTIVE'
  AND c.name LIKE '%0224%';


-- ============================================
-- 若你「所有账户」= 结构表里出现过的全部账户（不依赖 account_mappings），可用下面三条，去掉 IN 子查询
-- ============================================

-- 1) 广告 - 开启状态（全表）
-- SELECT COUNT(*) FROM structure_ads WHERE effective_status = 'ACTIVE';

-- 2) 广告组 - 开启且名称包含0224（全表）
-- SELECT COUNT(*) FROM structure_adsets WHERE effective_status = 'ACTIVE' AND name LIKE '%0224%';

-- 3) 广告系列 - 开启且名称包含0224（全表）
-- SELECT COUNT(*) FROM structure_campaigns WHERE effective_status = 'ACTIVE' AND name LIKE '%0224%';
