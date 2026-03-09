-- ============================================================
-- 五条执行日志：各自满足了什么条件才执行 — 查询用 SQL
-- 规则 0226测试 (id=400)，五条 PAUSE_AD 成功记录
-- 依赖：automation_logs.metrics_snapshot 存有触发时的指标快照，rules.conditions 存 6 组 DNF 条件
-- ============================================================

-- 1. 这五条执行日志 + 触发时指标快照（每条日志对应一个广告当时的 spend/点击/购买等）
SELECT
  al.id,
  al.triggered_at     AS 执行时间,
  al.rule_name        AS 规则名称,
  al.ad_id            AS 广告ID,
  al.ad_name          AS 广告名称,
  al.action_type      AS 执行动作,
  al.status           AS 状态,
  al.metrics_snapshot AS 触发时指标快照
FROM automation_logs al
WHERE al.rule_id = 400
  AND al.ad_id IN (
    '120242100873060501',
    '120242100873100501',
    '120242100873070501',
    '120242100873090501',
    '120242100873080501'
  )
  AND al.action_type = 'PAUSE_AD'
  AND al.status = 'success'
ORDER BY al.triggered_at DESC;

-- 2. 规则 400 的完整条件（6 组 DNF：组内 AND，组间 OR；满足任一组即触发）
SELECT
  id,
  rule_name,
  conditions AS 条件配置_6组DNF
FROM rules
WHERE id = 400;

-- 3. 每条日志展开 metrics_snapshot 关键字段（方便直接看“当时数据”）
-- 注：快照中仅有 spend/link_clicks/purchases/cpc/roas 等，加购/结账次数若规则有则需对照 ad_snapshots 当时数据
SELECT
  al.triggered_at                                    AS 执行时间,
  al.ad_id                                           AS 广告ID,
  al.ad_name                                         AS 广告名称,
  JSON_UNQUOTE(JSON_EXTRACT(al.metrics_snapshot, '$.spend'))            AS spend,
  JSON_UNQUOTE(JSON_EXTRACT(al.metrics_snapshot, '$.link_clicks'))      AS link_clicks,
  JSON_UNQUOTE(JSON_EXTRACT(al.metrics_snapshot, '$.purchases'))         AS purchases,
  JSON_UNQUOTE(JSON_EXTRACT(al.metrics_snapshot, '$.cpc'))               AS cpc,
  JSON_UNQUOTE(JSON_EXTRACT(al.metrics_snapshot, '$.roas'))             AS roas,
  JSON_UNQUOTE(JSON_EXTRACT(al.metrics_snapshot, '$.unique_link_clicks')) AS unique_link_clicks
FROM automation_logs al
WHERE al.rule_id = 400
  AND al.ad_id IN (
    '120242100873060501',
    '120242100873100501',
    '120242100873070501',
    '120242100873090501',
    '120242100873080501'
  )
  AND al.action_type = 'PAUSE_AD'
  AND al.status = 'success'
ORDER BY al.triggered_at DESC;

-- 说明：对比「3 的指标」与「2 的 conditions 里每组条件」，即可看出每条广告满足的是哪一组。
-- 例如：若某条 spend>1 且 link_clicks=0 且 purchases=0，即可能满足组1（组1 还含加购=0、结账=0，快照未存则需查当时 ad_snapshots）。
--
-- 4. 五条日志 + 当日该广告最新快照的加购/结账真实数据（用于复核规则是否正确执行）
SELECT
  al.id,
  al.triggered_at     AS 执行时间,
  al.ad_id            AS 广告ID,
  JSON_UNQUOTE(JSON_EXTRACT(al.metrics_snapshot, '$.spend'))            AS spend,
  JSON_UNQUOTE(JSON_EXTRACT(al.metrics_snapshot, '$.link_clicks'))      AS link_clicks,
  JSON_UNQUOTE(JSON_EXTRACT(al.metrics_snapshot, '$.purchases'))         AS purchases,
  COALESCE(s.add_to_cart_count, 0)       AS add_to_cart_count,
  COALESCE(s.initiate_checkout_count, 0)  AS initiate_checkout_count,
  COALESCE(s.add_payment_info_count, 0)   AS add_payment_info_count
FROM automation_logs al
LEFT JOIN (
  SELECT
    ad_id,
    account_id,
    data_date,
    add_to_cart_count,
    initiate_checkout_count,
    add_payment_info_count,
    ROW_NUMBER() OVER (
      PARTITION BY account_id, ad_id, data_date
      ORDER BY synced_at DESC, id DESC
    ) AS rn
  FROM ad_snapshots
  WHERE account_id = 'act_1155891202142879'
    AND ad_id IN (
      '120242100873060501', '120242100873100501', '120242100873070501',
      '120242100873090501', '120242100873080501'
    )
    AND data_date >= '2026-02-26'
    AND data_date <= '2026-02-28'
) s ON s.ad_id = al.ad_id
   AND s.account_id = al.account_id
   AND s.rn = 1
   AND s.data_date = DATE(al.triggered_at)
WHERE al.rule_id = 400
  AND al.ad_id IN (
    '120242100873060501', '120242100873100501', '120242100873070501',
    '120242100873090501', '120242100873080501'
  )
  AND al.action_type = 'PAUSE_AD'
  AND al.status = 'success'
ORDER BY al.triggered_at DESC;
