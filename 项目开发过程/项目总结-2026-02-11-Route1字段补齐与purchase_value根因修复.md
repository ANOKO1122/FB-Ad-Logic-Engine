# 项目总结：2026-02-11 Route 1 字段补齐与 purchase_value 根因修复

本窗口定位并修复了「Today 同步走 Insights First 路径时 purchase_value 必为 0」的根因：Route 1 的 `getAdInsights()` 未请求 action_values 等 ROI 核心字段。补齐后 SQL 验证 cnt_bad=0，规则 roas 判定恢复正常。

---

## 一、项目目标与范围

- **目标**：解决「库里 purchase_value=0 导致 roas 判定失效、规则不触发」的问题。
- **范围**：`server/index.js` 的 `FacebookMarketingAPI.getAdInsights()` 字段集、mapItem 映射、降级 fallbackFields。

---

## 二、遇到的问题

### 2.1 现象

- 库里 `ad_snapshots.purchase_value = 0`，而 Facebook API（Graph API Explorer）显示同一广告当天 `action_values` 有购买金额（如 79.24）。
- 规则条件如 `spend > 10 AND roas > 5` 不触发：spend 满足，但 roas 被读侧算成 0（因为 purchase_value=0），不满足。
- 日志频繁出现：`[ROAS] purchases>0 且 purchase_value=0 且 api_roas=null`。

### 2.2 可能原因排查

| 可能原因 | 排查结论 |
|----------|----------|
| 归因延迟（同步时刻 FB 未回填 action_values） | 非主因；日志显示请求本身未带 action_values |
| Batch 响应与单条 GET 结构不一致 | 非主因；问题出在 Route 1 单条 GET |
| extractPurchaseValue 白名单或解析逻辑错误 | 非主因；请求未返回 action_values，解析无从谈起 |

### 2.3 根因定位

- **Today 同步有两条路径**：
  - **Route 1（Insights First）**：`syncAccountTodayStats` → `facebookApi.getAdInsights()` → GET `/act_xxx/insights?fields=...`
  - **Route 2（Batch）**：`syncAccountSlidingWindowStats` → `fetchInsightsInBatches` → POST Batch，fields 已含 action_values。
- **日志证据**：用户日志中出现的 `GET /v24.0/act_xxx/insights?fields=...` 的 `fields` **不包含** `action_values`、`purchase_roas`、`website_purchase_roas`。
- **结论**：Route 1 的 `getAdInsights()` 默认 fullFields 缺 ROI 核心字段，导致 `insight.action_values` 为 undefined，`extractPurchaseValue(undefined)` 返回 0，写库 purchase_value 必为 0。

---

## 三、解决方法

### 3.1 修改文件

`server/index.js` 的 `getAdInsights()`：

1. **fullFields 补齐**：增加 `action_values`、`cost_per_action_type`、`purchase_roas`、`website_purchase_roas`。
2. **fallbackFields 定义**：将原 lightFields 改为 fallbackFields，去掉 ctr/cpc/cpm 等非核心展示字段，**保留 ROI 核心字段**（actions、action_values、purchase_roas、website_purchase_roas），确保字段无效降级时仍能拿到 purchase_value。
3. **mapItem 透传**：在返回对象中增加 `action_values`、`cost_per_action_type`、`purchase_roas`、`website_purchase_roas`，供 ingestorService 的 saveSnapshotsToDbInternal 解析。
4. **limit 可配置**：支持 `options.limit`，默认 200。

### 3.2 改前改后

| 项 | 改前 | 改后 |
|----|------|------|
| fullFields | 无 action_values、purchase_roas、website_purchase_roas | 含 action_values、cost_per_action_type、purchase_roas、website_purchase_roas |
| 降级字段集 | lightFields 无 ROI 核心字段 | fallbackFields 保留 ROI 核心字段 |
| mapItem | 无 action_values、roas 相关 | 透传 action_values、cost_per_action_type、purchase_roas、website_purchase_roas |

---

## 四、验收结果

- ✅ **SQL 验证**：`SELECT COUNT(*) FROM ad_snapshots WHERE data_date=CURDATE() AND purchases>0 AND (purchase_value IS NULL OR purchase_value=0)` → **cnt_bad=0**。
- ✅ **抽样验证**：有购买的广告 purchase_value 均非 0（如 79.24、146.30 等）。
- ✅ **指定广告**：此前问题广告（如 120236941795230501）purchase_value 从 0 变为 79.24。
- ✅ **日志**：`[ROAS] purchases>0 且 purchase_value=0 且 api_roas=null` 的 warn 不再出现（或显著减少）。
- ✅ **单测**：ingestorService.test.js 全部通过。

---

## 五、影响与项目进度

- **直接解决**：Today 数据缺 ROI 字段 → purchase_value 落库为 0 → roas=0 → 规则不触发。
- **与方案 A 的关系**：ROAS 方案 A（写侧不存派生 roas、读侧计算）已落地；本窗口修的是「数据来源」——Route 1 必须把 action_values 等请求回来，否则方案 A 无法生效。

---

## 六、相关文档更新

本窗口已对下列文档执行更新：

- **TASKS.md**：最新更新改为 Route 1 字段补齐；1.2 新增「Route 1（Insights First）字段完整性」完成项。
- **DEV_PLAN.md**：最新进度补充 Route 1 字段补齐与 purchase_value 根因修复；M2 补充「Route 1 字段完整性」完成说明。

---

## 七、验证 SQL（备忘）

```sql
-- 1. 今日有购买但 purchase_value=0 的广告数（应=0）
SELECT COUNT(*) AS cnt_bad
FROM ad_snapshots
WHERE data_date = CURDATE()
  AND purchases > 0
  AND (purchase_value IS NULL OR purchase_value = 0);

-- 2. 抽查有购买的广告
SELECT account_id, ad_id, spend, purchases, purchase_value, roas
FROM ad_snapshots
WHERE data_date = CURDATE() AND purchases > 0
ORDER BY spend DESC LIMIT 20;
```
