-- ============================================
-- 迁移 027: 为 rules 表添加「执行频率」与「允许执行时间段」
-- 依据: docs/执行频率与执行时间 — 适配方案（执行频率语义 + 移除 Smart Mute）.md §2.1
-- ============================================
-- 执行间隔（分钟）：对每个广告而言，同一条规则两次触发之间的最小间隔
-- 允许执行时间段：北京时区 HH:mm:ss 数组，空/NULL 表示全天允许
-- ============================================

ALTER TABLE `rules`
  ADD COLUMN `execution_interval_minutes` INT NULL DEFAULT 15
    COMMENT '执行间隔(分钟)，规则×广告粒度',
  ADD COLUMN `execution_time_windows` JSON NULL
    COMMENT '允许执行时间段(北京时间)，如 [{"start":"09:00:00","end":"18:00:00"}]';

-- ============================================
-- 验证
-- ============================================
-- DESCRIBE rules;
-- 应看到 execution_interval_minutes, execution_time_windows
