# 一账户多负责人改造方案 V2 — `owner_id INT` → `owner_ids JSON`

> 日期：2026-06-10  
> 目的：将 `account_mappings` 从「一个广告账户仅对应一个负责人」改为「一个广告账户可对应多个负责人」  
> 策略：**不动 UNIQUE 约束**，将 `owner_id INT` 改为 `owner_ids JSON` 数组

---

## 一、为什么这个方案更好

### 对比三个方案

| | 方案 A（新建中间表） | 方案 B（去 UNIQUE） | **V2（owner_id → JSON）** |
|---|---|---|---|
| 改约束 | 不改 | 去 UNIQUE，加联合唯一 | **不改** |
| 一行一账户 | ✅ | ❌（同账户多行） | ✅ |
| 数据冗余 | 无 | `fb_account_name`/`timezone` 重复 N 份 | **无** |
| 鉴权 SQL | JOIN 新表 | 几乎不变 | `=` → `JSON_CONTAINS` |
| 数据同步/调度影响 | 零 | 🔴 多处需加 DISTINCT | **🟢 零** |
| 改 SQL 总数 | ~15（含新表管理） | ~25+（含去重修复） | **~20** |
| 改动文件数 | ~8 | ~10 | **~6** |

### 核心优势

**数据管道的读写模型完全不变**。`account_mappings` 仍然一行 = 一个账户，UNIQUE 约束仍然有效。
所有 `SELECT fb_account_id FROM account_mappings WHERE is_active = 1` 的查询结果不变。
变的是"这个账户归谁"的表达——从 `owner_id = 1` 变成 `owner_ids = [1, 2, 3]`。

---

## 二、数据库变更

### 2.1 MySQL 版本确认

```
当前版本：MySQL 8.0.45
JSON 数据类型：✅ 原生支持
多值索引（Multi-Valued Index）：✅ 8.0.17+ 支持
```

### 2.2 DDL

```sql
-- Step 1: 备份
CREATE TABLE account_mappings_backup_20260610 AS SELECT * FROM account_mappings;

-- Step 2: 新增 JSON 列
ALTER TABLE account_mappings 
ADD COLUMN owner_ids JSON DEFAULT NULL COMMENT '负责人ID数组，如 [1,2,3]' AFTER owner_id;

-- Step 3: 迁移现有数据（owner_id → owner_ids）
UPDATE account_mappings 
SET owner_ids = JSON_ARRAY(owner_id) 
WHERE owner_ids IS NULL;

-- Step 4: 创建多值索引用于 JSON_CONTAINS 查询加速
-- ALTER TABLE account_mappings 
-- ADD INDEX idx_owner_ids ((CAST(owner_ids AS UNSIGNED ARRAY)));
-- 注：多值索引在 MySQL 8.0.17+ 可用，当前 65 行数据量下非必须

-- Step 5: 验证迁移
SELECT fb_account_id, owner_id, owner_ids FROM account_mappings LIMIT 5;

-- Step 6: 确认无误后，后续可删除旧列（建议保留一个版本作为回退）
-- ALTER TABLE account_mappings DROP COLUMN owner_id;
-- ALTER TABLE account_mappings RENAME COLUMN owner_ids TO owner_id;
```

**说明**：
- `owner_id` 旧列暂时保留，与 `owner_ids` 并存，方便回退
- `owner_ids` 存储格式：`[1]`（单个负责人）、`[1, 2, 3]`（多个负责人）
- 外键约束 `fk_account_owner (owner_id → owners.id)` 在旧列上，JSON 列无法建立传统 FK，由应用层保证数据完整性

### 2.3 外键约束处理

旧 FK `fk_account_owner FOREIGN KEY (owner_id) REFERENCES owners(id) ON DELETE RESTRICT` 在 `owner_id` 列上。JSON 列无法建 FK，需要在应用层保证：
- Admin 删除负责人前，检查 `JSON_CONTAINS(owner_ids, ?)` 并清理
- 代码层面保证 `owner_ids` 中的值都是有效的 `owners.id`

---

## 三、后端改造清单（精确到文件和行号）

### 3.1 `server/utils/accountAccess.js` — 鉴权核心（2 处）

这是唯一必须改的鉴权入口。其他所有鉴权要么调用此函数，要么用相同 SQL 模式。

**改动**：`owner_id = ?` → `JSON_CONTAINS(owner_ids, ?)`

```js
// 旧：第 41 行
const [rows] = await pool.execute(
  `SELECT 1 FROM account_mappings 
   WHERE fb_account_id = ? AND owner_id = ? AND is_active = 1 
   LIMIT 1`,
  [id, ownerId]
)

// 新：
const [rows] = await pool.execute(
  `SELECT 1 FROM account_mappings 
   WHERE fb_account_id = ? AND JSON_CONTAINS(owner_ids, ?) AND is_active = 1 
   LIMIT 1`,
  [id, String(ownerId)]
)
```

> `JSON_CONTAINS` 第二个参数需要是 JSON 字面量，传入 `String(ownerId)` 即可（如 `'1'` 匹配 `[1,2,3]`）。

`hasAccountAccess`（第 68 行）同改。

### 3.2 `server/routes/rules.js` — 规则鉴权（6 处）

| 行号 | 当前 SQL | 改动 |
|------|----------|------|
| 422 | `SELECT 1 FROM account_mappings WHERE fb_account_id = ? AND owner_id = ? AND is_active = 1 LIMIT 1` | `owner_id = ?` → `JSON_CONTAINS(owner_ids, ?)` |
| 761 | 同上模式 | 同上 |
| 795 | 同上 | 同上 |
| 928 | 同上 | 同上 |
| 989 | 同上 | 同上 |
| 1261 | `SELECT owner_id FROM account_mappings WHERE fb_account_id = ? AND is_active = 1 LIMIT 1` | `SELECT owner_ids FROM ...`，JS 侧 `const ownerId = rows[0]?.owner_ids?.[0] ?? 0` |

### 3.3 `server/routes/scheduledTasks.js` — 定时任务鉴权（3 处）

| 行号 | 改动 |
|------|------|
| 391 | `owner_id = ?` → `JSON_CONTAINS(owner_ids, ?)` |
| 581 | 同上 |
| 593 | 同上 |

### 3.4 `server/services/cronService.js` — 规则调度鉴权（1 处）

| 行号 | 改动 |
|------|------|
| 805 | `SELECT 1 FROM account_mappings WHERE owner_id = ? AND is_active = 1 AND fb_account_id = ?` → `JSON_CONTAINS(owner_ids, ?)` |

> 注意：cronService 的 `SELECT DISTINCT fb_account_id`（1663/1770 行）完全不碰 `owner_id`，**不受影响**。

### 3.5 `server/services/ruleEnableGateService.js` — 规则启停校验（1 处）

| 行号 | 改动 |
|------|------|
| 114 | `owner_id = ?` → `JSON_CONTAINS(owner_ids, ?)` |

### 3.6 `server/services/accountSyncService.js` — 账户列表筛选（1 处）

```js
// 旧：第 120 行（非 admin 用户获取自己负责的账户列表）
WHERE owner_id = ? AND is_active = 1

// 新：
WHERE JSON_CONTAINS(owner_ids, ?) AND is_active = 1
```

### 3.7 `server/routes/system.js` — 系统健康页（1 处）

```js
// 旧：第 453 行
WHERE am.is_active = 1 AND am.owner_id = ?

// 新：
WHERE am.is_active = 1 AND JSON_CONTAINS(am.owner_ids, ?)
```

### 3.8 `server/routes/admin.js` — 管理端 CRUD（5 处）

#### 3.8.1 Assign 逻辑（第 436-447 行）

```js
// 旧：存在则 UPDATE 替换 owner_id，否则 INSERT
const [accounts] = await pool.execute(
  'SELECT id FROM account_mappings WHERE fb_account_id = ?', [fb_account_id]
)
if (accounts.length === 0) {
  await pool.execute('INSERT INTO ... (owner_id) VALUES (?)', [owner_id])
} else {
  await pool.execute('UPDATE account_mappings SET owner_id = ? WHERE fb_account_id = ?', [owner_id, fb_account_id])
}

// 新：追加到 JSON 数组（去重）
const [rows] = await pool.execute(
  'SELECT id, owner_ids FROM account_mappings WHERE fb_account_id = ?', [fb_account_id]
)
if (rows.length === 0) {
  // 首次分配：创建记录
  await pool.execute(
    'INSERT INTO account_mappings (fb_account_id, owner_ids, is_active) VALUES (?, JSON_ARRAY(?), 1)',
    [fb_account_id, owner_id]
  )
} else {
  // 已有记录：检查是否已在数组中，不在则追加
  const currentIds = rows[0].owner_ids || []
  if (Array.isArray(currentIds) && currentIds.includes(owner_id)) {
    return res.json({ success: true, message: '该负责人已绑定此账户' })
  }
  await pool.execute(
    'UPDATE account_mappings SET owner_ids = JSON_ARRAY_APPEND(COALESCE(owner_ids, JSON_ARRAY()), ?, ?) WHERE fb_account_id = ?',
    ['$', owner_id, fb_account_id]
  )
}
```

#### 3.8.2 移除负责人（新增端点）

```js
// DELETE /api/admin/account-mappings/:fb_account_id/owner/:owner_id
// 从 JSON 数组中移除指定 owner_id；若数组变空则标记 is_active=0
await pool.execute(
  `UPDATE account_mappings 
   SET owner_ids = JSON_REMOVE(owner_ids, JSON_UNQUOTE(JSON_SEARCH(owner_ids, 'one', ?))) 
   WHERE fb_account_id = ?`,
  [String(owner_id), fb_account_id]
)
// 检查是否为空数组
const [check] = await pool.execute(
  'SELECT owner_ids FROM account_mappings WHERE fb_account_id = ?', [fb_account_id]
)
if (!check[0]?.owner_ids || check[0].owner_ids.length === 0) {
  await pool.execute(
    'UPDATE account_mappings SET is_active = 0 WHERE fb_account_id = ?', [fb_account_id]
  )
}
```

#### 3.8.3 Status 切换（第 456-479 行）

**保持不变**。`is_active` 仍然是账户级属性（`WHERE fb_account_id = ?`），不需要按映射行控制。因为 JSON 方案中一行仍是"一个账户"，启用/停用就是账户级别的。

```js
// 不变：按 fb_account_id 全局开关（一行=一个账户）
UPDATE account_mappings SET is_active = ? WHERE fb_account_id = ?
```

#### 3.8.4 负责人列表统计（第 255 行）

```js
// 旧：
(SELECT COUNT(*) FROM account_mappings am WHERE am.owner_id = o.id AND am.is_active = 1) AS ad_account_count

// 新：
(SELECT COUNT(*) FROM account_mappings am WHERE JSON_CONTAINS(am.owner_ids, ?) AND am.is_active = 1) AS ad_account_count
```

> 注意：这里不再是子查询直接引用外层 `o.id`，需要调整为参数绑定或 `CAST(o.id AS JSON)`。

#### 3.8.5 删除负责人级联（第 376 行）

```js
// 旧：
UPDATE account_mappings SET owner_id = ? WHERE owner_id = ?
// → 迁移到"无"负责人

// 新：从所有包含该 owner_id 的 JSON 数组中移除
UPDATE account_mappings 
SET owner_ids = JSON_REMOVE(owner_ids, JSON_UNQUOTE(JSON_SEARCH(owner_ids, 'one', ?)))
WHERE JSON_CONTAINS(owner_ids, ?)
// 然后检查是否有账户变成空数组，标记 is_active=0
```

#### 3.8.6 Batch Import（第 589 行）

```js
// 旧：ON DUPLICATE KEY UPDATE owner_id = VALUES(owner_id)
// 新：INSERT ... ON DUPLICATE KEY UPDATE 
//   owner_ids = JSON_ARRAY_APPEND(COALESCE(owner_ids, JSON_ARRAY()), '$', VALUES(owner_id))
//   （注：fb_account_id 仍是 UNIQUE，所以 ON DUPLICATE KEY 走 UPDATE 分支）
```

> 简化做法：先查出已有记录的 `owner_ids`，在应用层合并去重后再 UPDATE。

### 3.9 `server/services/ingestorService.js` — 数据同步（1 处微调）

**所有同步入口查询完全不变**（只查 `fb_account_id`）。唯一需要微调的是读取 `owner_id` 写入快照/统计表的地方：

```js
// 旧：从 account_mappings 读 owner_id 存入 snaphsot/daily_stats
const [rows] = await pool.execute(
  'SELECT owner_id FROM account_mappings WHERE fb_account_id = ? AND is_active = 1 LIMIT 1',
  [accountId]
)
const ownerId = rows[0]?.owner_id

// 新：取 owner_ids 数组中第一个
const [rows] = await pool.execute(
  'SELECT owner_ids FROM account_mappings WHERE fb_account_id = ? AND is_active = 1 LIMIT 1',
  [accountId]
)
const ownerId = rows[0]?.owner_ids?.[0] ?? 0
```

> `ad_snapshots.owner_id` 和 `daily_stats.owner_id` 仍然是 INT 列，存储"主要"负责人的 ID（取数组第一个），满足审计追溯即可。权限不依赖这些表的 `owner_id`。

---

## 四、完全不受影响的模块（零改动）

| 模块 | 原因 |
|------|------|
| `ingestorService.js` — 账户列表查询 | `SELECT fb_account_id ... FROM account_mappings WHERE is_active = 1` |
| `ingestorService.js` — 时区更新 | `UPDATE account_mappings SET timezone_name = ? WHERE fb_account_id = ?` |
| `cronService.js` — 规则调度账户列表 | `SELECT DISTINCT fb_account_id FROM account_mappings WHERE is_active = 1` |
| `structureSyncService.js` — 结构同步 | `FROM account_mappings am ... WHERE am.is_active = 1` |
| `ruleDataService.js` — 时区查询 | `SELECT timezone_name FROM account_mappings WHERE fb_account_id = ? LIMIT 1` |
| `scheduledTaskService.js` — 时区回退 | 同上 |
| `system.js` — 自动化日志过滤 | 使用 `al.owner_id`（规则创建者，不是 account_mappings 的） |
| `rules.js` — 规则创建者 owner_id | `rules.owner_id` = 创建者的 owner_id，与账户归属无关 |
| `scheduledTasks.js` — 任务创建者 owner_id | `scheduled_tasks.owner_id` 同理 |
| `admin.js` — 用户管理 | `users.owner_id` 与 account_mappings 无关 |
| `auth.js` — 注册 | 用户绑定一个主要 owner_id，不变 |

---

## 五、前端改造清单

### 5.1 `AdminAccountMapping.vue`（改动最大）

| 区域 | 改动 |
|------|------|
| **表格展示** | 一行一个账户不变；负责人列展示多个名称，如"张三、李四" |
| **添加负责人** | 选择账户 + 选择负责人 → 调用 assign API（后端 JSON_ARRAY_APPEND） |
| **移除负责人** | 每个负责人标签旁有 × 按钮 → 调用 `DELETE /api/admin/account-mappings/:fb_account_id/owner/:owner_id` |
| **启用/停用** | **不变**：按 `fb_account_id` 全局开关 |
| **批量导入** | 格式不变，重复组合静默跳过 |

**推荐 UI**：
```
表格列：账户ID | 账户名 | 负责人 | 状态 | 操作
         act_123 | 测试账户 | [张三 ×] [李四 ×] [+ 添加] | 启用 | [停用]
         act_456 | 另个账户 | [张三 ×]             [+ 添加] | 启用 | [停用]
```

### 5.2 `AdminOwners.vue`

影响量统计改为：
```sql
SELECT COUNT(*) FROM account_mappings WHERE JSON_CONTAINS(owner_ids, ?) AND is_active = 1
```

### 5.3 其他前端页面

| 页面 | 改动 |
|------|------|
| `AdminUsers.vue` | 不变 |
| `Register.vue` / `Bind.vue` | 不变 |
| `RuleManager.vue` | 不变 |
| `ScheduledTasks.vue` | 不变 |

---

## 六、API 变更汇总

### 新增端点

| 方法 | 路径 | 说明 |
|------|------|------|
| `DELETE` | `/api/admin/account-mappings/:fb_account_id/owner/:owner_id` | 从账户的负责人列表中移除指定负责人 |

### 行为变更端点

| 方法 | 路径 | 旧行为 | 新行为 |
|------|------|--------|--------|
| `POST` | `/api/admin/account-mappings/assign` | 存在则替换 owner_id | 存在则追加到 owner_ids 数组（去重） |
| `PATCH` | `/api/admin/account-mappings/status` | 不变 | **不变**（仍按 fb_account_id 全局开关） |
| `DELETE` | `/api/admin/owners/:id` | 迁移 owner_id 到「无」 | 从所有 owner_ids 数组中移除该 id |

### 无需变更的端点

| 方法 | 路径 | 原因 |
|------|------|------|
| `GET` | `/api/admin/account-mappings` | 一行一账户不变，返回 `owner_ids` 字段 |
| `GET` | `/api/admin/account-mappings?owner_id=N` | `SELECT ... WHERE JSON_CONTAINS(owner_ids, N)` |
| **所有数据同步、规则调度、结构同步** | — | 全都不查 owner_id 条件 |

---

## 七、边界情况与风险

### 7.1 JSON_CONTAINS 性能

当前 `account_mappings` 只有 **65 行**，`JSON_CONTAINS` 全表扫描完全无压力。未来数据量增长时可加多值索引：
```sql
ALTER TABLE account_mappings ADD INDEX idx_owner_ids ((CAST(owner_ids AS UNSIGNED ARRAY)));
```

### 7.2 外键约束丧失

`owner_ids` JSON 列无法建立传统 FK。风险低：`owner_ids` 中的值来自管理端可控的下拉选择，不会出现非法值。可在 admin 删除负责人时应用层校验并清理。

### 7.3 `owner_ids` 空数组处理

当从账户移除最后一个负责人时，`owner_ids` 变为 `[]`。策略：
- 自动设置 `is_active = 0`（账户不再对普通用户可见）
- 或保留 `is_active = 1` 但鉴权时 `JSON_CONTAINS([], ?)` 始终返回 false

### 7.4 旧 `owner_id` 列兼容期

建议保留 `owner_id` 旧列一个版本周期，新旧列同时写入：
- 写入 `owner_ids` 的同时，更新 `owner_id` = 数组第一个元素
- 读取时优先用 `owner_ids`，`owner_id` 作为兜底
- 下一版本删除 `owner_id` 列

---

## 八、实施步骤

### 阶段 1：数据库迁移（停机 5 分钟）

```sql
CREATE TABLE account_mappings_backup_20260610 AS SELECT * FROM account_mappings;
ALTER TABLE account_mappings ADD COLUMN owner_ids JSON DEFAULT NULL AFTER owner_id;
UPDATE account_mappings SET owner_ids = JSON_ARRAY(owner_id) WHERE owner_ids IS NULL;
-- 验证
SELECT fb_account_id, owner_id, owner_ids FROM account_mappings LIMIT 5;
```

### 阶段 2：后端改造（预计 1-2 天）

| 顺序 | 文件 | 改动量 | 说明 |
|------|------|--------|------|
| 1 | `server/utils/accountAccess.js` | 2 处 | `=` → `JSON_CONTAINS` |
| 2 | `server/services/accountSyncService.js` | 1 处 | 账户列表筛选 |
| 3 | `server/services/cronService.js` | 1 处 | 调度鉴权 |
| 4 | `server/services/ruleEnableGateService.js` | 1 处 | 启停校验 |
| 5 | `server/routes/rules.js` | 6 处 | 鉴权 + owner_id 读取 |
| 6 | `server/routes/scheduledTasks.js` | 3 处 | 鉴权 |
| 7 | `server/routes/system.js` | 1 处 | 健康页筛选 |
| 8 | `server/routes/admin.js` | 5 处 | CRUD 逻辑重写 |
| 9 | `server/services/ingestorService.js` | 1 处 | 取 owner_ids[0] 写快照 |

### 阶段 3：前端改造（预计 1 天）

| 顺序 | 文件 | 工作量 |
|------|------|--------|
| 1 | `AdminAccountMapping.vue` | 负责人多选展示、添加/移除交互 |
| 2 | `AdminOwners.vue` | 影响量计数调整 |

### 阶段 4：回归测试

- [ ] 同一账户分配给两个负责人 → 两个负责人的 staff 用户都能看到该账户数据
- [ ] 从账户移除一个负责人 → 该负责人不再能看到数据，另一负责人不受影响
- [ ] 移除最后一个负责人 → 账户 is_active 自动置 0
- [ ] 规则创建/执行 → 账户鉴权正常
- [ ] 定时任务 → 账户鉴权正常
- [ ] 数据同步 → 快照/统计正常写入（owner_id 取数组首位）
- [ ] 管理员 CRUD → 添加/移除负责人正常
- [ ] 旧 owner_id 列数据一致性验证

---

## 九、改动量估算

| 层级 | 改动文件数 | 预估工时 |
|------|-----------|----------|
| 数据库 | 1 条 DDL + 数据迁移 | 10 分钟 |
| 后端 | ~6 个文件，~20 处 SQL | 1-2 天 |
| 前端 | ~2 个文件 | 1 天 |
| 测试回归 | — | 0.5 天 |
| **合计** | — | **2.5-3.5 天**（方案 B 的 50-60%） |

---

## 十、总结

**核心思想**：不改表结构的"关系模型"，只改一个字段的"值类型"——从 `INT`（一个值）变成 `JSON`（一组值）。

- `account_mappings` 仍然一行 = 一个账户 ✅
- UNIQUE 约束不动 ✅
- 数据同步/调度/结构同步完全不受影响 ✅
- 只需改鉴权层 + admin CRUD，~20 处 SQL ✅
- 前端改动量少（一行一账户的展示逻辑不变）✅
- MySQL 8.0.45 原生 JSON + 多值索引支持 ✅
