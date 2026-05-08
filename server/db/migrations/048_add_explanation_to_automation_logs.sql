-- M6: 可解释审计字段
-- 为 automation_logs 增加 explanation(JSON) 字段，用于存储
-- 子 ad 快照、聚合推导、条件命中链路等可解释信息。

ALTER TABLE automation_logs
    ADD COLUMN explanation JSON NULL COMMENT '对象级执行解释：target/window/input/aggregate/conditionTrace/logic';
