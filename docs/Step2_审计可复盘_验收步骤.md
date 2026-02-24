# Step 2 审计可复盘 — 验收步骤

> 对应 TASKS.md 4.1 审计日志与 Dry Run、4.1.1 规则执行摘要。

---

## 验收项 1：automation_logs 单条可复盘

**口径**：单条记录能还原「谁、何时、对哪条广告、执行了什么、结果如何」。

**验收 SQL**（查最近几条，核对字段齐全）：

```sql
SELECT
  id, run_id, rule_id, rule_name, account_id, ad_id, ad_name,
  action_type, is_simulation, status, error_message,
  metrics_snapshot IS NOT NULL AS has_metrics,
  api_request IS NOT NULL AS has_api_req,
  api_response IS NOT NULL AS has_api_res,
  triggered_at
FROM automation_logs
ORDER BY id DESC
LIMIT 5;
```

**说明**：`has_metrics` / `has_api_req` / `has_api_res` 表示该列是否非空（1=有，0=无），便于快速目视检查而不展开 JSON。

**预期**：每条具备 rule_id、ad_id、action_type、status；success/fail 有 api_request、api_response；有 metrics_snapshot（has_metrics=1，或至少含 spend/roas 等关键指标）；skipped 时 error_message 含原因（如「目标已达成」）。

---

## 验收项 2：同一 run_id 两表时间一致

**口径**：同一 run_id 下，摘要的 `evaluated_at` 与日志的 `triggered_at` 处于同一量级（摘要写于该 run 评估/汇总时刻，日志写于每条动作完成时刻，中间含 API 调用，故常差数秒）。

**前置**：已执行迁移 `016_automation_logs_triggered_at_timestamp.sql`。

**验收 SQL**：

```sql
SELECT
  s.run_id,
  s.evaluated_at AS summary_time,
  MIN(a.triggered_at) AS log_min_time,
  MAX(a.triggered_at) AS log_max_time,
  TIMESTAMPDIFF(SECOND, s.evaluated_at, MIN(a.triggered_at)) AS diff_sec
FROM rule_execution_summaries s
JOIN automation_logs a ON a.run_id = s.run_id AND a.run_id IS NOT NULL
WHERE s.evaluated_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
GROUP BY s.run_id, s.evaluated_at
ORDER BY s.evaluated_at DESC
LIMIT 10;
```

**预期**：`diff_sec` 在 **0～10 秒**内视为正常（evaluated_at 为评估/写摘要时刻，triggered_at 为动作完成时刻，2～4 秒属正常）。若出现大额负数或 >60 需排查。

---

## 验收项 3：同一 run_id 下同一 ad_id 最多一条执行记录

**口径**：按 ad 仲裁后，同一 run 同一广告只执行一次，日志只一条。

**验收 SQL**：

```sql
SELECT run_id, ad_id, COUNT(*) AS cnt
FROM automation_logs
WHERE run_id IS NOT NULL
  AND triggered_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
GROUP BY run_id, ad_id
HAVING COUNT(*) > 1;
```

**预期**：结果为空（无重复）。

---

## 验收步骤汇总

1. 执行验收项 1 SQL，目视确认字段齐全、可读。
2. 确认迁移 016 已执行（`SHOW COLUMNS FROM automation_logs LIKE 'triggered_at'` 类型为 `timestamp`），再执行验收项 2 SQL。
3. 执行验收项 3 SQL，确认无重复。
4. 若全部通过，在 TASKS.md 中勾选 4.1 相关未勾项（如「同一 run_id 两表时间差 ≤ 1 秒」）。
