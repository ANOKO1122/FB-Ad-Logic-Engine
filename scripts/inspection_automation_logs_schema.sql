-- automation_logs schema gate
-- 用途：发布前/故障排查快速校验关键列是否齐全

SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_COMMENT
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'automation_logs'
ORDER BY ORDINAL_POSITION;

SELECT COUNT(*) AS required_columns_ok
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'automation_logs'
  AND COLUMN_NAME IN (
    'run_id',
    'object_type',
    'object_id',
    'object_name',
    'preflight_mode',
    'explanation'
  );

SELECT
  CASE
    WHEN COUNT(*) = 6 THEN 'PASS'
    ELSE 'FAIL'
  END AS schema_gate,
  GROUP_CONCAT(COLUMN_NAME ORDER BY COLUMN_NAME) AS found_columns
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'automation_logs'
  AND COLUMN_NAME IN (
    'run_id',
    'object_type',
    'object_id',
    'object_name',
    'preflight_mode',
    'explanation'
  );

