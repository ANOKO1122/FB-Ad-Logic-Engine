-- ============================================
-- 迁移脚本：019_seed_rule_templates.sql
-- 目的：插入 3 个预设模板（止损、扩量、空耗）作为初始数据
-- 前置：需先执行 018_create_rule_templates.sql
--
-- 幂等：ON DUPLICATE KEY UPDATE slug=slug（存在则跳过，不吞错）
-- ============================================

INSERT INTO rule_templates (
  name, slug, description,
  when_lines, when_time_window, when_custom_range, actions,
  sort_order, is_active
) VALUES
-- 止损模板
(
  '止损', 'stop_loss', '花费>20 且 ROAS<0.5（今天）→ 暂停',
  '[{"join":null,"metric":"spend","operator":"gt","value":20},{"join":"AND","metric":"roas","operator":"lt","value":0.5}]',
  'today', NULL,
  '[{"type":"pause_ad","value":null}]',
  10, 1
),
-- 扩量模板
(
  '扩量', 'scale_up', 'ROAS>2（近3天）→ 增加预算 20%',
  '[{"join":null,"metric":"roas","operator":"gt","value":2}]',
  'last_3_days', NULL,
  '[{"type":"increase_budget","value":20}]',
  20, 1
),
-- 空耗模板
(
  '空耗', 'zero_click', '花费>0.5 且 点击=0（今天）→ 暂停',
  '[{"join":null,"metric":"spend","operator":"gt","value":0.5},{"join":"AND","metric":"link_clicks","operator":"eq","value":0}]',
  'today', NULL,
  '[{"type":"pause_ad","value":null}]',
  30, 1
)
ON DUPLICATE KEY UPDATE slug = slug;

-- ============================================
-- 验证 SQL（执行后可选）
-- ============================================
-- SELECT id, name, slug, sort_order, is_active FROM rule_templates ORDER BY sort_order;
