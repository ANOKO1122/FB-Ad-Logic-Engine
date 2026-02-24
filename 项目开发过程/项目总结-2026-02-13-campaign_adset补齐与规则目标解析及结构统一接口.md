# 项目总结 - 2026-02-13：campaign/adset 补齐、规则目标解析、结构统一接口

> 本窗口完成：写入时补齐 + 历史回填、规则目标解析改造、前端状态筛选修复、结构索引方案 B（统一接口）及路由顺序修复。

---

## 一、本窗口遇到的问题与解决方法

### 1. 规则执行「匹配 0 个广告」根因

- **现象**：规则按广告系列/广告组执行时，日志显示「规则数据查询完成，共 0 条」「匹配 0 个广告」；同一 campaign 在 structure_ads 有 5 个广告、ad_snapshots 按 ad_id 关联今日有 1 条有 spend 的快照，但按 `campaign_id` 查 ad_snapshots 今日数据为空。
- **根因**：
  - 规则目标解析（campaign/adset → ad_id）与规则数据查询均依赖 **ad_snapshots / daily_stats 的 campaign_id、ad_set_id**；
  - 当时 ad_snapshots 中该账户今日快照的 **campaign_id 未写入或为空**，导致「按 campaign 解析目标」时 SQL 返回 0 行（targetAdIds 为空或查不到数据）。
- **解决**：
  - **写入时补齐**：在 ingestorService 写入 ad_snapshots / daily_stats 前，对 insight 中 campaign_id 或 adset_id 为空的，从 **structure_ads** 按 account_id + ad_id 批量查询并补齐（fillCampaignAdsetFromStructure），补到 item.adset_id / item.campaign_id（写入层用 insight.adset_id → DB 列 ad_set_id）；IN 查询按 500 一批避免过长。
  - **历史回填**：新增迁移 025_backfill_campaign_adset_from_structure.sql，对 ad_snapshots / daily_stats 最近 7 天内 campaign_id 或 ad_set_id 为空（含空串）的行，用 structure_ads 回填；SET 使用 COALESCE(NULLIF(TRIM(...),''), a.xxx)，建议先单账号验收再全量。
  - **验收口径**：今日 ad_snapshots 缺失为 0、近 7 天回填后缺失为 0、campaign 聚合非 Empty set；文档见 `docs/验收口径_campaign_adset_补齐与回填.md`。

### 2. 规则目标解析依赖 spend>0 子集导致目标为空

- **现象**：即使用户选了「广告系列」或「广告组」，解析出的 targetAdIds 仍可能为 0（因从 ad_snapshots 按 campaign_id/ad_set_id 查，而 ad_snapshots 只含 spend>0 子集）。
- **根因**：campaign/adset → ad_id 的解析写在 ad_snapshots 上，ad_snapshots 是「有花费」子集，结构关系不全。
- **解决**：
  - **规则目标解析改造**：在 ruleEngineDispatcher.js 与 index.js 中，将 campaign/adset → ad_id 的解析改为从 **structure_ads** 查询（全量关系）；未指定 target 时「账户下全部广告」也改为从 structure_ads 查，与 campaign/adset 口径一致（含 spend=0 广告）。
  - 列名：structure_ads 为 adset_id，事实表列为 ad_set_id；解析时用 adset_id 查 structure_ads，写入层仍用 insight.adset_id → ad_set_id。
- **验收**：同一 campaign 解析出的 ad_id 数量 ≥ 之前；规则按 campaign/adset 不再出现 0 匹配；ad 级别规则行为不变。

### 3. 前端 scopeIncludePaused is not defined 与 include_paused 未传

- **现象**：控制台报错 `scopeIncludePaused is not defined`；切换「包含暂停/仅启用」时结构列表不变化；请求 /api/structure/:level 未带 include_paused。
- **根因**：setup() 中定义了 scopeIncludePaused 与模板 @change="onScopeStatusChange"，但未在 return 中暴露；getStructureObjects 未传 include_paused 参数。
- **解决**：
  - RuleManager.vue：在 return 中增加 scopeIncludePaused、onScopeStatusChange；实现 onScopeStatusChange 调用 refreshScopeItems；refreshScopeItems / loadMoreScopeItems 调用 getStructureObjects 时传入 include_paused: scopeIncludePaused.value。
  - facebookApi.js：getStructureObjects 的 options 增加 include_paused，请求 params 中传 include_paused: include_paused ? 1 : undefined。
- **验收**：控制台无报错；切换状态筛选后列表正确刷新；Network 中可见 include_paused 参数。

### 4. 结构统一接口 /api/structure/objects 返回 400

- **现象**：请求 GET /api/structure/objects?account_id=...&type=campaign 返回 400（level 参数无效）。
- **根因**：Express 路由按注册顺序匹配；**GET /api/structure/:level** 先注册，**/api/structure/objects** 被当作 :level=objects 匹配，进入 campaigns/adsets/ads 分支后 level=objects 不在 edgeMap 中，返回 400。
- **解决**：将 **GET /api/structure/objects** 路由移到 **GET /api/structure/:level** 之前注册，仅调整顺序、无业务逻辑变更。
- **验收**：type=campaign/adset/ad 均 200；items 字段统一；meta.source 与 type 匹配。

---

## 二、本窗口完成的功能与文档

| 类别 | 内容 |
|------|------|
| **写入时补齐** | ingestorService.fillCampaignAdsetFromStructure；同步 Today 入队前、updateDailyStatsFromInsights 写库前调用；分批 500、补 item.adset_id/campaign_id。 |
| **历史回填** | 025_backfill_campaign_adset_from_structure.sql；ad_snapshots/daily_stats 最近 7 天、NULL 与空串用 structure_ads 回填；NULLIF(TRIM(...),'')。 |
| **验收口径** | docs/验收口径_campaign_adset_补齐与回填.md；规则管理清单第七节引用。 |
| **规则目标解析** | ruleEngineDispatcher.js、index.js：campaign/adset/未指定 target 均从 structure_ads 解析 ad_id；ad 层级不变。 |
| **前端状态筛选** | RuleManager.vue return scopeIncludePaused/onScopeStatusChange；onScopeStatusChange→refreshScopeItems；facebookApi.getStructureObjects 传 include_paused。 |
| **结构索引方案 B** | structureSyncService.listStructureObjectsFromDb(type, opts)；GET /api/structure/objects；facebookApi.getStructureObjectsUnified；统一字段 id/type/name/campaign_id/adset_id/effective_status/account_id。 |
| **路由顺序** | /api/structure/objects 注册在 /api/structure/:level 之前。 |
| **文档** | docs/结构索引_方案B_统一接口说明.md（含验证结论与路由修复说明）。 |

---

## 三、验收结论（本窗口已通过）

- 今日 ad_snapshots 缺失统计为 0（campaign/adset 均不缺），写入时补齐生效。
- 近 7 天 ad_snapshots/daily_stats 缺失回填后为 0，历史修复生效。
- campaign 聚合不再 Empty set（今日与多天有数据）。
- 规则按 campaign/adset 解析目标后不再出现 0 匹配；structure_ads 关系完整、可覆盖 spend=0 广告。
- 前端状态筛选：控制台无 scopeIncludePaused 报错；切换「包含暂停」后列表正确；请求带 include_paused。
- 统一接口 /api/structure/objects：type=ad/adset/campaign 均 200；items 统一；include_paused、q、分页 after 有效；旧接口 /api/structure/:level 不受影响；路由顺序修复后 objects 正常。

---

## 四、下一步建议（下一窗口）

- 继续 TASKS.md / DEV_PLAN 中「Step 4 体验与完整性」、结构增量/选择器优化等剩余项。
- 可选：将 RuleManager 选择器逐步从「三个 level 接口」迁到「getStructureObjectsUnified + type」，统一走 /api/structure/objects。
- 回归：规则执行（含 campaign/adset 目标）、结构列表筛选、统一接口与旧接口并存场景各测一遍。
