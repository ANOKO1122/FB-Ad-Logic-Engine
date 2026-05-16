---
name: timezone-normalization-and-logging
overview: 统一后端/数据库/前端的时区语义（UTC 存储 + 北京展示），修复执行日志少 8 小时以及冷却 debug 日志时区混乱的问题，并给出可执行的改造步骤。
todos:
  - id: db-timezone-utc
    content: 将 MySQL 会话/全局时区统一设置为 UTC（time_zone='+00:00'），并在连接初始化处确保生效。
    status: completed
  - id: execution-logs-utc
    content: 确认并规范 automation_logs.triggered_at 的写入为 UTC 时间，并用 SQL 验证新写入数据的 UTC/北京视角是否正确。
    status: completed
  - id: cooldown-timestamps-utc
    content: 确认并规范 rule_ad_execution_state.last_executed_at 写入为 UTC，保持 TIMESTAMPDIFF 基于 UTC 的 diffMin 逻辑。
    status: completed
  - id: cooldown-logging-enhance
    content: 增强 ruleExecutionStateService 中冷却 debug 日志，同时打印 lastAtUtc 和 lastAtBj，减少阅读时的时区混淆。
    status: completed
  - id: frontend-logs-beijing-display
    content: 验证执行日志前端页面继续使用 formatDateTimeBeijing 显示 UTC 时间转换后的北京时间，与 DB CONVERT_TZ 查询结果对齐。
    status: completed
  - id: optional-history-migration
    content: 根据需要规划并执行历史数据从“北京时间值”到“UTC 值”的一次性迁移，确保老数据在 UTC 语义下也正确。
    status: pending
  - id: update-timezone-docs
    content: 更新 0时区转换解决方案.md 及关键代码注释，写清楚“DB 存 UTC、前端显示北京、业务账户时区单独处理”的最终规范。
    status: completed
isProject: false
---

### 总体目标

- **统一原则**：
                                                                - 所有写入 MySQL `timestamp` 字段的时间一律使用 **UTC**（系统时间基准）。
                                                                - 所有面向用户/你自己查看的时间（前端 UI、调试 SQL）一律显示为 **北京时区（UTC+8）**，除非特别标注是 UTC。
                                                                - 业务逻辑里需要“账户时区”的地方（规则统计窗口、ad_snapshots 的 `data_date` 等），继续按“账户时区 / 数据时区”实现，不与系统 UTC 相互污染。
- **当前两大问题**：

                                                                1. 前端执行日志时间比你在 DB/本地看到的时间 **少 8 小时**。
                                                                2. 冷却日志 `lastAt=...Z` 与你预期的北京时间 **相差 8 小时**，难以直观判断冷却间隔。

- **改造后的效果**：
                                                                - `automation_logs.triggered_at` 在 DB 中是真正的 UTC；前端执行日志统一显示为北京时间，与你右下角时间一眼对齐，不再少 8 小时。
                                                                - 冷却日志中既能看到 `lastAtUtc`（UTC）也能看到 `lastAtBj`（北京），你用北京时间对比就能简单判断“上次执行是什么时刻”“冷却过去了多久”。
                                                                - 所有新写的时间字段（如 `last_executed_at`, `synced_at`, `triggered_at` 等）都有明确语义：**存 UTC → 显示时由前端或调试 SQL 再转北京**。

---

### 第 1 步：梳理和锁定所有关键时间字段

聚焦这次需要统一的几个关键表/字段（仅列出和当前问题相关、且改动敏感的）：

- `[server/db/schema.js]`
                                                                - `automationLogs.triggeredAt`：执行日志的触发时间（当前被你用来在前端展示执行时间）。
                                                                - `automationLogs.createdAt`：日志记录的创建时间（如果有，用于排序或调试）。
                                                                - `ruleAdExecutionState.lastExecutedAt`：冷却表中“上次执行时间”（现在 `TIMESTAMPDIFF` 用它和 `UTC_TIMESTAMP()` 来算 diffMin）。
                                                                - `dailyArchiveStatus.updatedAt` 等：归档状态更新时间（本次可以先保持现状，仅注意以后统一用 UTC）。
- 其他非核心时间字段（先记录，不必这次全部改）：
                                                                - `ad_snapshots.synced_at` / `data_date`：同步时间 + 账户本地自然日（`data_date` 按账户时区写入，继续保持；`synced_at` 推荐改为 UTC）。
                                                                - `daily_stats.date` / `timezone_name`：按“账户时区 + 自然日”存储，保持现有含义不动。

**目标**：本次执行优先把 `automationLogs.triggeredAt` 和 `ruleAdExecutionState.lastExecutedAt` 的写入/读取语义统一到 UTC 基准，其它时间字段以后按同一规范渐进统一。

---

### 第 2 步：统一数据库时区配置为 UTC

**原因**：现在 MySQL `@@session.time_zone = SYSTEM`（北京时区），所有 `timestamp` 字段按本地时区读写，这与“代码里假设 DB session 已 UTC”的注释不一致，是 8 小时偏差的根源之一。

**实施要点**：

1. **MySQL 配置层**（推荐）：

                                                                                                - 在 MySQL 配置文件 `my.cnf` 中加入：
                                                                                                                                                                - `[mysqld]`
                                                                                                                                                                                                                                - `default_time_zone = '+00:00'`
                                                                                                - 重启 MySQL 后，用 `SELECT NOW(), UTC_TIMESTAMP();` 验证两者几乎相等（差 <1 秒），说明会话时区已为 UTC。

2. **Node 连接层兜底**（如果不方便改全局配置，可在连接建立后显式设置）：

                                                                                                - 在统一的连接初始化处（例如 `[server/db/connection.js]` 里创建 pool 后）：
                                                                                                                                                                - 调用一次 `SET time_zone = '+00:00';`，保证所有来自应用的会话都在 UTC 下运行。

3. **验证**：

                                                                                                - 连接 MySQL 后执行：
     ```sql
     SELECT @@global.time_zone, @@session.time_zone, NOW(), UTC_TIMESTAMP();
     ```

                                                                                                - 期望输出：`@@session.time_zone = +00:00` 且 `NOW() ≈ UTC_TIMESTAMP()`。

> 这一步完成之后，DB 层已经“站在 UTC”，后续任何 `timestamp` 插入/更新都将以 UTC 语义解释。

---

### 第 3 步：规范写入 `automation_logs.triggered_at`（执行日志）

当前实现位置：`[server/services/actionExecutorService.js]` 中 `executeActionsForAd` 的审计日志写入逻辑：

````js
// 约 L432 起
const now = new Date()
await db.insert(automationLogs).values({
  ...,
  triggeredAt: now,
})
``

在 DB 时区切到 UTC 之后：

- `new Date()` 仍然表示“此刻的绝对时间点”（JS Date 内部用 UTC 存 ms since epoch）；
- MySQL 会话已为 UTC，`timestamp('triggered_at')` 在插入这个 `Date` 时，会把它直接当作 UTC 存进去；
- 你在 MySQL 中 `SELECT triggered_at` 时看到的就是 UTC 时间值，例如 `2026-03-03 15:17:03`。

**规范要求**：

- 保持现在 `const now = new Date()` 的写法，可以视作“写入当前 UTC 时间”；
- 不再在写入前或写入后人为加/减 8 小时；
- 注释里要改为：“`triggered_at` 存储 UTC 时间，由前端统一转换为北京时区展示”。

**验证查询**：

- 改完后，执行：

  ```sql
  SELECT
    id,
    triggered_at         AS raw_utc,
    CONVERT_TZ(triggered_at, '+00:00', '+08:00') AS triggered_bj,
    UTC_TIMESTAMP()      AS now_utc,
    CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', '+08:00') AS now_bj
  FROM automation_logs
  ORDER BY id DESC
  LIMIT 5;
  ```

- 期望：
 - `raw_utc` 与 `now_utc` 同一天附近，代表 UTC 时间；
 - `triggered_bj` 和你右下角时间以及业务记忆的“真实执行时间”对齐。

> 执行日志这一步的核心：**让 DB 里真正存 UTC，给前端的也是 UTC，前端只做一次「UTC→北京」转换，不再少 8 小时。**

---

### 第 4 步：规范写入/使用 `ruleAdExecutionState.lastExecutedAt`（冷却）

当前冷却相关逻辑：

- 写入位置（批量 upsert 冷却状态）：在某个 service（例如 `[server/services/cronService.js]` 或 `ruleExecutionStateService.js` 的 `upsertRuleAdExecutionStateBatch`）中，会将本轮执行完成后的 `(rule_id, scope_key, last_executed_at)` 写回 DB；
- 读取位置（你已经看过）：

```js
// [server/services/ruleExecutionStateService.js]
const [rows] = await pool.execute(
  `SELECT
     last_executed_at,
     TIMESTAMPDIFF(MINUTE, last_executed_at, UTC_TIMESTAMP()) AS diff_min
   FROM rule_ad_execution_state
   WHERE rule_id = ? AND scope_key = ?`,
  [ruleId, scopeKey]
)
````

**规范要求**：

1. **写入 last_executed_at 时，必须使用 UTC**：

                                                                                                - 如果现在的 upsert SQL 用的是 `NOW()`，要改成 `UTC_TIMESTAMP()`；
                                                                                                - 如果是通过 Drizzle/JS `new Date()` 写入，则依赖第 2 步完成后 DB 会话已经为 UTC，那么 `new Date()` 会被当作 UTC 存。

2. **冷却 diff 计算维持 UTC 基准**：

                                                                                                - `TIMESTAMPDIFF(MINUTE, last_executed_at, UTC_TIMESTAMP())` 在 DB 时区为 UTC 的前提下语义完全正确：
                                                                                                                                                                - 两个值都是 UTC → diffMin = 真实过去分钟数；

3. **只在日志展示层处理「UTC vs 北京」**：
```js
// 当前位置：[server/services/ruleExecutionStateService.js]
const lastAt = row.last_executed_at   // 这是 UTC 时间
const diffMin = Number(row.diff_min ?? 0)

const lastAtUtc = lastAt ? new Date(lastAt).toISOString() : 'null'
const lastAtBj  = lastAt
  ? DateTime.fromJSDate(lastAt, { zone: 'utc' })
      .setZone('Asia/Shanghai')
      .toFormat('yyyy-MM-dd HH:mm:ss')
  : 'null'

logger.debug(
  `   [ruleExecutionState] isCooldownDue(DB) rule=${ruleId} scope=${scopeKey} interval=${intervalMin} lastAtUtc=${lastAtUtc} lastAtBj=${lastAtBj} diffMin=${diffMin.toFixed(2)} due=${due}`
)
```


- 之后你在终端里只看 `lastAtBj` 一列，就能直接用北京时区理解“上次执行时间”，`diffMin` 则是 UTC 下的分钟差（但和北京视角下差值一致，因为两端统一基于 UTC）。

**验证查询**：

- 用你刚才那条 SQL 再查一次：
  ```sql
  SELECT
    last_executed_at AS raw_utc,
    CONVERT_TZ(last_executed_at, '+00:00', '+08:00') AS last_executed_bj,
    UTC_TIMESTAMP() AS now_utc,
    TIMESTAMPDIFF(MINUTE, last_executed_at, UTC_TIMESTAMP()) AS diff_min_utc
  FROM rule_ad_execution_state
  WHERE rule_id = 461
    AND scope_key = 'budget_campaign:120240284853480760';
  ```

- 期望：
                                                                - `raw_utc` 显示 UTC；`last_executed_bj` 是你熟悉的北京时间；
                                                                - `diff_min_utc` 与你手算 "now_bj - last_executed_bj" 的分钟差一致；
                                                                - 日志里的 `lastAtUtc`/`lastAtBj` 与这里一致。

> 冷却这块的关键：**逻辑上用 UTC 计算，展示时多打印一份北京时区，避免你肉眼看时出现“到底差几小时”的错觉。**

---

### 第 5 步：前端时间工具与执行日志的配合

前端当前时间工具（`[src/utils/dateTime.js]`）已经按“后端返回 UTC → 前端转北京”设计：

```js
export const DISPLAY_TIMEZONE = 'Asia/Shanghai'

export function parseUTC(dateStr) {
  if (!dateStr) return null
  if (dateStr.includes('T') || dateStr.includes('Z')) {
    return DateTime.fromISO(dateStr, { zone: 'utc' })
  }
  return DateTime.fromSQL(dateStr, { zone: 'utc' })
}

export function formatDateTimeBeijing(dateStr) {
  const dt = parseUTC(dateStr)
  if (!dt || !dt.isValid) return '-'
  return dt.setZone(DISPLAY_TIMEZONE).toFormat('yyyy-MM-dd HH:mm:ss')
}
```

以及执行日志页面 `Logs.vue` 中：

```js
import {
  formatTimeBeijing,
  formatDateBeijing,
  formatDateTimeBeijing,
  formatDateTimeBeijingLocale
} from '../utils/dateTime'

const formatDateTime = (dateStr) => formatDateTimeBeijing(dateStr)
```

在你完成第 2 步、第 3 步后：

- `automation_logs.triggered_at` 是 UTC；
- API 把 `triggered_at` 以 ISO 字符串形式返回前端（不再提前 +8 或改成本地）；
- 前端对这条字段继续使用 `formatDateTimeBeijing` 即可，显示就是北京时间；
- 执行日志列表里的时间就会与你 DB 查询 `CONVERT_TZ(triggered_at, '+00:00', '+08:00')` 的结果一致，不再“少 8 小时”。

如需兼容将来有“本地时间直接传前端”的场景，可以额外在 `dateTime.js` 中提供 `formatDateTimeLocalBeijing`（直接按 `Asia/Shanghai` 解析，不做 `zone: 'utc'`），但**本次执行方案里，建议彻底统一为「后端给 UTC、前端只转北京」的模式，避免混乱。**

---

### 第 6 步：历史数据的可选迁移

当前 DB 里的数据情况：

- `automation_logs.triggered_at`：老数据是按北京时区写入的；在你把 MySQL 时区改为 UTC 之后，新写入的会是 UTC；
- `rule_ad_execution_state.last_executed_at`：同理，老数据是本地时间，新数据将是 UTC。

如果你在乎历史数据的绝对时间精确性（例如以后要做跨时区分析或对冷却进行长时间回溯），可以一次性做数据迁移：

1. **在切换 MySQL 时区之前**，对相关表做备份（导出或 `CREATE TABLE ... LIKE ...` + `INSERT SELECT`）。
2. **在切换后**，对于历史记录执行时间减 8 小时（从北京→UTC）：
   ```sql
   -- automation_logs：仅对老数据执行一次
   UPDATE automation_logs
   SET triggered_at = DATE_SUB(triggered_at, INTERVAL 8 HOUR)
   WHERE triggered_at < '某个明确的分界时间点';  -- 分界点是你完成 UTC 切换的时间
   
   -- rule_ad_execution_state：冷却表，如果希望精确，可以类似处理
   UPDATE rule_ad_execution_state
   SET last_executed_at = DATE_SUB(last_executed_at, INTERVAL 8 HOUR)
   WHERE last_executed_at < '分界时间点';
   ```

3. **验证**：

                                                                                                - 用 `CONVERT_TZ(..., '+00:00', '+08:00')` 看几条老记录，确认北京视角下的时间仍然正确；
                                                                                                - 前端执行日志在老记录上显示也合理，不再出现整体偏 8 小时的错位。

> 这步属于「完美主义/长期一致性」工作，可在冷却和执行日志确认正常后再择机处理。

---

### 第 7 步：文档与代码约定的更新

最后，把这次约定写进你的工程文档，避免以后再踩新坑：

- 在 `[docs/0时区转换解决方案.md]` 里补充最终规范：
                                                                - **DB & 后端**：所有 `timestamp` 字段存储 UTC（通过 MySQL `time_zone='+00:00'` + Node `Date` 实现）；
                                                                - **前端**：统一假设时间字段为 UTC，使用 `utils/dateTime.js` 将其转换为北京时区展示；
                                                                - **业务“账户时区”**：仍由 `ruleDataService` 等模块的 `timezoneName` / `dataTimezoneUsed` 控制，不与系统 UTC 混淆。
- 在代码注释中：
                                                                - `actionExecutorService`：说明 `triggeredAt` 存 UTC；
                                                                - `ruleExecutionStateService`：说明 `last_executed_at` 存 UTC、冷却 diff 以 UTC 计算，日志中额外打印北京时间仅为调试方便。

---

### 完成后的整体效果回顾

- **执行日志页面**：
                                                                - 页面上“执行时间”与 `SELECT CONVERT_TZ(triggered_at, '+00:00', '+08:00')` 的时间一致，与当前本地时间、你记忆中的真实动作时间对齐；
                                                                - 不会再出现“少 8 小时”的情况。

- **冷却日志 debug**：
                                                                - 每次 `isCooldownDue` 输出：
                                                                                                                                - `lastAtUtc=...Z`（绝对 UTC 时间）
                                                                                                                                - `lastAtBj=yyyy-MM-dd HH:mm:ss`（北京时区）
                                                                                                                                - `diffMin=...`（基于 UTC 的分钟差）
                                                                - 你只看 `lastAtBj` 和 `diffMin`，就能判断“上次执行是什么时间”“冷却过去多久”，不会再纠结 8/16 小时的问题。

- **系统整体时区行为**：
                                                                - DB、后端逻辑都建立在 UTC 之上，前端和日常 SQL 查询通过显式 `CONVERT_TZ` 或 `formatDateTimeBeijing` 在北京时区下展示；
                                                                - 不会再出现「有的字段按本地写、有的按 UTC 读、有的前端又当 UTC 转一次」这种多重混合情况；
                                                                - 以后再新增任何时间字段，只要遵守“写 UTC → 展示时显式转北京”的规范，就可以避免类似的时区 bug。