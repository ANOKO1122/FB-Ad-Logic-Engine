-- M3: 同层聚合索引（性能门禁）
-- 为核心聚合 SQL 补充复合索引，对齐 WHERE + GROUP BY 模式，禁止全表扫描
--
-- 验收标准（P0）：
--   - EXPLAIN 中 type=ALL 出现次数为 0
--   - 单条核心聚合 SQL p95 <= 500 ms
--   - 单账户完整评估 p95 <= 3000 ms

-- daily_stats 按 adset 聚合
ALTER TABLE daily_stats
    ADD INDEX idx_daily_account_date_adset (account_id, date, ad_set_id);

-- daily_stats 按 campaign 聚合
ALTER TABLE daily_stats
    ADD INDEX idx_daily_account_date_campaign (account_id, date, campaign_id);

-- ad_snapshots 按 adset 聚合（使用 data_date 替代 synced_at 以匹配查询模式）
ALTER TABLE ad_snapshots
    ADD INDEX idx_snap_account_data_date_adset (account_id, data_date, ad_set_id);

-- ad_snapshots 按 campaign 聚合
ALTER TABLE ad_snapshots
    ADD INDEX idx_snap_account_data_date_campaign (account_id, data_date, campaign_id);
