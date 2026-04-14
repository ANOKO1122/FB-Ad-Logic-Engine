-- M4.4: rule_history.snapshot_before (config before UPDATE/TOGGLE)
-- mysql -u root -p fb_ad_brain < server/db/migrations/042_rule_history_snapshot_before.sql

ALTER TABLE rule_history
  ADD COLUMN snapshot_before JSON NULL COMMENT 'snapshot before human UPDATE or TOGGLE'
  AFTER rule_snapshot;
