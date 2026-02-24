# 验收口径：campaign_id / ad_set_id 补齐与回填

> 写入时补齐 + 历史回填已验证通过，本文档作为**后续正式验收口径**，发布/上线前需满足以下项。

---

## 一、保留项（不得删除）

- **写入时补齐**：`server/services/ingestorService.js`
  - 函数 `fillCampaignAdsetFromStructure(accountId, items)`（从 structure_ads 补齐 item.adset_id / item.campaign_id）
  - 调用点 1：同步 Today → ad_snapshots 前（API 合并后、入队前）
  - 调用点 2：`updateDailyStatsFromInsights` 写 daily_stats 前
- **历史回填脚本**：`server/db/migrations/025_backfill_campaign_adset_from_structure.sql`
  - 仅回填最近 7 天、campaign_id 或 ad_set_id 为空（含空串）的行，来源 structure_ads
  - 建议先单账号验收再全量执行

---

## 二、验收口径（后续发布/上线必验）

1. **今日 ad_snapshots 缺失统计为 0**
   - campaign_id、ad_set_id 均不缺（写入时补齐生效）。
   - 验证示例：
     ```sql
     SELECT COUNT(*) AS 今日缺失
     FROM ad_snapshots
     WHERE data_date = CURDATE()
       AND (COALESCE(TRIM(campaign_id), '') = '' OR COALESCE(TRIM(ad_set_id), '') = '');
     ```
   - **预期**：`今日缺失 = 0`。

2. **近 7 天缺失行回填后为 0**
   - ad_snapshots 与 daily_stats 在最近 7 天内无“缺 campaign/adset”的行（历史回填生效）。
   - 验证示例：
     ```sql
     SELECT COUNT(*) AS ad_snapshots_缺失 FROM ad_snapshots
     WHERE data_date >= CURDATE() - INTERVAL 7 DAY
       AND (COALESCE(TRIM(campaign_id), '') = '' OR COALESCE(TRIM(ad_set_id), '') = '');
     SELECT COUNT(*) AS daily_stats_缺失 FROM daily_stats
     WHERE date >= CURDATE() - INTERVAL 7 DAY
       AND (COALESCE(TRIM(campaign_id), '') = '' OR COALESCE(TRIM(ad_set_id), '') = '');
     ```
   - **预期**：两处结果均为 `0`。

3. **campaign 聚合不再 Empty set**
   - 按广告系列（campaign_id）查今日与多天数据，均能返回结果。
   - 验证示例（替换为真实 account_id / campaign_id）：
     ```sql
     SELECT COUNT(*) FROM ad_snapshots
     WHERE account_id = 'act_xxx' AND campaign_id = 'campaign_yyy' AND data_date = CURDATE();
     ```
   - **预期**：有数据时行数 > 0，不再出现 Empty set。

---

## 三、与规则解析的关系

- 规则按 **campaign / adset** 解析目标时，依赖 ad_snapshots / daily_stats 的 campaign_id、ad_set_id。
- 补齐与回填保证“结构靠 structure_ads，事实表维度键完整”，规则匹配不再因维度缺失而得到 0 个广告。
