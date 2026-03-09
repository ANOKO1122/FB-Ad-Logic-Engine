-- ============================================
-- 迁移脚本：036_add_idx_structure_ads_adset_campaign.sql
-- 目的：为 structure_ads 补充 (account_id, adset_id) 与 (account_id, campaign_id) 组合索引
-- 依据：动态筛选三道防线之三——「排除名单的懒加载索引」
--
-- 背景：
--   - DynamicScopeService 在展开排除名单与手动目标时，会按下列模式访问 structure_ads：
--       SELECT ad_id FROM structure_ads WHERE account_id = ? AND adset_id IN (...);
--       SELECT ad_id FROM structure_ads WHERE account_id = ? AND campaign_id IN (...);
--   - 若缺少 (account_id, adset_id)/(account_id, campaign_id) 索引，MySQL 会对大表做全表扫描，
--     在广告量较大时会导致刷新耗时从 100ms 飙升到数秒甚至十几秒。
--
-- 索引：
--   - idx_account_adset   (account_id, adset_id)
--   - idx_account_campaign(account_id, campaign_id)
--
-- 注意：
--   - 若索引已存在，重复执行会报 Duplicate key name，可忽略；建议仅在确认未建索引时执行一次。
--
-- 执行示例（PowerShell）：
--   mysql -u root -p your_db_name < server/db/migrations/036_add_idx_structure_ads_adset_campaign.sql
--
-- 验证：
--   SHOW INDEX FROM structure_ads WHERE Key_name IN ('idx_account_adset', 'idx_account_campaign');
-- ============================================

ALTER TABLE structure_ads
  ADD INDEX idx_account_adset (account_id, adset_id),
  ADD INDEX idx_account_campaign (account_id, campaign_id);

-- 回滚（仅在需要时手动执行，慎用）：
-- ALTER TABLE structure_ads
--   DROP INDEX idx_account_adset,
--   DROP INDEX idx_account_campaign;

