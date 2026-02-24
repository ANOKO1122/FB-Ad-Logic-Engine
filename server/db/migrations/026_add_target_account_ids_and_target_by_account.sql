-- 多选账户方案 B：规则表增加 target_account_ids、target_by_account
-- target_account_ids: JSON 数组，规则作用的账户 ID 列表（如 ["act_1","act_2"]）
-- target_by_account: JSON 对象，按账户分组的对象 ID 列表（如 {"act_1":["id1","id2"],"act_2":["id3"]}）
-- 执行时按 target_by_account[account_id] 取当前账户的目标，兼容旧规则（无此列时用 account_id + target_ids）

ALTER TABLE `rules`
ADD COLUMN `target_account_ids` JSON DEFAULT NULL
COMMENT '多选账户时规则作用的账户ID列表，JSON数组'
AFTER `target_ids`;

ALTER TABLE `rules`
ADD COLUMN `target_by_account` JSON DEFAULT NULL
COMMENT '按账户分组的目标对象ID，JSON对象 key=account_id value=id数组，方案B'
AFTER `target_account_ids`;
