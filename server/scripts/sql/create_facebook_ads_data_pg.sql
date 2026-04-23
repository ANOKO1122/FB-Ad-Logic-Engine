-- PostgreSQL：对方 RDS 目标表（由你在 psql 或控制台执行，勿把密码写进仓库）
-- 用途：接收从本系统 MySQL daily_stats 导出的日级广告花费与名称信息

CREATE TABLE IF NOT EXISTS facebook_ads_daily_export (
  account_id     TEXT        NOT NULL,
  ad_id          TEXT        NOT NULL,
  ad_name        TEXT        NULL,
  campaign_name  TEXT        NULL,
  spend          NUMERIC(12, 2) NOT NULL,
  stat_date      DATE        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_facebook_ads_daily_export_account_ad_date UNIQUE (account_id, ad_id, stat_date)
);

CREATE INDEX IF NOT EXISTS idx_facebook_ads_daily_export_stat_date ON facebook_ads_daily_export (stat_date);
CREATE INDEX IF NOT EXISTS idx_facebook_ads_daily_export_campaign_name ON facebook_ads_daily_export (campaign_name);
CREATE INDEX IF NOT EXISTS idx_facebook_ads_daily_export_ad_name ON facebook_ads_daily_export (ad_name);

COMMENT ON TABLE facebook_ads_daily_export IS 'Facebook 广告日级导出（spend>0）；stat_date 对齐 MySQL daily_stats.date';
