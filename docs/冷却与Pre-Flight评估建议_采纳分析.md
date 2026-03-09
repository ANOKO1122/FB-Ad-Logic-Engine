# 冷却与 Pre-Flight 改造 — AI 评估建议采纳分析

## 一、结论总览

| 建议项 | 采纳与否 | 理由简述 |
|--------|----------|----------|
| outside_window / suppressed 写冷却 | **已实现，不需采纳** | 代码已在仲裁循环内 push 这两类 stateUpdates |
| 预算 skipped 时 lastStatus | **采纳（文档/注释）** | 当前行为已是写 success，仅需明确注释 |
| 预算作用域缺失时 cooldownKey | **采纳** | 避免空键，fallback 为 `ad:adId`，语义明确 |
| isCooldownDue 复用或移除 | **不采纳** | 保留供执行层单键判断；调度层继续用批量 load+比较 |
| 冷却表索引与清理 | **部分采纳** | 索引已有；90 天清理建议作为后续任务 |
| 批量 INSERT 优化 | **不采纳** | 当前逐条足够，可后续按量再优化 |
| 单测与观测 | **采纳（建议分批）** | 提高可维护性与排查能力 |
| **ad_id 写入与 NOT NULL** | **必须修** | 表为 ad_id NOT NULL，非 ad 键不能写 NULL，需写空串 |

---

## 二、逐项说明

### 1. 冷却写入在「未执行/跳过」场景（outside_window / suppressed）

- **AI 建议**：仲裁后把 outside_window、suppressed 也写入冷却表。
- **当前实现**：`cronService.js` **已在仲裁循环内**按每条广告写入，无需在循环外再统计：
  - 不在执行时间窗：`stateUpdates.push({ ruleId, scopeKey: 'ad:'+adId, lastStatus: 'outside_window' })`，并对每条 suppressed 规则 push `suppressed`；
  - 在时间窗内：先对每条 suppressed 规则 push `suppressed`；winner 在执行完后按结果写 success/fail；
  - 最后统一 `upsertRuleAdExecutionStateBatch(stateUpdates)` 落库。
- **结论**：**不需要采纳**，已实现。AI 可能未看到 L596–598、L602–604。

---

### 2. 预算 skipped 时 lastStatus 与冷却

- **AI 建议**：预算「当前=目标」→ skipped 时，冷却表写 `success` 或 `suppressed`（建议 `success`），避免被当成未执行。
- **当前实现**：执行后 `stateUpdates.push(..., lastStatus: fail > 0 ? 'fail' : 'success')`。Pre-Flight 跳过时 `results[0].status === 'skipped'`，未执行 fail++，故 push 的已是 `success`。
- **结论**：**采纳为「文档/注释」**：在 cron 或 ruleExecutionStateService 注释中写明「skipped 视为 success 写冷却，保证幂等命中仍占冷却」。

---

### 3. 预算作用域缺失时 cooldownKey（无 adsetId / campaignId）

- **AI 建议**：无 adsetId/campaignId 时显式设 `cooldownKey = ad:${matchedAd.ad_id}`，避免写入空键。
- **当前实现**：无 adsetId 时 break 不设 cooldownKey；cron 侧有 `cooldownKey = results[0]?.cooldownKey ?? 'ad:'+adId`，故不会写空键，但动作层未显式设。
- **结论**：**采纳**。在动作层无 adsetId 或无 campaignId 时显式 `cooldownKey = 'ad:'+matchedAd.ad_id`，语义清晰、避免依赖 cron 的 fallback 约定。

---

### 4. isCooldownDue 的使用（批量 vs 单键）

- **AI 建议**：要么新增 `isCooldownDueBatch(ruleId, keys, intervalMin)` 统一口径，要么删除未使用的 `isCooldownDue`。
- **当前实现**：调度层用 `loadRuleAdExecutionState` 批量查 + 本地 diffMin 比较；`isCooldownDue` 未在调度层使用，但方案里提到执行层可按 scope 单键判断。
- **结论**：**不采纳**。保留 `isCooldownDue` 供执行层将来使用；调度层继续用「批量 load + 比较」，在服务或 cron 注释中说明「调度用批量、执行层可用 isCooldownDue」即可，不新增 batch 接口、不删除单键接口。

---

### 5. 冷却表索引与数据保持

- **索引**：当前主键 `(rule_id, scope_key)`，另有 `idx_scope_key`、`idx_rule`、`idx_ad`。AI 建议的 `(rule_id, ad_id)` 非唯一索引为可选（按 ad 排查用），**暂不采纳**，需要时再加。
- **清理**：建议「仅保留最近 90 天」防表膨胀。**采纳为后续任务**：用定时任务或脚本定期 DELETE，不阻塞本次发布。

---

### 6. 批量 INSERT 优化

- **AI 建议**：`upsertRuleAdExecutionStateBatch` 改为多行 VALUES 一次执行。
- **结论**：**不采纳**。当前逐条 INSERT 简单、可维护；若后续执行量显著增大再考虑批量 INSERT（注意 SQL 长度与参数上限）。

---

### 7. 单测与观测

- **单测**：**采纳**。建议分批补齐：冷却命中、预算幂等、outside_window、suppressed、错误容忍等场景。
- **观测**：**采纳**。在日志中增加 cooldownKey / lastStatus 概览、cron 冷却键读取数/到期数/写入条数，便于排查，改动小。

---

### 8. ad_id NOT NULL 与预算行写入（必须修）

- **现状**：表由 028 创建，`ad_id` 为 `VARCHAR(50) NOT NULL`；031 未修改。`ruleExecutionStateService` 对非 `ad:` 的 scope_key 传 `ad_id = null`，在 MySQL 中会报错。
- **结论**：**必须修**。不在本次新增迁移的前提下，写入时对「非 ad: 前缀」的 scope_key 使用 `ad_id = ''`（空字符串），不传 `null`；若后续希望区分「无广告」与「空串」，可再做迁移将 `ad_id` 改为可 NULL。

---

## 三、影响与区别小结

- **已实现项**：outside/suppressed 写冷却、仲裁后 stateUpdates 填充分支 — 无额外改动，仅作确认。
- **采纳项**：预算缺失时 cooldownKey fallback、skipped 写冷却的注释、ad_id 写空串、观测/单测 — 提升一致性与可维护性，不改变主流程语义。
- **不采纳项**：删除 isCooldownDue、批量 INSERT、新增 (rule_id, ad_id) 索引 — 避免过度抽象或过早优化，保持当前实现即可。
- **后续任务**：90 天数据清理、可选单测与观测落地。
