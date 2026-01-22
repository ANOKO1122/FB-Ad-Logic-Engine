# 方案 B+ 优化版（最终版）

> 已采纳所有建议优化，包括：冷数据落盘口径、操作元数据字段、时间窗口命名一致性、时区一致性、归因设置口径、索引与约束、分母为零防护

---

## 一、架构概览

```
规则引擎执行流程
    ↓
解析规则时间窗口
    ↓
智能路由选择数据源
    ↓
从数据库查询数据（完全离线）
    ↓
动态聚合计算（仅多天场景）
    ↓
评估规则条件 (AND/OR)
    ↓
执行动作 (Dry Run/Real)
```

---

## 二、数据库层：新增字段与索引

### 2.1 新增 6 个核心原始计数字段

| 字段名 | 类型 | 数据来源（已校正） | 说明 |
|--------|------|-------------------|------|
| `link_clicks` | INT | `inline_link_clicks`（Insights 专用字段） | 链接点击次数（CPC 分母） |
| `unique_link_clicks` | INT | `unique_inline_link_clicks`（Insights 专用字段） | 独立链接点击次数（uCPC 分母） |
| `purchase_value` | DECIMAL(10,2) | `action_values` 中提取 `offsite_conversion.fb_pixel_purchase.value` | 购买总转化金额（ROAS 分子） |
| `add_to_cart_count` | INT | `actions` 中提取（兼容多种变体） | 加购次数（加购费分母） |
| `initiate_checkout_count` | INT | `actions` 中提取（兼容多种变体） | 发起结账次数（结账费分母） |
| `add_payment_info_count` | INT | `actions` 中提取（兼容多种变体） | 添加支付信息次数（支付费分母） |

### 2.2 新增操作元数据字段

| 字段名 | 类型 | 说明 |
|--------|------|------|
| `ad_set_id` | VARCHAR(50) | 广告组 ID（用于规则动作：增减预算需要 adset_id） |

**理由**：规则动作如增减预算需要 `adset_id`，避免在规则执行时额外查询 Ads API。

### 2.3 索引与约束（性能优化）

#### ad_snapshots 表索引
```sql
-- 多天窗口高效聚合
CREATE INDEX `idx_account_synced` ON `ad_snapshots` (`account_id`, `synced_at`);
CREATE INDEX `idx_ad_synced` ON `ad_snapshots` (`ad_id`, `synced_at`);

-- 最后快照查询（降级策略）
CREATE INDEX `idx_ad_synced_desc` ON `ad_snapshots` (`ad_id`, `synced_at` DESC);
```

#### daily_stats 表索引
```sql
-- 多天窗口高效聚合
CREATE INDEX `idx_account_date` ON `daily_stats` (`account_id`, `date`);
CREATE INDEX `idx_ad_date` ON `daily_stats` (`ad_id`, `date`);
```

---

## 三、冷数据落盘口径（重要修正）

### 3.1 问题说明

**错误做法**：对同一日的多次快照求和（SUM）
- 问题：快照是累计值，对快照求 SUM 会发生"重复累计"（严重高估）
- 示例：10:00 快照显示花费 $100，14:00 快照显示花费 $150
  - 错误：SUM = $100 + $150 = $250（错误！）
  - 正确：应该取最后一次快照 = $150

### 3.2 正确做法（已修正）

**每日归档取"每个广告当日的最后快照"作为当日值**

```sql
-- 冷数据落盘查询（已修正）
SELECT 
  account_id,
  ad_id,
  ad_name,
  ad_set_id,              -- 新增：广告组 ID
  owner_id,
  -- 取最后一次快照的值（不是 SUM）
  spend,                  -- 最后一次快照的 spend
  purchases,              -- 最后一次快照的 purchases
  link_clicks,            -- 最后一次快照的 link_clicks
  unique_link_clicks,      -- 最后一次快照的 unique_link_clicks
  purchase_value,          -- 最后一次快照的 purchase_value
  add_to_cart_count,       -- 最后一次快照的 add_to_cart_count
  initiate_checkout_count, -- 最后一次快照的 initiate_checkout_count
  add_payment_info_count,  -- 最后一次快照的 add_payment_info_count
  -- 其他字段...
FROM (
  SELECT *,
    ROW_NUMBER() OVER (
      PARTITION BY account_id, ad_id 
      ORDER BY synced_at DESC
    ) as rn
  FROM ad_snapshots
  WHERE DATE(synced_at) = ?  -- 目标日期
) ranked
WHERE rn = 1  -- 只取最后一次快照
```

**关键点**：
- 使用 `ROW_NUMBER() OVER (PARTITION BY account_id, ad_id ORDER BY synced_at DESC)` 获取每个广告的最后一次快照
- 不使用 `SUM()`，直接使用最后一次快照的值

---

## 四、时间窗口命名一致性（已统一）

### 4.1 统一命名规范

**文档和代码统一使用**：
- ✅ `today` - 今天
- ✅ `yesterday` - 昨天
- ✅ `last_3_days` - 过去 3 天（不是 `last_3d`）
- ✅ `last_7_days` - 过去 7 天（不是 `last_7d`）
- ✅ `lifetime` - 累计至今

**避免使用**：
- ❌ `last_3d`、`last_7d`（简写形式，容易产生歧义）

---

## 五、时区一致性（已统一）

### 5.1 时区获取策略

**统一从账户配置/映射表取时区**：

```javascript
// 时区获取逻辑（已统一）
async function getAccountTimezone(accountId) {
  // 从 account_mappings 表获取时区
  const [rows] = await pool.execute(
    `SELECT COALESCE(timezone_name, 'UTC') as timezone_name 
     FROM account_mappings 
     WHERE fb_account_id = ? AND is_active = 1`,
    [accountId]
  )
  
  if (rows.length === 0) {
    return 'UTC'  // 默认时区
  }
  
  return rows[0].timezone_name
}
```

**应用场景**：
- 路由选择：根据账户时区判断是否在 06:00 前
- 冷数据落盘：根据账户时区计算"昨日"边界
- 时间窗口计算：根据账户时区计算日期范围

---

## 六、归因设置口径（已明确）

### 6.1 Insights 请求显式开启归因设置

```javascript
// Facebook API 请求参数（已优化）
const params = {
  fields: 'ad_id,ad_name,spend,inline_link_clicks,unique_inline_link_clicks,actions,action_values,...',
  date_preset: 'today',
  // 显式开启账户归因设置（重要！）
  use_account_attribution_setting: true,  // 确保与账户归因口径一致
  access_token: this.accessToken
}
```

**理由**：
- 确保 `purchase` 和 `action_values` 的归因口径与账户设置一致
- 避免不同归因窗口导致的数据不一致

---

## 七、计算与聚合规则（已优化）

### 7.1 单价/比率类指标（必须动态重算，仅多天场景）

**多天窗口必须用"总分子/总分母"重算，避免辛普森悖论**：

```javascript
// 多天聚合计算公式（已优化，含除零保护）
function aggregateMultiDayMetrics(dailyStatsArray) {
  // 1. 累加原始计数（分子和分母）
  const totals = dailyStatsArray.reduce((acc, day) => ({
    totalSpend: acc.totalSpend + parseFloat(day.spend || 0),
    totalPurchases: acc.totalPurchases + parseInt(day.purchases || 0),
    totalLinkClicks: acc.totalLinkClicks + parseInt(day.link_clicks || 0),
    totalUniqueLinkClicks: acc.totalUniqueLinkClicks + parseInt(day.unique_link_clicks || 0),
    totalPurchaseValue: acc.totalPurchaseValue + parseFloat(day.purchase_value || 0),
    totalAddToCartCount: acc.totalAddToCartCount + parseInt(day.add_to_cart_count || 0),
    totalInitiateCheckoutCount: acc.totalInitiateCheckoutCount + parseInt(day.initiate_checkout_count || 0),
    totalAddPaymentInfoCount: acc.totalAddPaymentInfoCount + parseInt(day.add_payment_info_count || 0)
  }), {
    totalSpend: 0,
    totalPurchases: 0,
    totalLinkClicks: 0,
    totalUniqueLinkClicks: 0,
    totalPurchaseValue: 0,
    totalAddToCartCount: 0,
    totalInitiateCheckoutCount: 0,
    totalAddPaymentInfoCount: 0
  })
  
  // 2. 动态重算单价/比率类指标（含除零保护）
  return {
    // 绝对值指标（直接使用累加值）
    spend: totals.totalSpend,
    purchases: totals.totalPurchases,
    
    // 单价/比率类指标（必须重算，含除零保护）
    roas: totals.totalSpend > 0 ? totals.totalPurchaseValue / totals.totalSpend : 0,
    cpa: totals.totalPurchases > 0 ? totals.totalSpend / totals.totalPurchases : 0,
    cpc: totals.totalLinkClicks > 0 ? totals.totalSpend / totals.totalLinkClicks : 0,
    ucpc: totals.totalUniqueLinkClicks > 0 ? totals.totalSpend / totals.totalUniqueLinkClicks : 0,
    addToCartCost: totals.totalAddToCartCount > 0 ? totals.totalSpend / totals.totalAddToCartCount : 0,
    checkoutCost: totals.totalInitiateCheckoutCount > 0 ? totals.totalSpend / totals.totalInitiateCheckoutCount : 0,
    paymentCost: totals.totalAddPaymentInfoCount > 0 ? totals.totalSpend / totals.totalAddPaymentInfoCount : 0
  }
}
```

### 7.2 单天场景计算（含除零保护）

```javascript
// 单天：直接使用数据库中的值，但计算时需要除零保护
function calculateSingleDayMetrics(dailyStats) {
  return {
    // 绝对值指标（直接使用）
    spend: parseFloat(dailyStats.spend || 0),
    purchases: parseInt(dailyStats.purchases || 0),
    
    // 单价/比率类指标（单天计算，含除零保护）
    roas: dailyStats.spend > 0 ? (dailyStats.purchase_value || 0) / dailyStats.spend : 0,
    cpa: dailyStats.purchases > 0 ? dailyStats.spend / dailyStats.purchases : 0,
    cpc: dailyStats.link_clicks > 0 ? dailyStats.spend / dailyStats.link_clicks : 0,
    ucpc: dailyStats.unique_link_clicks > 0 ? dailyStats.spend / dailyStats.unique_link_clicks : 0,
    addToCartCost: dailyStats.add_to_cart_count > 0 ? dailyStats.spend / dailyStats.add_to_cart_count : 0,
    checkoutCost: dailyStats.initiate_checkout_count > 0 ? dailyStats.spend / dailyStats.initiate_checkout_count : 0,
    paymentCost: dailyStats.add_payment_info_count > 0 ? dailyStats.spend / dailyStats.add_payment_info_count : 0
  }
}
```

**关键点**：
- 单天计算也要做除零保护，避免 NaN/Infinity 传播
- 特别是 UI 展示层，必须处理除零情况

---

## 八、时间窗口智能路由（已优化）

### 8.1 路由规则（已统一命名）

```javascript
// 智能路由逻辑（已优化，统一命名）
function selectDataSource(timeWindow, timezoneName) {
  switch (timeWindow) {
    case 'today':
      // Today → ad_snapshots（热数据，毫秒级响应）
      return { 
        source: 'ad_snapshots', 
        needAggregation: false,  // 单天不需要聚合
        useApiValues: true       // 展示时可优先用 API 值
      }
    
    case 'yesterday':
      // Yesterday → daily_stats（冷数据，06:00 归档）
      // 06:00 前降级到 ad_snapshots
      if (isBeforeArchiveTime(timezoneName)) {
        return { 
          source: 'ad_snapshots', 
          needAggregation: false,  // 单天不需要聚合
          fallback: true 
        }
      }
      return { 
        source: 'daily_stats', 
        needAggregation: false   // 单天不需要聚合
      }
    
    case 'last_3_days':  // 统一命名（不是 last_3d）
    case 'last_7_days':   // 统一命名（不是 last_7d）
    case 'lifetime':
      // 多天窗口 → daily_stats（冷数据，已聚合）
      // 必须动态重算单价/比率类指标
      return { 
        source: 'daily_stats', 
        needAggregation: true    // 多天需要聚合
      }
    
    default:
      throw new Error(`不支持的时间窗口类型: ${timeWindow}`)
  }
}
```

### 8.2 06:00 边界降级策略（已优化，使用账户时区）

```javascript
// 06:00 边界降级（已优化，使用账户时区）
async function queryYesterdayData(accountId, timezoneName) {
  // 1. 从账户映射表获取时区（如果未提供）
  if (!timezoneName) {
    timezoneName = await getAccountTimezone(accountId)
  }
  
  // 2. 先尝试查 daily_stats
  const dailyData = await queryDailyStats(accountId, 'yesterday', timezoneName)
  
  if (dailyData.length > 0) {
    return dailyData  // 有数据，直接返回（单天，无需聚合）
  }
  
  // 3. 检查是否在 06:00 前（账户时区）
  const now = DateTime.now().setZone(timezoneName)
  const archiveTime = now.set({ hour: 6, minute: 0, second: 0 })
  
  if (now < archiveTime) {
    // 4. 降级：查 ad_snapshots 中昨天的最后一条快照
    console.log('⚠️  daily_stats 未落盘，降级查询 ad_snapshots（误差约 0.7%-1%）')
    const fallbackData = await queryAdSnapshotsFallback(accountId, 'yesterday', timezoneName)
    
    // 注意：降级数据是单天，无需聚合，直接使用
    return fallbackData
  }
  
  // 5. 如果已经过了 06:00 还没数据，可能是异常
  console.error('❌ daily_stats 应该已落盘，但查询不到数据')
  return []
}
```

---

## 九、数据抓取层优化（Ingestor - 已优化）

### 9.1 Facebook API 请求字段（已更新）

```javascript
// Batch API 请求字段（已更新，含归因设置）
const fields = [
  'ad_id',
  'ad_name',
  'adset_id',                    // 新增：广告组 ID（用于规则动作）
  'spend',
  'cpc',                         // 当天展示用（不入库）
  'roas',                        // 当天展示用（不入库）
  'actions',
  'action_values',
  'cost_per_action_type',
  'cost_per_unique_link_click',
  'cost_per_unique_inline_link_click',
  // 新增：用于提取原始计数
  'inline_link_clicks',              // link_clicks 的来源
  'unique_inline_link_clicks'        // unique_link_clicks 的来源
].join(',')

// 请求参数（已优化，显式开启归因设置）
const params = {
  fields: fields,
  date_preset: 'today',
  // 显式开启账户归因设置（重要！）
  use_account_attribution_setting: true,  // 确保与账户归因口径一致
  access_token: this.accessToken
}
```

### 9.2 提取原始计数字段（已校正）

```javascript
// 提取原始计数字段（已校正）
function extractRawCountFields(insight) {
  return {
    // 1. link_clicks：使用 inline_link_clicks（Insights 专用字段）
    link_clicks: parseInt(insight.inline_link_clicks || 0),
    
    // 2. unique_link_clicks：使用 unique_inline_link_clicks（Insights 专用字段）
    unique_link_clicks: parseInt(insight.unique_inline_link_clicks || 0),
    
    // 3. purchase_value：从 action_values 中提取
    purchase_value: extractPurchaseValue(insight.action_values),
    
    // 4-6. 从 actions 中提取（兼容多种变体）
    add_to_cart_count: extractActionCount(insight.actions, [
      'offsite_conversion.fb_pixel_add_to_cart',
      'add_to_cart'
    ]),
    
    initiate_checkout_count: extractActionCount(insight.actions, [
      'offsite_conversion.fb_pixel_initiate_checkout',
      'initiate_checkout'
    ]),
    
    add_payment_info_count: extractActionCount(insight.actions, [
      'offsite_conversion.fb_pixel_add_payment_info',
      'add_payment_info'
    ])
  }
}
```

---

## 十、实现步骤（分阶段）

### 阶段 1：数据库迁移（新增字段与索引）

创建迁移脚本：`003_add_raw_count_fields_and_indexes.sql`

```sql
-- ============================================
-- 第一部分：为 ad_snapshots 表添加字段
-- ============================================

-- 新增 6 个原始计数字段
ALTER TABLE `ad_snapshots`
ADD COLUMN `link_clicks` INT DEFAULT 0 COMMENT '链接点击次数（CPC分母）',
ADD COLUMN `unique_link_clicks` INT DEFAULT 0 COMMENT '独立链接点击次数（uCPC分母）',
ADD COLUMN `purchase_value` DECIMAL(10,2) DEFAULT 0.00 COMMENT '购买总转化金额（ROAS分子）',
ADD COLUMN `add_to_cart_count` INT DEFAULT 0 COMMENT '加购次数（加购费分母）',
ADD COLUMN `initiate_checkout_count` INT DEFAULT 0 COMMENT '发起结账次数（结账费分母）',
ADD COLUMN `add_payment_info_count` INT DEFAULT 0 COMMENT '添加支付信息次数（支付费分母）';

-- 新增操作元数据字段
ALTER TABLE `ad_snapshots`
ADD COLUMN `ad_set_id` VARCHAR(50) COMMENT '广告组ID（用于规则动作：增减预算）';

-- 新增索引（性能优化）
CREATE INDEX `idx_account_synced` ON `ad_snapshots` (`account_id`, `synced_at`);
CREATE INDEX `idx_ad_synced` ON `ad_snapshots` (`ad_id`, `synced_at`);
CREATE INDEX `idx_ad_synced_desc` ON `ad_snapshots` (`ad_id`, `synced_at` DESC);

-- ============================================
-- 第二部分：为 daily_stats 表添加字段
-- ============================================

-- 新增 6 个原始计数字段
ALTER TABLE `daily_stats`
ADD COLUMN `link_clicks` INT DEFAULT 0 COMMENT '链接点击次数（CPC分母）',
ADD COLUMN `unique_link_clicks` INT DEFAULT 0 COMMENT '独立链接点击次数（uCPC分母）',
ADD COLUMN `purchase_value` DECIMAL(10,2) DEFAULT 0.00 COMMENT '购买总转化金额（ROAS分子）',
ADD COLUMN `add_to_cart_count` INT DEFAULT 0 COMMENT '加购次数（加购费分母）',
ADD COLUMN `initiate_checkout_count` INT DEFAULT 0 COMMENT '发起结账次数（结账费分母）',
ADD COLUMN `add_payment_info_count` INT DEFAULT 0 COMMENT '添加支付信息次数（支付费分母）';

-- 新增操作元数据字段
ALTER TABLE `daily_stats`
ADD COLUMN `ad_set_id` VARCHAR(50) COMMENT '广告组ID（用于规则动作：增减预算）';

-- 新增索引（性能优化）
CREATE INDEX `idx_account_date` ON `daily_stats` (`account_id`, `date`);
CREATE INDEX `idx_ad_date` ON `daily_stats` (`ad_id`, `date`);
```

### 阶段 2：更新 Ingestor（提取原始计数）

更新 `server/services/ingestorService.js`：
- 从 `inline_link_clicks` 和 `unique_inline_link_clicks` 提取
- 从 `action_values` 提取 `purchase_value`
- 从 `actions` 提取三个 count 字段（兼容多种变体）
- 提取 `adset_id`（广告组 ID）
- 显式开启 `use_account_attribution_setting: true`
- 写入 `ad_snapshots` 表

### 阶段 3：更新冷数据落盘（取最后快照）

更新 `archiveDailyStats` 函数：
- **重要修正**：取每个广告当日的最后快照（不是 SUM）
- 使用 `ROW_NUMBER() OVER (PARTITION BY account_id, ad_id ORDER BY synced_at DESC)` 
- 写入 `daily_stats` 表（包含 6 个原始计数字段和 `ad_set_id`）

### 阶段 4：创建规则数据查询服务

创建 `server/services/ruleDataService.js`：
- 实现智能路由逻辑（today → ad_snapshots，历史 → daily_stats）
- 实现 06:00 边界降级（使用账户时区）
- 实现动态聚合计算（仅多天场景，含除零保护）
- 统一时间窗口命名（`last_3_days`、`last_7_days`）

### 阶段 5：增强 RuleEngine

更新 `server/index.js` 中的 `RuleEngine` 类：
- 支持从数据库查询数据（完全离线）
- 支持 AND/OR 逻辑运算符
- 支持 `target_level` 和 `target_ids` 筛选
- 支持单天/多天的不同处理逻辑（含除零保护）
- 使用 `ad_set_id` 执行预算调整动作

### 阶段 6：更新 cronService

更新 `server/services/cronService.js`：
- 使用新的规则数据查询服务
- 集成时间窗口逻辑
- 统一从账户映射表获取时区

---

## 十一、关键设计决策（已明确）

### 11.1 冷数据落盘口径（重要修正）

**错误做法**：对同一日的多次快照求和（SUM）
- 问题：快照是累计值，对快照求 SUM 会发生"重复累计"（严重高估）

**正确做法**：取每个广告当日的最后快照
- 使用 `ROW_NUMBER() OVER (PARTITION BY account_id, ad_id ORDER BY synced_at DESC)`
- 只取 `rn = 1` 的记录（最后一次快照）

### 11.2 单天 vs 多天的处理逻辑

- **单天（today/yesterday）**：
  - 直接使用数据库中的值，无需重算
  - 但计算时需要除零保护（避免 NaN/Infinity）

- **多天（last_3_days/last_7_days/lifetime）**：
  - 必须动态重算单价/比率类指标
  - 使用"总分子/总分母"公式，避免辛普森悖论
  - 含除零保护

### 11.3 时区一致性

- 统一从 `account_mappings` 表获取时区
- 路由选择、冷数据落盘、时间窗口计算都使用账户时区
- 避免跨日边界偏差

### 11.4 归因设置口径

- Insights 请求显式开启 `use_account_attribution_setting: true`
- 确保 `purchase` 和 `action_values` 的归因口径与账户设置一致

### 11.5 分母为零防护

- 单天计算也要做除零保护
- 多天聚合也要做除零保护
- 避免 NaN/Infinity 传播到 UI 展示层

---

## 十二、数据流示例

### 场景 1：Today 时间窗口

```
规则条件：spend > 20 && purchases < 1 (time_window: 'today')
         ↓
智能路由：today → ad_snapshots（使用账户时区）
         ↓
查询数据：SELECT * FROM ad_snapshots 
         WHERE account_id = ? 
         AND DATE(synced_at) = CURDATE()  -- 基于账户时区
         ↓
单天数据：直接使用，无需聚合（含除零保护）
         ↓
评估条件：spend = 25.5 > 20 ✅, purchases = 0 < 1 ✅
         ↓
执行动作：pause_ad（使用 ad_set_id，无需额外查询）
```

### 场景 2：Last 3 Days 时间窗口

```
规则条件：roas < 1.5 (time_window: 'last_3_days')
         ↓
智能路由：last_3_days → daily_stats（使用账户时区）
         ↓
查询数据：SELECT * FROM daily_stats 
         WHERE account_id = ? 
         AND date >= DATE_SUB(CURDATE(), INTERVAL 3 DAY)  -- 基于账户时区
         ↓
多天数据：需要聚合计算（含除零保护）
         - total_spend = 100 + 50 + 30 = 180
         - total_purchase_value = 150 + 40 + 20 = 210
         - roas = 210 / 180 = 1.17（含除零保护）
         ↓
评估条件：roas = 1.17 < 1.5 ✅
         ↓
执行动作：pause_ad（使用 ad_set_id，无需额外查询）
```

---

## 十三、需要你确认

1. **是否同意此最终优化版方案 B+？**
2. **数据库迁移策略**：
   - 方案 A：直接 ALTER TABLE（开发环境）
   - 方案 B：创建迁移脚本（生产环境推荐）
3. **如果同意，我将**：
   - 先创建数据库迁移脚本（不执行）
   - 然后更新 Ingestor（提取原始计数，使用校正后的字段来源）
   - 更新冷数据落盘（取最后快照，不是 SUM）
   - 每完成一步都会询问你的意见

请确认是否开始实现，以及数据库迁移策略（方案 A 还是 B）。

---

## 十四、ROW_NUMBER 兼容方案与性能注意（不删减原有方案，补充兼容与优化）

### 14.1 非 MySQL 8.0 兼容实现（最大时间戳连接法）

在不支持窗口函数的环境中，可用“最大时间戳连接法”实现“当日最后快照”的取值（与第 3 章口径完全一致）：

```sql
-- 步骤1：取每个广告当日的最大 synced_at（最后快照时间）
WITH last_snap AS (
  SELECT 
    account_id,
    ad_id,
    MAX(synced_at) AS last_synced_at
  FROM ad_snapshots
  WHERE DATE(synced_at) = ?
  GROUP BY account_id, ad_id
)
-- 步骤2：用最后时间点连接原表，获取该时间点的完整字段（即“最后快照”的值）
SELECT 
  s.account_id,
  s.ad_id,
  s.ad_name,
  s.ad_set_id,
  s.owner_id,
  s.spend,
  s.purchases,
  s.link_clicks,
  s.unique_link_clicks,
  s.purchase_value,
  s.add_to_cart_count,
  s.initiate_checkout_count,
  s.add_payment_info_count
FROM ad_snapshots s
JOIN last_snap t
  ON s.account_id = t.account_id
 AND s.ad_id = t.ad_id
 AND s.synced_at = t.last_synced_at;
```

该方案与 `ROW_NUMBER() OVER (...) WHERE rn=1` 等价，适合生产库版本不统一的情况。

### 14.2 索引与执行计划建议

为确保上述查询在大表上稳定运行，建议在 `ad_snapshots` 表补充或确认如下索引（与第 2.3 节一致，此处强调其查询用途）：

```sql
CREATE INDEX idx_account_synced ON ad_snapshots (account_id, synced_at);
CREATE INDEX idx_ad_synced ON ad_snapshots (ad_id, synced_at);
CREATE INDEX idx_ad_synced_desc ON ad_snapshots (ad_id, synced_at DESC);
```

- 作用：加速“最大时间戳”与“最后快照”查询；同时提升“昨日降级至 ad_snapshots”路由的检索效率。
- 注意：使用 DESC 索引可以让“最后快照”更快命中。

### 14.3 06:00 边界与降级策略细化

- 冷数据落盘在账户时区 06:00 固化昨日数据；若 `daily_stats` 暂不可用时，UI 或查询服务应按账户时区降级到 `ad_snapshots` 并选择“昨日的最后快照”（误差约 0.7%-1%，已在第 8 章说明）。
- 该降级查询同样适用上面的两种实现（窗口函数或最大时间戳连接）。

---

## 十五、应用日志与轮转（Winston + DailyRotateFile，不删减原有内容的补充说明）

为配合“反馈与监控层（M5）”与全链路可观测性，建议接入应用日志文件轮转，职责与审计日志分离：

### 15.1 职责分离

- 应用日志（文件）：记录服务运行、频率与熔断、异常与未处理拒绝等技术事件；按天轮转，便于运维排障。
- 审计日志（数据库 automation_logs）：记录每次规则触发的业务上下文与 API 原文，便于业务回溯。

### 15.2 技术选型与策略

- 选型：winston + winston-daily-rotate-file
- 文件：
  - combined-YYYY-MM-DD.log：info 级别综合日志
  - error-YYYY-MM-DD.log：error 级别错误日志
  - exceptions-YYYY-MM-DD.log：未捕获异常
  - rejections-YYYY-MM-DD.log：未处理 Promise 拒绝
- 轮转与保留：按天切割；保留最近 14 天；可开启压缩
- 分级与结构：JSON 格式，开发环境同时输出彩色控制台；生产环境写文件
- 安全：生产不打印 Token 前缀；敏感信息屏蔽

### 15.3 接入点与验收

- 接入点：服务启动、cron、ingestor、频率自适应与熔断、API 路由、规则执行入口
- 验收：
  - 日志文件按日期生成且内容分级
  - 发生错误与异常时对应文件存在记录
  - 超过 14 天的日志按策略自动清理
  - 频率过载与熔断事件产生日志并可检索

---

## 十六、阶段 3 细化与验收（不删原有分阶段，补充执行细则）

### 16.1 执行细则补充

- 实现“当日最后快照”取值：
  - MySQL 8.0+：使用 `ROW_NUMBER() OVER (PARTITION BY account_id, ad_id ORDER BY synced_at DESC)` 取 `rn=1`
  - 非 8.0：使用“最大时间戳连接法”（见第 14 章）
- 时区与日期边界：
  - 使用账户 `timezone_name` 计算“昨日”自然日边界；06:00 固化策略与降级路由保持一致
- 字段覆盖：
  - 冷数据 `daily_stats` 写入 6 个原始计数字段与 `ad_set_id`，为后续规则与预算动作提供离线数据基础

### 16.2 验收补充

- 对同一广告同日多次快照，`daily_stats` 当日值应等于“最后快照”的值，而非 SUM
- 跨时区账户在“昨日”边界的选择正确（含 06:00 前后场景）
- 查询服务在 `daily_stats` 缺席时进行降级且误差控制在约 0.7%-1%

