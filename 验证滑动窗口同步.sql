-- 验证滑动窗口同步
-- 检查 daily_stats 中是否有按日更新的数据

SELECT 
  account_id,
  date,
  timezone_name,
  COUNT(*) as record_count,
  MAX(updated_at) as latest_update
FROM daily_stats
WHERE account_id = 'act_927139705822379'
  AND date >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
GROUP BY account_id, date, timezone_name
ORDER BY date DESC, latest_update DESC;

-- 预期结果：
-- 1. timezone_name 应该是账户实际时区（如 Asia/Shanghai）
-- 2. 每个 date 对应一条记录（按自然日）
-- 3. updated_at 应该是最新的更新时间（滑动窗口同步后）

