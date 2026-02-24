# 📋 FB Ad-Intelligence 系统改善方案（完整版 v4.9）

> **适用场景**：小型跨境电商公司内部使用，36 个广告账户，十几人使用
> 
> **v4.9 更新**：完善热路径/冷路径分离设计、增加 12:00-12:09 深度对账、明确状态表流转逻辑
> 
> ⚠️ **代码示例说明**：本文档中的 `db.query` 示例按 **mysql2** 写法，返回值为 `[rows, fields]`。如使用其他 DB 库，请按实际 API 调整解包方式。

---

## 📌 文档状态说明（重要）

> 本文档是**实施蓝图**，包含"已实现"和"待实现"两类内容。请注意以下标记：
> 
> | 标记 | 含义 |
> |------|------|
> | ✅ **已实现** | 当前代码已落地 |
> | 🚧 **待实现** | 规划目标，代码尚未落地 |
> | 🔴 **紧急修复** | 当前代码存在风险，需优先处理 |

### 🔴 紧急修复项汇总（必须优先处理）

| # | 问题 | 风险 | 涉及文件 | 修复方案 |
|---|------|------|----------|----------|
| 1 | **GET_LOCK 用 pool.execute 导致连接不一致** | 锁泄漏、任务被莫名跳过 | `cronService.js`, `ingestorService.js` | 改为 `pool.getConnection()` + 专用连接 |
| 2 | **归档锁未统一** | 快照归档和 API 回补可能冲突 | `cronService.js` | 使用同一把 `archive:${accountId}:${date}` 锁 |

> ⚠️ 这两个问题如果不修复，7x24 无人值守运行时可能出现"莫名其妙长期跳过任务/锁占用"的事故。

### 🚧 待实现功能汇总（按优先级排序）

| # | 功能 | 当前状态 | 目标 | 优先级 |
|---|------|----------|------|--------|
| 1 | **双窗口归档（AdsPolar 模式）** | 12:00 延迟归档（跨时区最长 23 小时） | 每 10 分钟巡检，账户本地 02:00-02:09（初步）和 12:00-12:09（对账）触发 | 🔴 高 |
| 2 | **Insights First 性能优化** | 拉取全量广告 | 只拉 spend>0 的广告 | 🔴 高 |
| 3 | **统一主同步任务 + 15 分钟频率** | 多个独立任务，10 分钟 | 统一任务，15 分钟 | 🔴 高 |
| 4 | **分层回补（智能决策 + 内存分流）** | 无分层逻辑 | 根据时间点选择 last_3d/last_7d | 🔴 高 |
| 5 | **include_today 可配置开关** | 默认含今天，不可配置 | rules 表增字段，可按规则配置 | 🟡 中 |
| 6 | **健康检查 + 告警** | 无实现 | 每日检查 + 钉钉/飞书通知 | 🟡 中 |
| 7 | **归档状态表（可选）** | 已有完整性检查 | 增加可观测性/可追溯 | 🟢 低 |
| 8 | **周末 last_14d 保底回补** | 无实现 | 周六 03:15 拉 last_14d | 🟢 低 |
| 9 | **ad_snapshots 改 AdsPolar 热表（中期优化）** | 多快照追加，需 ROW_NUMBER() 查询 | 加 data_date，每天一行覆盖写 | 🟢 低（中期） |

> **说明**：
> - ✅ **双表合并能力已实现**：`queryMultiDayWithToday()` 已能合并 ad_snapshots + daily_stats
> - ✅ **重复归档已缓解**：归档前有完整性检查（expectedCount vs archivedCount），完整则跳过
> - ⚠️ **当前归档延迟问题**：12:00 一刀切导致跨时区账户延迟最长 23 小时，需优先修复

---

## 一、🎯 核心设计理念

### AdsPolar 的四大核心原则

| 原则 | 说明 | 你的系统现状 |
|------|------|-------------|
| 数据衰减刷新 | 离今天越近查得越勤，越远查得越懒 | ❌ 每30分钟拉7天 |
| 包含关系 | `last_7d` 已包含 `today`，不需要两个请求 | ❌ 分开请求 |
| 内存分流 | 一次请求拿回数据，按日期分发到不同表 | ❌ 未实现 |
| 统一心跳 | 只有一个主同步任务，通过时间判断切换模式 | ❌ 多个独立任务 |

---

## 二、⏰ 分层回补设计（The Layered Backfill）

> ⚠️ **重要概念区分**：
> - **API 回补**：从 Facebook API 拉取历史数据，更新 `daily_stats` 表（修复归因延迟）
> - **快照归档**：从 `ad_snapshots` 读取昨日最后快照，写入 `daily_stats` 表
> 
> 本节描述的是 **API 回补**，快照归档见 11.3 节。两者都写入 `daily_stats`，通过唯一索引 `(account_id, ad_id, date)` 和 `ON DUPLICATE KEY UPDATE` 保证幂等。

### 数据的"半衰期"特性

| 数据类型 | 时间范围 | 变化频率 | 刷新策略 |
|----------|----------|----------|----------|
| 🔥 热数据 | 今天 | 每分钟都在变 | 每 **15 分钟** |
| 🌡️ 温数据 | 昨天~前天 | 每小时可能变 | 每 **4-6 小时** |
| 🧊 冷数据 | 3-7 天前 | 基本定型 | 每天 **1 次** |

### 三层 API 回补任务（挂载在统一心跳 Cron 中）

> 以下任务都是 **API 回补**：从 Facebook API 拉取数据，按日期分流写入对应表。

| 层级 | 任务名 | 频率 | 参数 | 触发时间点 | 写入目标 |
|------|--------|------|------|------------|----------|
| 第 0 层 | 常规同步 | 每 15 分钟 | `today` | 全天（非特殊时段） | `ad_snapshots` |
| 第 1 层 | 近程修补 | 每 4-6 小时 | `last_3d` | 06:15, 12:15, 18:15 | `daily_stats` |
| 第 2 层 | 中程回溯 | 每天 1 次 | `last_7d` | 凌晨 03:15 或 04:15 | `daily_stats` |
| 特殊 | 午夜回补 | 00:15 | `last_2d` | 填补真空期 | `daily_stats` |
| 保底 🆕 | 周末大回补 | 每周六 03:15 | `last_14d` | 防止漏数据 | `daily_stats` |

### 时间轴示意图（账户本地时间）

```
00:00 ─────────────────────────────────────────────────────── 24:00
  │                                                            │
  │  00:15     03:15        06:15        12:15        18:15    │
  │    │         │            │            │            │      │
  │    ▼         ▼            ▼            ▼            ▼      │
  │ last_2d   last_7d      last_3d      last_3d      last_3d   │
  │(午夜回补) (中程回溯)   (近程修补)   (近程修补)   (近程修补) │
  │                                                            │
  │  其他时间点：每 15 分钟拉 today（仅当天 spend>0 的广告）    │
  │                                                            │
  │  周六 03:15：last_14d（保底大回补）                         │
  │                                                            │
  │  另外：每 10 分钟巡检，账户本地 02:00-02:09 触发初步归档 │
  │        每 10 分钟巡检，账户本地 12:00-12:09 触发深度对账 │
  └────────────────────────────────────────────────────────────┘
```

---

## 三、🔄 热路径（实时）与冷路径（归档）分离

> **AdsPolar 核心设计**：热路径负责实时规则数据，冷路径负责历史报表数据，两者平行运行，互不阻塞。

### 3.1 热路径（Hot Path - 每 15 分钟）

**目标**：始终盯着"账户时区的今天 (Today)"，为 7x24 自动化规则提供实时数据。

**逻辑**：
- 每 15 分钟请求 `since: Today, until: Today`
- 更新 `ad_snapshots` 表（覆盖写，保持"今天到目前为止的累计值"）
- **关键**：从 00:00 开始，自动化规则（止损、增量）就已经在跑"今天"的数据，**不需要等 02:00 的归档**

**时间线示例**（账户本地时间）：
- **23:45**：热路径同步 Today，规则引擎看到"昨日累计消耗 $1000"，ROI 达标，继续跑
- **00:00**：账户时区进入新的一天
- **00:15**：热路径发现跨天，请求 `since: Today`，API 返回消耗 $5
  - 更新 `ad_snapshots`，把该广告数据从 $1000 覆盖为 $5
  - 规则引擎看到 $5，判断今天刚开始，符合规则，继续跑
  - **此时**：昨天的 $1000 还在 FB 服务器，系统还没存入 `daily_stats`（冷表）

### 3.2 冷路径（Cold Path - 双窗口归档）

**目标**：固化"账户时区的昨天 (Yesterday)"，为历史报表提供最终数据。

**早班车（初步归档）**：账户本地 02:00-02:09
- 请求 `since: Yesterday, until: Yesterday` 的全天汇总包
- 写入 `daily_stats`（冷表），标记为 `ARCHIVED`
- **目的**：让运营早上 9 点上班时，能看到 95% 准确的昨天报表

**对账车（深度对账）**：账户本地 12:00-12:09
- 再次请求 `since: Yesterday, until: Yesterday`，**强制覆盖**凌晨数据
- 更新 `daily_stats`（覆盖写），标记为 `FINALIZED`
- **目的**：捕捉所有延迟回传的转化，确保数据库里的钱和转化数与 Facebook 后台看到的完全一致

### 3.3 统一主同步任务（热路径实现）

```javascript
// ==================== 主数据同步任务（每 15 分钟）====================
// 这是"热路径"的实现，负责实时同步 Today 数据
async function mainSyncTask(account) {
  // 注意：统一使用 timezone_name 字段（与数据库 account_mappings 表一致）
  const localTime = DateTime.now().setZone(account.timezone_name)
  const hour = localTime.hour
  const minute = localTime.minute
  const weekday = localTime.weekday  // 1=周一, 6=周六
  
  // ===== 智能决策：根据时间点选择请求范围 =====
  let datePreset = 'today'  // 默认：热路径同步 Today
  let timeIncrement = null  // 默认不拆分
  
  // 特殊时间点：历史回补（这些是"冷路径"的 API 回补，不是归档）
  // 周六 03:15 → 保底大回补（last_14d）
  if (weekday === 6 && hour === 3 && minute >= 15 && minute < 30) {
    datePreset = 'last_14d'
    timeIncrement = 1
  }
  // 03:15 或 04:15 → 中程回溯（last_7d，按日拆分）
  else if ([3, 4].includes(hour) && minute >= 15 && minute < 30) {
    datePreset = 'last_7d'
    timeIncrement = 1  // 关键：按日拆分返回
  }
  // 06:15, 12:15, 18:15 → 近程修补（last_3d，按日拆分）
  else if ([6, 12, 18].includes(hour) && minute >= 15 && minute < 30) {
    datePreset = 'last_3d'
    timeIncrement = 1
  }
  // 00:15 → 预归档（last_2d，按日拆分）
  else if (hour === 0 && minute >= 15 && minute < 30) {
    datePreset = 'last_2d'
    timeIncrement = 1
  }
  
  // ===== 执行请求（一次逻辑查询，自动处理分页）=====
  // 注意：虽然是"一次逻辑查询"，但底层会自动遍历所有分页（见补丁5）
  const insights = await fetchInsightsWithDatePreset(account, datePreset, timeIncrement)
  
  // ===== 内存分流 =====
  await dispatchToTables(insights, account.timezone_name)
}
```

### 3.4 内存分流逻辑

```javascript
async function dispatchToTables(insights, timezone_name) {
  const today = DateTime.now().setZone(timezone_name).toISODate()  // '2026-01-24'
  
  const snapshotsData = []  // 今天的数据（热表）
  const dailyStatsData = [] // 历史数据（冷表）
  
  for (const row of insights) {
    if (row.date_start === today) {
      // 今天的数据 → ad_snapshots（热表，覆盖写）
      snapshotsData.push(row)
    } else {
      // 历史数据 → daily_stats（冷表，UPSERT）
      dailyStatsData.push(row)
    }
  }
  
  // 批量写入（避免逐条 INSERT）
  if (snapshotsData.length > 0) {
    // 热表：使用 ON DUPLICATE KEY UPDATE 覆盖写（保持"今天累计值"）
    await batchUpsertSnapshots(snapshotsData)
  }
  if (dailyStatsData.length > 0) {
    // 冷表：使用 ON DUPLICATE KEY UPDATE（历史回补时覆盖更新）
    await batchUpsertDailyStats(dailyStatsData)
  }
}
```

### 3.5 热路径与冷路径的职责分离

| 路径 | 频率 | 数据源 | 写入目标 | 用途 | 阻塞关系 |
|------|------|--------|----------|------|----------|
| **热路径** | 每 15 分钟 | `since: Today, until: Today` | `ad_snapshots` | 实时规则（止损、增量） | **不阻塞**，规则引擎随时可用 |
| **冷路径-早班车** | 账户本地 02:00-02:09 | `since: Yesterday, until: Yesterday` | `daily_stats` | 初步报表（95% 准确） | 独立运行，不影响热路径 |
| **冷路径-对账车** | 账户本地 12:00-12:09 | `since: Yesterday, until: Yesterday` | `daily_stats`（覆盖） | 最终报表（100% 准确） | 独立运行，不影响热路径 |

**关键点**：
- ✅ 热路径和冷路径**平行运行**，互不阻塞
- ✅ 规则引擎**不需要等归档**，从 00:00 开始就能用"今天"的数据
- ✅ 如果 01:00 想看"昨天"报表但归档未跑，前端逻辑：`IF (daily_stats 没数据) THEN (去 ad_snapshots 找最后一次更新时间属于昨天的记录)`

---

## 四、🚀 Insights First 性能优化

### 你的明确需求

> "只拉取**当天 spend > 0** 的广告"

### 优化后的流程

```
┌─────────────────────────────────────────────────────────┐
│  第 1 步：筛选活跃广告（Insights First）                 │
│  请求：/{accountId}/insights?level=ad                   │
│  参数：date_preset=today, fields=ad_id,spend            │
│  过滤：spend > 0                                        │
│  结果：activeAdIds = [几十个活跃广告ID]                 │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  第 2 步：拉取明细数据（仅活跃广告）                     │
│  请求：Batch API，每批 50 个广告                        │
│  输入：activeAdIds（几十个，而不是 4000+）              │
└─────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────┐
│  第 3 步：补齐状态信息                                   │
│  方法：resolveObjectsByIds(activeAdIds)                 │
│  字段：effective_status, status, adset_id               │
└─────────────────────────────────────────────────────────┘
```

### 性能对比

| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| API 请求数 | ~100+ | ~5-10 |
| 同步耗时 | 分钟级 | 秒级 |

---

## 五、⚠️ 六个关键补丁（SaaS 级实现细节）

### 补丁 1：时区计算 —— 用 Luxon 解决夏令时问题

**❌ 错误做法**：硬编码 UTC 偏移量

```javascript
// 危险！纽约冬天是 UTC-5，夏天是 UTC-4
const hour = (utcHour - 5 + 24) % 24  // 会导致时间漂移
```

**✅ 正确做法**：使用 Luxon + IANA Timezone Database

```javascript
import { DateTime } from 'luxon'

// account.timezone_name = 'America/New_York'（统一使用 timezone_name 字段）
// Luxon 自动处理夏令时
const localTime = DateTime.now().setZone(account.timezone_name)

if (localTime.hour === 0 && localTime.minute >= 15) {
  // 这个判断永远是当地墙上挂钟的时间，无论夏天冬天
}
```

**💣 不修复的后果**：
- 夏天时，你的 00:15 预归档任务会在错误的时间触发
- 数据报表会莫名其妙少一天或重复一天

---

### 补丁 2：数据库写入 —— 批量写入避免事件循环阻塞

**❌ 错误做法**：逐条写入

```javascript
// 危险！14,000 条记录 = 14,000 次网络请求
for (const ad of adsData) {
  await db.insert(adSnapshots).values(ad)  // 会卡死 Node.js
}
```

**✅ 正确做法**：批量写入 (Batch Upsert)

```javascript
// 先把数据攒在内存数组里
const dataToInsert = adsData.map(ad => ({
  ad_id: ad.id,
  spend: ad.spend,
  date: ad.date_start,
  // ...
}))

// 一次性写入（Drizzle 自动处理批量拼装）
await db.insert(adSnapshots)
  .values(dataToInsert)
  .onDuplicateKeyUpdate({ 
    set: { 
      spend: sql`VALUES(spend)`,
      // ... 其他字段
    } 
  })
```

**💣 不修复的后果**：
- 凌晨大回补时（10 账户 × 200 广告 × 7 天 = 14,000 条）
- Node.js 会卡死几分钟
- 前端页面打不开，其他定时任务无法执行

---

### 补丁 3：先存后算 —— 比值字段的正确处理

**❌ 错误做法**：先算后存

```javascript
// 危险！如果 purchases 为 0，会得到 Infinity 或 NaN
const cpa = spend / purchases
await db.insert({ cpa })  // 存了一个脏数据
```

**✅ 正确做法**：存原始计数，查询时再算

```javascript
// 入库时只存原始值
await db.insert({ 
  spend: row.spend,
  purchases: row.purchases,
  // cpa 不存，或存 null
})

// 查询时计算（带除零保护）
SELECT 
  spend,
  purchases,
  CASE WHEN purchases > 0 THEN spend / purchases ELSE NULL END AS cpa
FROM ad_snapshots
```

**💣 不修复的后果**：
- 数据库里会有 `Infinity`、`NaN`、负数等脏数据
- 规则引擎判断出错，误关广告

---

### 补丁 4：每账户互斥锁 —— 防止任务重入 🔴 紧急修复

> 🔴 **当前代码存在风险！**
> 
> 文档描述的是**正确做法**，但当前代码（`cronService.js`、`ingestorService.js`）仍使用 `pool.execute` 而非 `pool.getConnection()`，会导致：
> - GET_LOCK 在连接 A 上获得，然后连接 A 被 release() 回池
> - RELEASE_LOCK 在连接 B 上执行，**无法释放连接 A 的锁**
> - 长期运行后，大量账户会被"莫名其妙跳过"
> 
> **必须优先修复此问题！**

**❌ 问题场景**：

```
15:00:00 → 任务启动，开始同步 36 个账户
15:10:00 → 账户 A 还在同步中（网络慢/数据量大）
15:15:00 → 下一轮任务启动，又开始同步账户 A
结果：账户 A 被重复同步，数据重复写入 💥
```

**❌ 当前代码问题（需修复）**：

```javascript
// ❌ 当前代码（cronService.js / ingestorService.js）
// pool.execute 每次可能用不同连接，导致锁泄漏
const [lockRows] = await pool.execute('SELECT GET_LOCK(?, 0) AS acquired', [lockName])
// ... 执行任务 ...
await pool.execute('SELECT RELEASE_LOCK(?)', [lockName])  // 可能在不同连接上！
```

**✅ 正确做法**：MySQL GET_LOCK + 专用连接（7x24 无人值守必备）

> **为什么不用内存锁？** 内存锁在进程重启后会丢失。对于 7x24 无人值守的自动规则系统，必须使用数据库级锁。
> MySQL GET_LOCK 的优势：连接断开时自动释放锁，具备"自愈"能力。

> ⚠️ **关键：必须使用专用连接！** GET_LOCK 是按连接绑定的，用 `pool.execute` 可能拿锁和释放锁不是同一个连接，导致锁无法释放。

```javascript
import pool from '../db/connection.js'

async function syncAccount(accountId) {
  const lockName = `sync:account:${accountId}`
  
  // ⚠️ 关键：获取专用连接（不能用 pool.execute）
  // GET_LOCK 是"按连接"生效的，必须在同一连接上拿锁和释放锁
  const connection = await pool.getConnection()
  
  try {
    // 在专用连接上拿锁
    const [lockRows] = await connection.execute('SELECT GET_LOCK(?, 0) AS acquired', [lockName])
    const lockAcquired = lockRows[0]?.acquired === 1
    
    if (!lockAcquired) {
      console.log(`⏭️ 账户 ${accountId} 正在被其他任务同步，跳过`)
      return { status: 'skipped', reason: 'lock_busy' }
    }
    
    try {
      await doSync(accountId)
      return { status: 'success' }
    } finally {
      // 在同一连接上释放锁
      await connection.execute('SELECT RELEASE_LOCK(?)', [lockName])
    }
  } finally {
    // 归还连接到池
    // ⚠️ 注意：release() 只是归还连接，不会断开连接，锁不会"自动释放"
    // 锁的释放依赖于：1) 显式 RELEASE_LOCK  2) 连接真正断开（崩溃/destroy）
    connection.release()
  }
}
```

**🔑 GET_LOCK + 专用连接的特性**：
- 进程正常退出：finally 块的 `RELEASE_LOCK` 释放锁 ✅
- 进程被 SIGKILL 强杀：连接断开，锁自动释放 ✅
- 进程崩溃（OOM）：连接断开，锁自动释放 ✅
- **必须同一连接**：拿锁和释放锁必须在同一个 connection 上 ⚠️
- **必须显式释放**：`connection.release()` 只是归还连接池，**不会释放锁**！必须调用 `RELEASE_LOCK` ⚠️

**💣 不修复的后果**：
- 同一账户被重复同步
- 数据重复写入或覆盖
- 15 分钟心跳下偶发的随机故障

---

### 补丁 5：分页处理 —— 防止漏数据 🆕

**❌ 问题场景**：

```
insights API 默认每页返回 25 条
你有 50 个活跃广告，但只拿到了 25 个
结果：数据缺口，25 个广告的数据丢失 💥
```

**✅ 正确做法**：自动分页遍历

```javascript
async function getAllInsights(accountId, datePreset) {
  const allData = []
  let url = `/${accountId}/insights`
  let params = {
    level: 'ad',
    date_preset: datePreset,
    fields: 'ad_id,spend,...',
    limit: 500,  // 尽量大，减少请求次数
  }
  
  while (url) {
    const response = await api.request(url, params)
    allData.push(...response.data)
    
    // 检查是否有下一页
    url = response.paging?.next || null
    params = {}  // next URL 已包含参数
  }
  
  return allData
}
```

**💣 不修复的后果**：
- 活跃广告超过 25 个时，会漏掉后面的数据
- 数据缺口，规则引擎判断不准

---

### 补丁 6：API 限流与退避策略 —— 防止雪崩 🆕

**❌ 问题场景**：

```
同时请求 36 个账户的数据
Facebook 返回 429 Too Many Requests
你的代码直接报错退出
结果：所有账户同步失败 💥
```

**✅ 正确做法**：指数退避 + 账户隔离 + 串行处理

```javascript
// 指数退避重试
async function requestWithRetry(fn, maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn()
    } catch (error) {
      // 429 限流错误 或 80004 API 超限
      if (error.code === 429 || error.code === 80004) {
        const waitTime = Math.pow(2, attempt) * 1000  // 1s, 2s, 4s
        console.warn(`⏳ 限流，等待 ${waitTime/1000}s 后重试...`)
        await sleep(waitTime)
        continue
      }
      // 其他错误直接抛出
      throw error
    }
  }
  throw new Error('重试次数用尽')
}

// 账户隔离：一个账户失败不影响其他账户
// 串行处理：36 账户顺序执行，不并发（避免突发限流）
async function syncAllAccounts(accounts) {
  const results = []
  
  for (const account of accounts) {
    try {
      const result = await syncAccount(account.id)
      results.push({ accountId: account.id, ...result })
    } catch (error) {
      // 记录错误但不中断
      console.error(`❌ 账户 ${account.id} 同步失败:`, error.message)
      results.push({ accountId: account.id, status: 'failed', error: error.message })
    }
    
    // 账户之间休眠，避免突发流量
    await sleep(500)  // 36 个账户，总共多等 18 秒
  }
  
  return results
}
```

**💣 不修复的后果**：
- 一个账户限流拖死全局
- 队列堆积，同步任务越来越慢
- 最终导致数据全面滞后

---

## 六、🩺 健康检查与告警（小团队必备）🆕

### 每日数据完整性检查

> ⚠️ **重要**：健康检查必须按**每个账户的时区**计算"昨天"，否则会误报/漏报（尤其美区账户）。

```javascript
import { DateTime } from 'luxon'

// 每天 08:00（服务器时间）检查一次数据完整性
async function dailyHealthCheck() {
  const accounts = await getAllAccounts()
  const missingAccounts = []
  
  // 🆕 按每个账户的时区计算"昨天"
  for (const account of accounts) {
    const localTime = DateTime.now().setZone(account.timezone_name)
    const accountYesterday = localTime.minus({ days: 1 }).toISODate()
    
    // 检查该账户的"昨天"是否有数据
    // ⚠️ mysql2 返回 [rows, fields]，rows 是数组
    const [rows] = await db.query(`
      SELECT COUNT(*) as ad_count
      FROM daily_stats
      WHERE account_id = ? AND date = ?
    `, [account.fb_account_id, accountYesterday])
    
    if ((rows[0]?.ad_count ?? 0) === 0) {
      missingAccounts.push({
        accountId: account.fb_account_id,
        accountName: account.name,
        timezone: account.timezone_name,
        missingDate: accountYesterday
      })
    }
  }
  
  if (missingAccounts.length > 0) {
    // 发送告警（钉钉/飞书 Webhook）
    const details = missingAccounts.map(a => 
      `${a.accountName}(${a.timezone}): ${a.missingDate}`
    ).join('\n')
    await sendAlert(`⚠️ 昨日数据不完整：\n${details}`)
  }
  
  // 检查同步任务是否正常运行
  const lastSyncTime = await getLastSyncTime()
  const hoursSinceLastSync = (Date.now() - lastSyncTime) / (1000 * 60 * 60)
  
  if (hoursSinceLastSync > 1) {
    await sendAlert(`⚠️ 同步任务可能卡死：最后同步时间是 ${hoursSinceLastSync.toFixed(1)} 小时前`)
  }
}
```

**为什么要按账户时区？**

| 场景 | 统一用北京时间"昨天" | 按账户时区"昨天" |
|------|---------------------|-----------------|
| 北京时间 08:00 检查 | 查 01-23 | 美区账户查 01-22（因为美区还在 01-23 白天） |
| 美区账户的"昨天" | ❌ 误报（数据还没归档） | ✅ 正确判断 |

---

## 七、📝 完整改造任务清单

### 阶段一：底座加固（优先级：🔴 最高）

| # | 任务 | 描述 | 文件 | 状态 |
|---|------|------|------|------|
| 1.1 | 时区计算修复 | 用 Luxon 替代手动 UTC 计算，字段统一为 `timezone_name` | `ingestorService.js` | ✅ 已实现 |
| 1.2 | 批量写入改造 | 将逐条 INSERT 改为批量 UPSERT | `ingestorService.js` | ✅ 已实现 |
| 1.3 | 先存后算 | 比值字段查询时再计算 | `ruleDataService.js` | ✅ 已实现 |
| 1.4 🔴 | **GET_LOCK 专用连接** | 用 MySQL GET_LOCK + **专用连接**（`pool.getConnection()`） | `cronService.js`, `ingestorService.js` | 🔴 **紧急修复** |
| 1.5 | **分页处理** | insights API 自动遍历所有页（处理 `paging.next`） | `ingestorService.js` | ✅ 已实现 |
| 1.6 | **API 限流退避** | 429 指数退避 + 账户隔离 | `ingestorService.js` | ✅ 部分实现 |

### 阶段二：Insights First 性能优化（优先级：🔴 最高）

| # | 任务 | 描述 | 文件 | 状态 |
|---|------|------|------|------|
| 2.1 | 新增 getActiveAdIds() | 筛选当天 spend>0 的广告 | `ingestorService.js` | 🚧 待实现 |
| 2.2 | 改造同步流程 | 使用 Insights First 策略 | `ingestorService.js` | 🚧 待实现 |
| 2.3 | 状态补齐优化 | 用 `resolveObjectsByIds()` 替代全量 `getAds()` | `ingestorService.js` | 🚧 待实现 |

### 阶段三：分层回补重构（优先级：🔴 最高）

| # | 任务 | 描述 | 文件 | 状态 |
|---|------|------|------|------|
| 3.1 | **统一主同步任务（热路径）** | 合并所有同步任务为一个，15 分钟执行，负责实时同步 Today 数据 | `cronService.js` | 🚧 待实现（当前仍是 10 分钟） |
| 3.2 | **智能决策逻辑** | 根据账户本地时间选择 `today`/`last_3d`/`last_7d`，默认 `today`（热路径） | `ingestorService.js` | 🚧 待实现 |
| 3.3 | **内存分流** | 一次请求返回后，按日期分发到不同表（Today → ad_snapshots，历史 → daily_stats） | `ingestorService.js` | 🚧 待实现 |
| 3.4 | **双窗口归档（AdsPolar 模式）** | 每 10 分钟巡检，账户本地 02:00-02:09（初步）和 12:00-12:09（对账）触发 | `cronService.js`, `ingestorService.js` | 🚧 待实现（当前 12:00 延迟归档） |
| 3.5 | **串行处理** | 36 账户顺序执行，账户间休眠 500ms | `cronService.js` | ✅ 已实现 |

### 阶段四：时间窗口配置（优先级：🟡 高）

| # | 任务 | 描述 | 状态 |
|---|------|------|------|
| 4.1 | 00:15 午夜回补 | 拉 `last_2d`，填补真空期（API 回补） | 🚧 待实现 |
| 4.2 | 06:15/12:15/18:15 近程修补 | 拉 `last_3d`，修正归因延迟（API 回补） | 🚧 待实现 |
| 4.3 | 03:15 中程回溯 | 拉 `last_7d`，确保 7 天完全准确（API 回补） | 🚧 待实现 |
| 4.4 | **周六 03:15 保底回补** | 拉 `last_14d`，防止漏数据（API 回补） | 🚧 待实现 |
| 4.5 🔴 | **归档锁统一** | 快照归档和 API 回补使用同一把 `archive:${accountId}:${date}` 锁 | 🔴 需修复 |

### 阶段五：监控告警（优先级：🟡 高）

| # | 任务 | 描述 | 状态 |
|---|------|------|------|
| 5.1 | **每日健康检查（按账户时区）** | 08:00 检查，按每个账户的时区计算"昨天" | 🚧 待实现 |
| 5.2 | 同步状态监控 | 检测同步任务是否卡死 | 🚧 待实现 |
| 5.3 | 钉钉/飞书告警 | 数据异常时发送通知 | 🚧 待实现 |

### 阶段六：功能增强（优先级：🟢 中）

| # | 任务 | 描述 | 文件 | 状态 |
|---|------|------|------|------|
| 6.1 🚧 | **include_today 配置开关** | 规则表新增 `include_today` 字段，支持可配置 | `rules` 表, `RuleManager.vue` | 🚧 待实现 |
| 6.2 ✅ | **双表合并能力** | 多天窗口自动合并 ad_snapshots + daily_stats | `ruleDataService.js` | ✅ 已实现（`queryMultiDayWithToday`） |
| 6.3 🚧 | **前端 include_today 开关** | 规则编辑增加"包含今天"复选框 | `RuleManager.vue` | 🚧 待实现 |
| 6.4 🚧 | **归档状态表** | 新建 daily_archive_status 表，避免重复归档 | `migrations/`, `cronService.js` | 🚧 待实现 |
| 6.5 | 作用对象：日期筛选 | 近 N 天发布的广告 | - | 🚧 待实现 |
| 6.6 | 作用对象：广告名筛选 | 包含/不包含某字段 | - | 🚧 待实现 |
| 6.7 | 触发条件增强 | 单次加购、单次结账、单次支付花费 | - | 🚧 待实现 |

> ⚠️ **注意**：当前代码中 `timeWindow.js` 的 `last_3_days`/`last_7_days` **默认包含今天**。6.1~6.3 完成后才能实现"可配置含/不含今天"。

---

## 八、🔄 新旧对比总览

| 维度 | 旧设计 | 新设计（AdsPolar 模式） | 状态 |
|------|--------|------------------------|------|
| 任务架构 | 热数据 + 冷数据（独立任务） | **热路径（统一主同步任务）+ 冷路径（双窗口归档）** | 🚧 待实现 |
| 热数据频率 | 10 分钟 | **15 分钟** | 🚧 当前仍是 10 分钟 |
| 数据拉取 | 全量 4000+ 广告 | **Insights First**（仅 spend>0） | 🚧 待实现 |
| 归档方式 | 读 ad_snapshots → daily_stats | **双窗口归档（02:00-02:09 初步 + 12:00-12:09 对账）+ 状态表控制** | 🚧 待实现（当前 12:00 延迟归档） |
| 历史回补 | 每 30 分钟 last_7d | **分层**：last_3d/4-6h，last_7d/天 | 🚧 待实现 |
| 时区处理 | UTC 偏移量 | **Luxon + IANA + 统一 timezone_name** | ✅ 已实现 |
| 数据库写入 | 逐条 INSERT | **批量 UPSERT** | ✅ 已实现 |
| 并发模式 | 未明确 | **串行 + 账户间休眠** | ✅ 已实现 |
| 重入防护 | 无 | **MySQL GET_LOCK + 专用连接** | 🔴 需修复 |
| 分页处理 | 未明确 | **自动遍历所有页** | ✅ 已实现 |
| 限流处理 | 无 | **指数退避 + 账户隔离** | ✅ 已实现 |
| 健康检查 | 无 | **每日数据完整性检查（按账户时区）** | 🚧 待实现 |
| 保底机制 | 无 | **周末 last_14d 大回补** | 🚧 待实现 |
| 时间窗口口径 | 语义模糊 | **include_today 可配置（双表合并已实现）** | ✅ 合并能力 / 🚧 开关 |
| 归档锁统一 | 无 | **快照归档/API 回补共用一把锁** | 🔴 需修复 |
| 归档状态表 | 无 | **完整性检查（已实现）+ 状态表（可选增强）** | ✅ 完整性检查 |

---

## 九、🎯 执行建议

### 推荐顺序

```
阶段一（底座加固）→ 阶段二（Insights First）→ 阶段三（分层回补）→ 阶段四（时间窗口）→ 阶段五（监控）→ 阶段六（功能）
```

### 为什么这个顺序？

1. **阶段一**：修复基础问题（锁、分页、限流），避免后续改造时踩坑
2. **阶段二**：性能优化，为后续改造腾出"调试窗口"
3. **阶段三**：核心架构改造
4. **阶段四/五/六**：细化、监控和功能增强

### 每阶段预估时间

| 阶段 | 预估时间 | 验证方法 |
|------|----------|----------|
| 阶段一 | 1-2 天 | 日志检查、压测、并发测试 |
| 阶段二 | 1-2 天 | 对比 API 请求数和耗时 |
| 阶段三 | 2-3 天 | 检查内存分流是否正确入库 |
| 阶段四 | 0.5-1 天 | 检查各时间点触发日志 |
| 阶段五 | 0.5 天 | 模拟异常，验证告警 |
| 阶段六 | 1-2 天 | 前端配置规则验证 |

---

## 十、📌 针对你场景的特别说明

### 你的场景特点

- **36 个广告账户**（小规模）
- **十几人使用**（内部工具）
- **小型跨境电商公司**（资源有限）

### 因此可以简化

| 复杂方案 | 简化方案 | 原因 |
|----------|----------|------|
| Redis 分布式锁 | **MySQL GET_LOCK** | 单机部署 + 自愈能力（连接断开自动释放） |
| 消息队列 | **串行顺序处理** | 36 账户，顺序跑完也只要几分钟 |
| 复杂优先级队列 | **简单按顺序** | 账户少，不需要优先级 |
| Kubernetes 多副本 | **单机 + PM2** | 规模小，单机足够 |

### 36 账户串行处理时间估算

```
每账户同步时间：5-10 秒（Insights First 优化后）
账户间休眠：0.5 秒
总时间：36 × 10 + 36 × 0.5 = 378 秒 ≈ 6.3 分钟

远小于 15 分钟心跳间隔，完全安全 ✅
```

---

## 十一、🔧 关键设计决策（已确认）

> 以下是针对本系统场景的最终设计决策，经过充分讨论后确认。

### 11.1 部署模式：单进程 + PM2 fork

| 方案 | 是否采用 | 理由 |
|------|---------|------|
| **单进程 + PM2 fork** | ✅ 采用 | 36 账户负载低、MySQL GET_LOCK 有效、调试简单 |
| 多进程 cluster | ❌ 不采用 | 需要 Redis 分布式锁、增加复杂性、收益小 |

```bash
# 推荐的 PM2 启动命令
pm2 start server/server.js --name fb-ad-brain --no-cluster
```

### 11.2 熔断策略：Token 过期不自动恢复

| 错误类型 | 处理方式 | 理由 |
|----------|----------|------|
| **Token 过期 (code=190)** | 永久熔断，人工续 Token | 自动重试有封号风险 |
| **权限被撤销** | 永久熔断，人工处理 | 需要重新授权 |
| API 限流 (429/80004) | 指数退避自动重试 | 临时性问题，会恢复 |
| 服务器错误 (5xx) | 指数退避自动重试 | 临时性问题，会恢复 |

> **重要**：Token 过期是永久性错误，不实现"半开状态"自动恢复。发现 Token 失效后发送告警，人工更换 Token 后解锁系统。

### 11.3 归档策略：双窗口归档（AdsPolar 模式）+ 状态表

> **当前实现状态**：
> - ⚠️ **临时方案**：每天中午 12:00 执行 `archiveAllAccountsDailyStats(null, true)` 强制归档所有账户
> - ✅ **完整性检查**：归档前对比 `expectedCount`（快照应归档数）和 `archivedCount`（已归档数），完整则跳过
> - 🚧 **双窗口归档**：**待实现**，目标改为：
>   - **早班车（初步归档）**：每 10 分钟巡检，账户本地 02:00-02:09 触发
>   - **对账车（深度对账）**：每 10 分钟巡检，账户本地 12:00-12:09 触发（覆盖更新）
> - 🚧 `daily_archive_status` 状态表：**未建表**，用于标记 ARCHIVED → FINALIZED 状态转换
> 
> **问题**：当前 12:00 一刀切归档，跨时区账户延迟最长可达 23 小时（例如美西账户在服务器 12:00 时，其"昨天"可能已经结束 23 小时）。
> 
> **目标方案（AdsPolar 模式）**：
> - **早班车（02:00-02:09）**：初步归档 Yesterday，让运营早上 9 点能看到 95% 准确的报表
> - **对账车（12:00-12:09）**：深度对账 Yesterday，覆盖更新凌晨数据，捕捉所有延迟回传的转化
> - **延迟**：每个账户在本地 02:00 左右可用初步数据（约 2 小时），12:00 左右可用最终数据（约 12 小时）

> ⚠️ **概念澄清**：
> - **快照归档**（本节）：从 `ad_snapshots` 读取昨日最后快照，写入 `daily_stats`
> - **API 回补**（第二节）：从 Facebook API 拉取历史数据，更新 `daily_stats`
> 
> 两者都写入 `daily_stats`，通过以下机制保证不冲突：
> 1. 唯一索引 `(account_id, ad_id, date)` + `ON DUPLICATE KEY UPDATE` 保证幂等
> 2. 使用同一把归档锁 `archive:${accountId}:${date}` 防止并发
> 3. 🆕 使用 `daily_archive_status` 表避免重复归档

**为什么选择方案 B？**
- 系统核心能力是 **7x24 小时自动规则优化**
- 规则执行需要读取 `daily_stats` 的历史数据
- 按账户时区动态归档，确保每个账户的"昨天"数据尽快可用

| 方案 | 归档时机 | 数据延迟 | 是否采用 |
|------|----------|----------|---------|
| 方案 A | 北京时间 12:00 统一归档 | 最长 23 小时（跨时区） | ❌ |
| 方案 B（当前） | 每天中午 12:00 延迟归档（forceAll=true） | 最长 23 小时（跨时区） | ⚠️ 临时方案 |
| **方案 C（目标，AdsPolar 模式）** | 双窗口归档：<br>• 早班车：02:00-02:09（初步归档）<br>• 对账车：12:00-12:09（深度对账） | 初步数据：约 2 小时<br>最终数据：约 12 小时 | ✅ 采用 |

#### 🚧 归档状态表（双窗口归档必需）

**作用**：标记每个 `(account_id, target_date)` 的归档状态，控制双窗口归档的执行逻辑。

**状态流转**：
- `PENDING` → `ARCHIVED`（早班车 02:00-02:09 触发）
- `ARCHIVED` → `FINALIZED`（对账车 12:00-12:09 触发）

**表结构**：

```sql
CREATE TABLE daily_archive_status (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  account_id VARCHAR(50) NOT NULL,
  target_date DATE NOT NULL,
  status ENUM('PENDING', 'ARCHIVED', 'FINALIZED') NOT NULL DEFAULT 'PENDING',
  archived_at TIMESTAMP NULL,
  ad_count INT DEFAULT 0,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_account_date (account_id, target_date),
  INDEX idx_status (status),
  INDEX idx_target_date (target_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**逻辑设计**：
- **早班车（02:00-02:09）**：只有 `status = 'PENDING'` 才归档，归档后标记为 `ARCHIVED`
- **对账车（12:00-12:09）**：只有 `status = 'ARCHIVED'` 才再次归档（覆盖更新），归档后标记为 `FINALIZED`
- **好处**：不浪费资源，自动化闭环，运营不需要手动同步

```sql
-- 归档状态表（参考 AdsPolar 的 Sync Registry）
CREATE TABLE daily_archive_status (
  id INT AUTO_INCREMENT PRIMARY KEY,
  account_id VARCHAR(50) NOT NULL,       -- 广告账户ID
  target_date DATE NOT NULL,             -- 归档目标日期
  status ENUM('ARCHIVED') NOT NULL,      -- 归档状态（简化版只需 ARCHIVED）
  archived_at DATETIME NOT NULL,         -- 归档时间
  ad_count INT DEFAULT 0,                -- 归档的广告数量
  error TEXT,                            -- 错误信息（如果有）
  created_at DATETIME DEFAULT NOW(),
  updated_at DATETIME DEFAULT NOW() ON UPDATE NOW(),
  
  UNIQUE KEY uk_account_date (account_id, target_date),
  INDEX idx_status (status),
  INDEX idx_archived_at (archived_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**目标归档逻辑（双窗口归档 + 状态表）**：

```javascript
// cronService.js - 每 10 分钟巡检，账户本地 02:00-02:09 和 12:00-12:09 触发归档
cron.schedule('*/10 * * * *', async () => {
  console.log('📦 冷数据归档检查（双窗口模式）')
  
  // 使用 forceAll=false，让函数内部按账户时区判断窗口
  const result = await archiveAllAccountsDailyStats(null, false)
})

// ingestorService.js - 双窗口归档判断（AdsPolar 模式）
export async function archiveAllAccountsDailyStats(targetDate = null, forceAll = false) {
  for (const account of accounts) {
    const timezoneName = account.timezone_name || 'UTC'
    const localTime = DateTime.now().setZone(timezoneName)
    const hour = localTime.hour
    const minute = localTime.minute
    
    // 判断归档窗口
    let archiveWindow = null
    if (!forceAll) {
      // 早班车：02:00-02:09（初步归档）
      if (hour === 2 && minute >= 0 && minute <= 9) {
        archiveWindow = 'MORNING'  // 初步归档
      }
      // 对账车：12:00-12:09（深度对账）
      else if (hour === 12 && minute >= 0 && minute <= 9) {
        archiveWindow = 'NOON'  // 深度对账
      } else {
        continue  // 不在窗口，跳过
      }
    }
    
    // 计算目标日期（账户本地时区的"昨日"）
    const localNow = DateTime.now().setZone(timezoneName)
    const yesterday = localNow.minus({ days: 1 })
    const targetDateStr = yesterday.toFormat('yyyy-MM-dd')
    
    // 检查归档状态（使用 daily_archive_status 表）
    const [statusRows] = await pool.execute(
      'SELECT status FROM daily_archive_status WHERE account_id = ? AND target_date = ?',
      [accountId, targetDateStr]
    )
    const currentStatus = statusRows[0]?.status || 'PENDING'
    
    // 早班车：只有 PENDING 状态才归档
    if (archiveWindow === 'MORNING') {
      if (currentStatus !== 'PENDING') {
        console.log(`   ⏭️  已归档，跳过 (status: ${currentStatus})`)
        continue
      }
    }
    // 对账车：只有 ARCHIVED 状态才再次归档（覆盖更新）
    else if (archiveWindow === 'NOON') {
      if (currentStatus !== 'ARCHIVED') {
        console.log(`   ⏭️  未初步归档，跳过 (status: ${currentStatus})`)
        continue
      }
    }
    
    // 完整性检查（已有）
    const expectedCount = ... // 查询 ad_snapshots
    const archivedCount = ... // 查询 daily_stats
    if (expectedCount > 0 && archivedCount >= expectedCount && archiveWindow === 'MORNING') {
      // 早班车：已完整，跳过
      continue
    }
    // 对账车：即使已完整也要覆盖更新（捕捉延迟转化）
    
    // GET_LOCK + 归档 + RELEASE_LOCK（已有）
    const result = await archiveDailyStats(accountId, timezoneName, yesterday.toJSDate())
    
    // 更新状态表
    const newStatus = archiveWindow === 'MORNING' ? 'ARCHIVED' : 'FINALIZED'
    await pool.execute(`
      INSERT INTO daily_archive_status (account_id, target_date, status, archived_at, ad_count)
      VALUES (?, ?, ?, NOW(), ?)
      ON DUPLICATE KEY UPDATE 
        status = VALUES(status),
        archived_at = NOW(),
        ad_count = VALUES(ad_count),
        updated_at = NOW()
    `, [accountId, targetDateStr, newStatus, result.archivedCount || 0])
    
    console.log(`✅ ${archiveWindow === 'MORNING' ? '初步归档' : '深度对账'}完成，状态: ${newStatus}`)
  }
}
```

**当前临时方案（12:00 延迟归档）**：

```javascript
// cronService.js - 每天中午 12:00 执行（临时方案）
cron.schedule('0 12 * * *', async () => {
  // 使用 forceAll=true 强制归档所有账户
  const result = await archiveAllAccountsDailyStats(null, true)
})
```

// ingestorService.js - 归档前完整性检查
async function archiveAllAccountsDailyStats(specifiedAccountId = null, forceAll = false) {
  for (const account of accounts) {
    // ... 获取 targetDate（昨日）...
    
    // ✅ 完整性检查：对比期望数和已归档数
    const [expectedRows] = await pool.execute(
      'SELECT COUNT(DISTINCT ad_id) as cnt FROM ad_snapshots WHERE account_id = ? AND synced_at >= ? AND synced_at < ?',
      [accountId, startTime, endTime]
    )
    const expectedCount = expectedRows[0]?.cnt || 0
    
    const [archivedRows] = await pool.execute(
      'SELECT COUNT(DISTINCT ad_id) as cnt FROM daily_stats WHERE account_id = ? AND date = ?',
      [accountId, targetDateStr]
    )
    const archivedCount = archivedRows[0]?.cnt || 0
    
    // 完整则跳过（避免重复归档）
    const isComplete = expectedCount === 0 || archivedCount >= expectedCount
    if (isComplete) {
      console.log(`✅ 已归档且完整，跳过 (${archivedCount}/${expectedCount} 条)`)
      continue
    }
    
    // 不完整，执行归档补齐
    await archiveDailyStats(accountId, timezoneName, targetDate)
  }
}
```

**状态表的好处**：

| 好处 | 说明 |
|------|------|
| **避免重复执行** | 已归档的 (account, date) 直接跳过 |
| **可观测性** | 归档状态一眼可见，排查问题方便 |
| **失败可追踪** | error 字段记录失败原因 |
| **支持手动重跑** | 删除状态记录即可重新归档 |

**快照归档 vs API 回补的配合**：

```
时间轴（账户本地时间）：
00:00 ─────────────────────────────────────────────────── 24:00
  │                                                         │
  │  02:00-02:09    06:15    12:00-12:09    18:15         │
  │    │              │          │            │           │
  │    ▼              ▼          ▼            ▼           │
  │ 快照归档      API回补    深度对账      API回补        │
  │ (初步归档)   (🚧待实现)  (覆盖归档)  (🚧待实现)      │
  │ (ARCHIVED)    last_3d       last_3d       last_3d       │
  │ (快速可用)    (覆盖纠偏)    (覆盖纠偏)    (覆盖纠偏)    │
  │                                                         │
  │ 📝 快照归档只跑一次，后续由 API 回补持续覆盖纠偏        │
  └─────────────────────────────────────────────────────────┘
```

| 任务 | 执行频率 | 触发条件 | 数据来源 | 每天执行次数 |
|------|----------|----------|----------|-------------|
| 快照归档-早班车 | 每 10 分钟巡检 | 账户本地 02:00-02:09 窗口 + 状态表控制 | `ad_snapshots` → `daily_stats` | **1 次/账户/天**（PENDING → ARCHIVED） |
| 快照归档-对账车 | 每 10 分钟巡检 | 账户本地 12:00-12:09 窗口 + 状态表控制 | `ad_snapshots` → `daily_stats`（覆盖） | **1 次/账户/天**（ARCHIVED → FINALIZED） |
| API 回补 | 分层（见第二节） | 账户本地时间点 | Facebook API | 多次（覆盖纠偏） |

> 快照归档提供"快速可用"的昨日数据，API 回补保证最终准确性（归因延迟修正）。

### 11.4 广告筛选策略：仅 spend > 0（热层优化）

| 策略 | 是否采用 | 理由 |
|------|---------|------|
| **spend > 0** | ✅ 当前采用 | 核心场景（止损/扩量）都需要花费 |
| spend > 0 OR impressions > 0 | 🔜 后续可扩展 | 当前不需要 |

> 零花费广告（新建/已暂停）不需要自动化规则管控，等它开始花钱再纳入。

**⚠️ 业务限制说明**：

这是"热层优化策略"，会导致以下场景**无法覆盖**：

| 场景 | spend>0 能覆盖？ | 说明 |
|------|-----------------|------|
| 止损（花钱没转化） | ✅ | 核心场景，覆盖 |
| 扩量（花钱有效果） | ✅ | 核心场景，覆盖 |
| 冷启动监控（新广告） | ❌ | spend=0 的新广告看不到 |
| 状态变化监控 | ❌ | 刚激活还没花钱看不到 |
| 无展示异常监控 | ❌ | impressions=0 看不到 |

**🔜 后续扩展建议（补集通道）**：

如果未来需要覆盖以上场景，可增加以下"补集同步"任务：

```javascript
// 低频补集同步（每小时一次），覆盖 spend=0 的广告
async function syncInactiveAds() {
  // 1. 近 24 小时新建的广告（冷启动监控）
  // 2. 状态为 ACTIVE 但 spend=0 的广告（异常监控）
  // 3. impressions > 0 但 spend=0 的广告（展示但没花钱）
}
```

> **当前不实现**，待业务需求明确后再扩展。

### 11.5 时间窗口口径：include_today 配置（参考 AdsPolar）

> **当前实现状态**：
> - ✅ **双表合并能力**：`ruleDataService.queryMultiDayWithToday()` 已实现"历史段查 daily_stats + 今天段查 ad_snapshots"
> - ✅ **当前默认行为**：`timeWindow.js` 中的 `last_3_days`/`last_7_days` **默认包含今天**（等价于 `include_today=true`）
> - 🚧 **可配置开关**：rules 表未添加 `include_today` 字段，无法按规则配置含/不含今天

> **问题**：`last_3_days` 包不包含今天？不同理解会导致规则触发与预期不符。

**AdsPolar 的解决方案**：
- **Static Window（不含今天）**：数据最准，适合"关停"决策
- **Rolling Window（含今天）**：时效性强，适合"止损"决策

**本系统采纳**：在规则配置中新增 `include_today` 布尔字段

```javascript
// 规则模型新增字段
{
  time_window: 'last_3_days',
  include_today: false,  // 🆕 是否包含今天
  // ...
}
```

#### 🆕 关键：include_today 与表设计的衔接

> ⚠️ **隐蔽 Bug 警告**：今天的数据在 `ad_snapshots`，历史数据在 `daily_stats`。如果 `include_today=true`，规则查询必须合并两表数据，否则"包含今天"形同虚设！

**数据分布**：

| 日期 | 存储位置 | 说明 |
|------|----------|------|
| 今天 (T-0) | `ad_snapshots` | 每 15 分钟更新的实时快照（按 `synced_at` 存储，**无 `date` 字段**） |
| 昨天及更早 | `daily_stats` | 归档后的历史数据（按 `date` 字段存储） |

#### 🆕 实际表结构说明（与理想化 UNION 不同）

> ⚠️ **重要**：当前 `ad_snapshots` 表是"多快照/按 `synced_at` 存储"的设计，**没有 `date` 字段**，无法直接与 `daily_stats` 做 SQL UNION。

**当前表结构差异**：

| 字段 | `ad_snapshots` (实际) | `daily_stats` | 说明 |
|------|----------------------|---------------|------|
| 日期 | ❌ 无 `date` 字段，用 `synced_at` | ✅ `date` | 结构不同，无法直接 UNION |
| 唯一性 | `UNIQUE(ad_id, sync_session_id)`，同一广告不同会话有多条快照 | `UNIQUE(account_id, ad_id, date)` | 快照表按会话追加写入 |

**实际实现方式（Node.js 层合并，非 SQL UNION）**：

当前代码（`ruleDataService.js` 的 `queryMultiDayWithToday`）采用的是**应用层合并**：

```javascript
import { DateTime } from 'luxon'

/**
 * 获取规则时间窗口内的广告数据（实际实现方式）
 * 
 * ⚠️ 由于 ad_snapshots 没有 date 字段，无法直接 SQL UNION
 * 采用：历史段查 daily_stats + 今天段查 ad_snapshots 最新快照 + Node 层合并
 */
async function getRuleWindowData(rule, accountId, timezone_name) {
  const { since, until, includeToday } = getDateRange(
    rule.time_window, 
    rule.include_today, 
    timezone_name
  )
  
  const localTime = DateTime.now().setZone(timezone_name)
  const today = localTime.toISODate()
  
  // 1. 查询历史数据（daily_stats，按日期粒度）
  const [historyRows] = await db.query(`
    SELECT ad_id, date, spend, impressions, clicks, purchases
    FROM daily_stats
    WHERE account_id = ? AND date >= ? AND date <= ?
  `, [accountId, since, includeToday ? localTime.minus({ days: 1 }).toISODate() : until])
  
  let todayData = []
  
  // 2. 如果包含今天，查询今天最新快照
  if (includeToday) {
    // ⚠️ 关键：取每个广告的最新快照（按 synced_at 排序）
    const [snapshotRows] = await db.query(`
      SELECT s.ad_id, ? as date, s.spend, s.impressions, s.clicks, s.purchases
      FROM ad_snapshots s
      INNER JOIN (
        SELECT ad_id, MAX(synced_at) as max_synced
        FROM ad_snapshots
        WHERE account_id = ?
        GROUP BY ad_id
      ) latest ON s.ad_id = latest.ad_id AND s.synced_at = latest.max_synced
      WHERE s.account_id = ?
    `, [today, accountId, accountId])
    
    todayData = snapshotRows
  }
  
  // 3. Node 层合并
  return [...historyRows, ...todayData]
}

/**
 * 按广告聚合时间窗口数据
 */
async function getAggregatedDataForRule(rule, accountId, timezone_name) {
  const rawData = await getRuleWindowData(rule, accountId, timezone_name)
  
  // 按 ad_id 聚合
  const aggregated = {}
  for (const row of rawData) {
    if (!aggregated[row.ad_id]) {
      aggregated[row.ad_id] = { ad_id: row.ad_id, spend: 0, impressions: 0, clicks: 0, purchases: 0 }
    }
    aggregated[row.ad_id].spend += Number(row.spend) || 0
    aggregated[row.ad_id].impressions += Number(row.impressions) || 0
    aggregated[row.ad_id].clicks += Number(row.clicks) || 0
    aggregated[row.ad_id].purchases += Number(row.purchases) || 0
  }
  
  return Object.values(aggregated)
}
```

**关键约束（防止重复计入）**：

| 约束 | 说明 |
|------|------|
| 今天数据取最新快照 | 用 `MAX(synced_at)` 子查询，确保每个广告只取一条 |
| 历史数据按日期去重 | `daily_stats` 有 `UNIQUE(account_id, ad_id, date)`，天然保证 |
| Node 层合并不重复 | 历史段 `date < today`，今天段 `date = today`，范围不重叠 |
```

**日期范围计算逻辑**：

```javascript
import { DateTime } from 'luxon'

function getDateRange(timeWindow, includeToday, timezone_name) {
  const localTime = DateTime.now().setZone(timezone_name)
  const today = localTime.toISODate()
  
  switch (timeWindow) {
    case 'today':
      return { since: today, until: today, includeToday: true }
    
    case 'yesterday':
      const yesterday = localTime.minus({ days: 1 }).toISODate()
      return { since: yesterday, until: yesterday, includeToday: false }
    
    case 'last_3_days':
      if (includeToday) {
        // T-2 ~ T-0（含今天，共3天）
        return {
          since: localTime.minus({ days: 2 }).toISODate(),
          until: today,
          includeToday: true
        }
      } else {
        // T-3 ~ T-1（不含今天，共3天）
        return {
          since: localTime.minus({ days: 3 }).toISODate(),
          until: localTime.minus({ days: 1 }).toISODate(),
          includeToday: false
        }
      }
    
    case 'last_7_days':
      if (includeToday) {
        return {
          since: localTime.minus({ days: 6 }).toISODate(),
          until: today,
          includeToday: true
        }
      } else {
        return {
          since: localTime.minus({ days: 7 }).toISODate(),
          until: localTime.minus({ days: 1 }).toISODate(),
          includeToday: false
        }
      }
    
    // ... 其他窗口
  }
}
```

**使用场景建议**：

| 规则类型 | include_today | 理由 |
|----------|--------------|------|
| **急停止损** | ✅ 含今天 | 今天花了 $100 还没出单，立刻停 |
| **稳健关停** | ❌ 不含今天 | 基于完整历史数据决策，更准确 |
| **扩量加预算** | ❌ 不含今天 | 避免今天数据波动导致误加预算 |

**前端 UI 建议**：
```
时间窗口：[过去 3 天 ▼]  □ 包含今天（数据可能不完整）
```

### 11.6 时区处理：统一使用 Luxon

**所有涉及时区的地方必须使用 Luxon**，禁止手动计算 UTC 偏移。

> ⚠️ **字段命名统一**：全部使用 `timezone_name`（与数据库 `account_mappings` 表字段一致）

```javascript
import { DateTime } from 'luxon'

// ✅ 正确：使用 Luxon + timezone_name
const localTime = DateTime.now().setZone(account.timezone_name)
const today = localTime.toISODate()
const yesterday = localTime.minus({ days: 1 }).toISODate()

// ❌ 错误：手动计算
const hour = (utcHour - 8 + 24) % 24  // 危险！不处理夏令时

// ❌ 错误：字段名不一致
const localTime = DateTime.now().setZone(account.timezone)  // 应该是 timezone_name
```

---

## 十二、✅ 验收 Checklist（补充）

### 核心功能验收

| # | 验收项 | 验证方法 | 状态 |
|---|--------|----------|------|
| 1 | **Insights First 生效** | 对比优化前后 API 请求数，应减少 80%+ | ✅ |
| 2 | **每账户互斥锁生效** | 模拟慢同步（加 sleep），验证同一账户不会被重复同步 | 🔴 需修复 |
| 3 | **GET_LOCK 专用连接** | 检查代码使用 `pool.getConnection()` 而非 `pool.execute()` | 🔴 需修复 |
| 4 | **分页完整性** | 账户广告数 > 100 时，验证全部拉取到 | ✅ |
| 5 | **串行处理生效** | 日志中账户按顺序执行，无交叉 | ✅ |
| 6 | **双窗口归档生效** | 每 10 分钟巡检，账户本地 02:00-02:09（初步）和 12:00-12:09（对账）窗口触发，状态表控制正常 | 🚧 待实现 |
| 7 | **归档锁与回补锁统一** | 快照归档和 API 回补使用同一把 `archive:${accountId}:${date}` 锁 | 🔴 需修复 |
| 8 | **限流恢复** | 模拟 429 错误，验证指数退避后继续执行 | ✅ |
| 9 | **熔断不自动恢复** | 模拟 Token 失效 (code=190)，验证系统锁定且不自动重试 | ✅ |

### 数据质量验收

| # | 验收项 | 验证方法 | 状态 |
|---|--------|----------|------|
| 10 | **数据完整性** | 每日健康检查通过，36 个账户都有数据 | ✅ |
| 11 | **时区正确性** | 跨时区账户的"昨日"边界计算正确 | ✅ |
| 12 | **字段命名一致** | 全部使用 `timezone_name`，无 `timezone` | ✅ |
| 13 | **规则执行正确** | 配置止损/扩量规则，验证触发逻辑正确 | ✅ |
| 14 🚧 | **include_today 可配置** | 同一规则分别测试含/不含今天，日期范围符合预期 | 🚧 待实现（开关） |
| 15 ✅ | **双表合并能力** | 多天窗口验证今天数据从 ad_snapshots 正确获取并合并 | ✅ 已实现 |
| 16 | **健康检查按账户时区** | 验证美区账户不会在北京早上误报"数据缺失" | ✅ |
| 17 🚧 | **归档状态表生效** | 同一 (account, date) 只归档一次，状态表有记录 | 🚧 待实现 |
| 18 🚧 | **双窗口归档生效** | 验证美区账户在本地 02:00-02:09 初步归档，12:00-12:09 深度对账，状态表正确流转 | 🚧 待实现 |
| 18 | **双表合并不重复** | 验证今天数据取最新快照，历史+今天合并后不重复累加 | ✅ 逻辑正确 |

---

## 十三、📋 修订记录

### v4.1 修订（基于 GPT 和 AdsPolar 分析反馈）

| # | 问题 | 修正内容 |
|---|------|----------|
| 1 | GET_LOCK 连接池不安全 | 补丁4 改为使用 `pool.getConnection()` 专用连接 |
| 2 | "只发一次请求"表述误导 | 改为"一次逻辑查询（自动处理分页）" |
| 3 | 归档策略前后不一致 | 澄清"API 回补" vs "快照归档"，统一使用归档锁 |
| 4 | 时区字段命名不一致 | 统一为 `timezone_name` |
| 5 | 缺少 include_today 配置 | 新增 11.5 节，解决时间窗口口径二义性 |

### v4.2 修订（基于 GPT 二次评审反馈）

| # | 问题 | 修正内容 |
|---|------|----------|
| 1 | GET_LOCK 文案仍有误导 | 修正"连接归还到池锁自动释放"的错误说法，明确必须调用 `RELEASE_LOCK` |
| 2 | 补丁1示例字段不一致 | 修正 `account.timezone` 为 `account.timezone_name` |
| 3 | spend>0 业务限制未说明 | 增加"热层优化策略"说明和"补集通道"后续扩展建议 |

### v4.3 修订（基于 GPT 三次评审反馈）

| # | 问题 | 修正内容 |
|---|------|----------|
| 1 | include_today 与表设计脱节 | 新增双表查询逻辑（ad_snapshots + daily_stats UNION），避免"包含今天"形同虚设 |
| 2 | 健康检查 yesterday 口径不对 | 改为按每个账户的时区计算"昨天"，避免跨时区误报/漏报 |
| 3 | 快照归档重复执行 | 新增 `daily_archive_status` 状态表，每个 (account, date) 只归档一次 |

### v4.4 修订（基于 GPT 四次评审反馈）

| # | 问题 | 修正内容 |
|---|------|----------|
| 1 | db.query 解包方式不一致 | 修正为 mysql2 标准写法：`const [rows] = await db.query(...)`，然后用 `rows[0]?.xxx` |
| 2 | UNION 字段一致性约束缺失 | 新增约束说明：两表字段名/类型必须一致，快照表必须有唯一索引避免重复累加 |

### v4.5 修订（基于 GPT 五次评审反馈 —— 文档 vs 代码一致性审查）

| # | 问题 | 修正内容 |
|---|------|----------|
| 1 | 文档未区分"已实现"vs"待实现" | 新增文档状态说明，所有功能标注 ✅/🚧/🔴 状态 |
| 2 | GET_LOCK 代码仍有连接泄漏风险 | 补丁4 增加 🔴 紧急修复警告，说明当前代码问题 |
| 3 | include_today 未落地，当前默认含今天 | 11.5 节标注 🚧 待实现，说明当前代码默认行为 |
| 4 | daily_archive_status 未建表 | 11.3 节标注 🚧 待实现 |
| 5 | UNION 示例与实际表结构不符 | 修正为实际实现方式（Node.js 层合并），说明 ad_snapshots 无 date 字段 |
| 6 | 任务清单和验收 Checklist 无状态标注 | 全部任务/验收项增加状态列 |

### v4.6 修订（基于 GPT 六次评审反馈 —— 状态标注准确性）

| # | 问题 | 修正内容 |
|---|------|----------|
| 1 | 新旧对比总览多项标✅实际未实现 | 修正：统一主同步任务、15分钟频率、Insights First、分层回补、健康检查、last_14d 均改为 🚧 |
| 2 | 阶段二～五无状态列 | 补全所有阶段的状态列 |
| 3 | 归档触发口径不一致 | 修正：06:00+ → 06:00-06:09（对齐实际代码窄窗口） |
| 4 | 热数据频率描述错误 | 修正：当前仍是 10 分钟，目标是 15 分钟 |
| 5 | 待实现功能汇总不完整 | 扩展汇总表，增加 Insights First、分层回补、健康检查等待实现项 |

### v4.7 修订（基于 GPT 七次评审反馈 —— 归档策略/include_today 最终对齐）

| # | 问题 | 修正内容 |
|---|------|----------|
| 1 | 归档窗口口径错误 | 修正：实际是每天 12:00 延迟归档（`forceAll=true`），不是 06:00-06:09 动态归档 |
| 2 | include_today 双表合并已实现但标待实现 | 修正：`queryMultiDayWithToday()` 已实现合并能力，只有"可配置开关"待实现 |
| 3 | 重复归档风险描述不准确 | 修正：已有完整性检查机制（expectedCount vs archivedCount），状态表改为"可选增强" |
| 4 | 时间轴示意图与实际不符 | 修正：12:00 快照归档，删除 06:00-06:09 |

### v4.8 修订（基于 GPT 5.2 评审反馈 —— Sliding Window 归档策略）

| # | 问题 | 修正内容 |
|---|------|----------|
| 1 | 跨时区延迟描述不准确 | 修正：12:00 延迟归档最长可达 23 小时（跨时区），不是 12 小时 |
| 2 | 归档策略需优化 | 采纳 Sliding Window 归档：每 10 分钟巡检，账户本地 02:00-02:09 触发（延迟约 2 小时） |
| 3 | ad_snapshots 唯一索引描述 | 修正：当前是 `UNIQUE(ad_id, sync_session_id)`，不是"无唯一索引" |
| 4 | ad_snapshots 改 AdsPolar 热表 | 暂不采纳（架构改动大），放在"中期优化计划" |

### v4.9 修订（基于 AdsPolar 完整设计逻辑 —— 热路径/冷路径分离 + 双窗口归档）

| # | 问题 | 修正内容 |
|---|------|----------|
| 1 | 归档策略需补充 12:00 深度对账 | 增加对账车：账户本地 12:00-12:09 触发深度对账（覆盖更新凌晨数据） |
| 2 | 热路径/冷路径职责不清晰 | 明确热路径（每15分钟同步Today）和冷路径（双窗口归档）的职责分离 |
| 3 | 状态表逻辑不完整 | 增加状态流转：PENDING → ARCHIVED（早班车）→ FINALIZED（对账车） |
| 4 | 统一主同步任务说明不完善 | 补充热路径实现说明，明确与冷路径的平行关系 |

---

## 十四、🔜 中期优化计划

> 以下是已识别但不阻塞当前实施的优化点，计划在系统稳定运行后实施。

### 14.1 拉数层改用显式 time_range（替代 date_preset）

**当前状态**：
- 拉数层（ingestorService）使用 `date_preset=last_3d` + `time_increment=1`
- 规则层（ruleDataService）使用显式 `since/until`

**潜在风险**：
- 如果 Facebook 改变 `date_preset` 的语义（如 `last_3d` 是否含今天），会影响数据口径
- 两层口径定义方式不一致，维护成本高

**优化方案**：
```javascript
// 拉数层也改为显式 time_range
const { since, until } = calculateTimeRange(account.timezone_name, daysBack, includeToday)

const insights = await fetchInsights(accountId, {
  time_range: { since, until },  // 替代 date_preset
  time_increment: 1
})
```

**实施时机**：阶段三完成后，系统稳定运行 1-2 周再统一。

---

### 14.2 ad_snapshots 改 AdsPolar 热表模式（架构级优化）

**当前状态**：
- `ad_snapshots` 表：多快照追加写入，唯一索引 `UNIQUE(ad_id, sync_session_id)`
- 查询需要 `ROW_NUMBER() OVER (PARTITION BY ad_id ORDER BY synced_at DESC)` 取最新快照
- 语义：同一广告在不同同步会话有多条记录

**问题**：
- 查询复杂（需要窗口函数）
- 语义不够清晰（"今天的数据"需要从多条快照中筛选）

**优化方案（AdsPolar 模式）**：

1. **表结构调整**：
   ```sql
   -- 新增 data_date 字段（数据所属自然日，按账户时区）
   ALTER TABLE ad_snapshots ADD COLUMN data_date DATE NOT NULL AFTER ad_id;
   
   -- 删除旧唯一索引
   ALTER TABLE ad_snapshots DROP INDEX uk_ad_session;
   
   -- 新增唯一索引（每账户每广告每天一行）
   ALTER TABLE ad_snapshots ADD UNIQUE KEY uk_account_ad_date (account_id, ad_id, data_date);
   ```

2. **写入逻辑改造**：
   ```javascript
   // 每次拉 today 时，计算 data_date（账户本地时区的今天）
   const localNow = DateTime.now().setZone(timezoneName)
   const dataDate = localNow.toISODate()  // 'YYYY-MM-DD'
   
   // UPSERT：每天一行，覆盖写
   INSERT INTO ad_snapshots (
     account_id, ad_id, data_date,
     spend, purchases, ..., synced_at, timezone_name
   ) VALUES (...)
   ON DUPLICATE KEY UPDATE
     spend = VALUES(spend),
     purchases = VALUES(purchases),
     ...,
     synced_at = VALUES(synced_at)
   ```

3. **查询逻辑简化**：
   ```javascript
   // 之前：需要窗口函数
   WITH ranked AS (
     SELECT *, ROW_NUMBER() OVER (PARTITION BY ad_id ORDER BY synced_at DESC) as rn
     FROM ad_snapshots WHERE account_id = ? AND synced_at >= ?
   ) SELECT * FROM ranked WHERE rn = 1
   
   // 之后：直接按 data_date 查询
   SELECT * FROM ad_snapshots 
   WHERE account_id = ? AND data_date = ?
   ```

**好处**：
- ✅ 查询更简单（不需要窗口函数）
- ✅ 语义清晰（"今天的数据" = `data_date = today`）
- ✅ 符合 AdsPolar 设计模式
- ✅ 归档逻辑更简单（直接按 `data_date` 归档）

**成本**：
- ⚠️ 架构级改动：需要改表结构、改写入逻辑、改查询逻辑
- ⚠️ 数据迁移：需要将现有多快照数据转换为"每天一行"（取最新快照）
- ⚠️ 全面测试：影响面大，需要充分测试

**实施时机**：系统稳定运行 1-2 个月后，作为架构优化项目推进。

---

**这份方案涵盖了所有改进点，并针对你的小型公司场景做了合理简化。准备好开始实施了吗？建议从「阶段一：底座加固」开始！**

