-- 创建账户-负责人视图（方便在 Navicat 中直观查看）
-- 这个视图会自动 JOIN account_mappings 和 owners 表，显示完整的对应关系

CREATE OR REPLACE VIEW v_account_owners AS
SELECT 
    am.id,
    am.fb_account_id AS account_id,
    COALESCE(am.fb_account_name, '(未命名)') AS account_name,
    am.owner_id,
    COALESCE(o.owner_name, '无') AS owner_name,
    am.is_active,
    CASE WHEN am.is_active = 1 THEN '激活' ELSE '停用' END AS status_text,
    am.created_at,
    am.updated_at
FROM account_mappings am
LEFT JOIN owners o ON am.owner_id = o.id
ORDER BY am.id DESC;

-- 使用说明：
-- 1. 在 Navicat 中，展开数据库 → 视图 → 找到 v_account_owners
-- 2. 双击打开，就能看到账户和负责人的完整对应关系
-- 3. 这个视图是只读的，不能直接修改（需要修改 account_mappings 表）



