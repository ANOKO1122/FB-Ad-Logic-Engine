-- 检查账户状态
SELECT 
  fb_account_id,
  owner_id,
  is_active,
  timezone_name,
  created_at
FROM account_mappings
WHERE fb_account_id = 'act_927139705822379';

