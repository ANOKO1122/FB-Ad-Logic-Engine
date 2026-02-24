-- 迁移文件：将 rules.account_id 设为 NOT NULL（方案三：长效防御）
-- 目的：防止反向索引退化，确保规则必须绑定账户
-- 执行前请先确认不存在 NULL 值（否则会失败）

-- 步骤 1：检查是否存在 NULL 值
SELECT COUNT(*) AS null_count 
FROM rules 
WHERE account_id IS NULL;

-- 如果 null_count > 0，需要先清洗数据：
-- UPDATE rules SET account_id = 'act_xxx' WHERE account_id IS NULL;
-- （请根据实际情况替换为正确的账户ID）

-- 步骤 2：将 account_id 设为 NOT NULL
ALTER TABLE rules
  MODIFY account_id VARCHAR(50) NOT NULL
  COMMENT '广告账户ID（必填，规则必须绑定账户）';

-- 验证：确认修改成功
SELECT 
  COLUMN_NAME,
  IS_NULLABLE,
  DATA_TYPE,
  COLUMN_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'rules'
  AND COLUMN_NAME = 'account_id';
