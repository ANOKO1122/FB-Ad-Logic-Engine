# 同层聚合 SQL 性能门禁

## 1. 目标

- 对 `ad/adset/campaign` 三类核心查询输出 `EXPLAIN` 报告。
- 对核心聚合 SQL 与单账户完整评估链路输出 `p95` 报告。
- 失败时返回非零退出码，作为发布门禁。

## 2. 运行命令

1. `npm run perf:explain`
2. `npm run perf:bench`
3. `npm run perf:gate`

## 3. 环境变量

- `PERF_ACCOUNT_ID`：可选，指定压测账户。
- `PERF_CORE_SQL_P95_MS`：默认 `500`。
- `PERF_FULL_EVAL_P95_MS`：默认 `3000`。
- `PERF_WARMUP_ROUNDS`：默认 `5`。
- `PERF_RUN_ROUNDS`：默认 `30`。

## 4. 报告产物

- `docs/perf-reports/explain-ad_level_today_latest_snapshot.json`
- `docs/perf-reports/explain-adset_level_history_group_by.json`
- `docs/perf-reports/explain-campaign_level_history_group_by.json`
- `docs/perf-reports/explain-level-aggregation.json`
- `docs/perf-reports/benchmark-level-aggregation.json`

## 5. 判定规则

- 三类 `EXPLAIN` 的 `type=ALL` 总次数必须等于 `0`。
- 核心聚合 SQL `p95 <= 500ms`。
- 单账户完整评估 `p95 <= 3000ms`。
