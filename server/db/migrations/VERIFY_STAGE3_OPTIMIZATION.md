# 阶段三验证指南（AdsPolar "Insights First" 优化 + 重试机制）

## 验证目标

验证以下优化是否生效：
1. ✅ **"Insights First" 策略**：只拉取 spend>0 的广告，不再先调用 `/ads` 接口
2. ✅ **时区优化**：优先使用数据库中的时区，不再每次查询 API
3. ✅ **并发控制**：有效控制并发度（8个账户），避免限流
4. ✅ **重试机制**：在限流时正确重试（指数退避 + 账户冷却期）

---

## 验证步骤

### 1. 验证时区优化（不再每次查询 API）

**目标**：确认同步任务优先使用数据库中的时区，不再频繁调用 API

**验证方法**：
1. 查看后端日志，搜索 `获取账户.*时区` 或 `使用数据库中的时区`
2. 应该看到：`✅ 使用数据库中的时区: Asia/Shanghai`（而不是 `📡 获取账户...的时区...`）

**SQL 验证**：
```sql
-- 检查所有账户的时区是否已同步
SELECT 
  fb_account_id,
  timezone_name,
  is_active,
  updated_at
FROM account_mappings
WHERE is_active = 1
  AND (timezone_name IS NULL OR timezone_name = 'UTC')
ORDER BY fb_account_id;
-- 预期：应该没有或很少账户时区为 NULL 或 UTC
```

---

### 2. 验证 "Insights First" 策略（不再先调用 /ads 接口）

**目标**：确认同步任务直接从数据库查询活跃广告，不再先调用 `/ads` 接口

**验证方法**：
1. 查看后端日志，搜索 `📋 从数据库查询活跃广告ID` 或 `📤 发送HTTP请求: GET.*ads`
2. **应该看到**：
   - `📋 从数据库查询活跃广告ID（近 3 天内有 spend>0）...`
   - `📊 筛选活跃广告: (数据库查询) → X (近 3 天内有 spend>0)`
3. **不应该看到**：
   - `📤 发送HTTP请求: GET /v24.0/act_xxx/ads?fields=id%2Cname...`（这是拉取所有广告的请求）

**SQL 验证**：
```sql
-- 检查最近同步的广告是否都是 spend>0 的
SELECT 
  account_id,
  COUNT(*) as total_ads,
  COUNT(CASE WHEN spend > 0 THEN 1 END) as spend_gt_zero_ads,
  ROUND(COUNT(CASE WHEN spend > 0 THEN 1 END) * 100.0 / COUNT(*), 2) as spend_gt_zero_percentage
FROM ad_snapshots
WHERE synced_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
GROUP BY account_id
ORDER BY account_id;
-- 预期：spend_gt_zero_percentage 应该接近 100%（或至少 > 90%）
```

---

### 3. 验证并发控制（8个账户并发）

**目标**：确认并发度控制在 8 个账户，避免限流

**验证方法**：
1. 查看后端日志，搜索 `🚀 使用受控并发模式（并发度 = 8）`
2. 观察日志中的账户同步任务，应该看到最多 8 个账户同时执行
3. 不应该出现大量 `429` 或 `There have been too many calls` 错误

**日志特征**：
- 应该看到：`[1/37] 同步账户...`、`[2/37] 同步账户...` 等，最多同时 8 个
- 不应该看到：所有账户同时开始（完全并发）

---

### 4. 验证重试机制（指数退避 + 账户冷却期）

**目标**：确认在限流时正确重试，且不会立即重试同一账户

**验证方法**：
1. 查看后端日志，搜索 `🔄 重试账户` 或 `⏸️  账户冷却中`
2. **应该看到**：
   - `🔄 重试账户 act_xxx (第 1/2 次重试，延迟 60 秒)...`
   - `🔄 重试账户 act_xxx (第 2/2 次重试，延迟 120 秒)...`
   - `⏸️  账户 act_xxx 冷却中（剩余 120 秒），跳过本次同步`
3. **不应该看到**：
   - 同一账户在短时间内多次重试（没有冷却期）
   - 重试延迟过短（< 60 秒）

**SQL 验证**：
```sql
-- 检查重试账户的同步会话ID
SELECT 
  account_id,
  sync_session_id,
  COUNT(*) as snapshot_count,
  MAX(synced_at) as last_synced_at
FROM ad_snapshots
WHERE sync_session_id LIKE 'retry_%'
  AND synced_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
GROUP BY account_id, sync_session_id
ORDER BY last_synced_at DESC
LIMIT 20;
-- 预期：如果有重试，sync_session_id 应该包含 'retry_1' 或 'retry_2'
```

---

### 5. 验证数据同步完整性（Today 热同步）

**目标**：确认 Today 热同步正常工作，数据正确写入 `ad_snapshots`

**验证方法**：
1. 手动触发 Today 同步：`import('./server/services/cronService.js').then(m => m.manualSyncToday())`
2. 查看后端日志，确认同步任务正常执行
3. 检查 `ad_snapshots` 表是否有新数据

**SQL 验证**：
```sql
-- 检查最近同步的数据
SELECT 
  account_id,
  COUNT(DISTINCT ad_id) as ad_count,
  SUM(spend) as total_spend,
  MAX(synced_at) as last_synced_at,
  MAX(data_date) as latest_data_date
FROM ad_snapshots
WHERE synced_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
GROUP BY account_id
ORDER BY last_synced_at DESC
LIMIT 20;

-- 检查 data_date 是否正确（应该与账户时区一致）
SELECT 
  account_id,
  data_date,
  DATE(synced_at) as synced_date_utc,
  timezone_name,
  COUNT(*) as count
FROM ad_snapshots
WHERE synced_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
GROUP BY account_id, data_date, DATE(synced_at), timezone_name
ORDER BY account_id, data_date DESC
LIMIT 20;
```

---

### 6. 验证 API 调用量减少

**目标**：确认优化后 API 调用量显著减少

**验证方法**：
1. 查看后端日志，统计 `📤 发送HTTP请求` 的数量
2. 对比优化前后：
   - **优化前**：每个账户需要调用 `/ads`（拉取所有广告）+ `/insights`（拉取所有广告的成效）
   - **优化后**：每个账户只需要调用 `/insights`（只拉取 spend>0 的广告）+ `/resolveObjectsByIds`（批量查询活跃广告状态）

**预期结果**：
- API 调用量应该减少 50-80%（取决于账户中活跃广告占比）
- 不应该出现大量 `429` 限流错误

---

## 预期结果总结

| 验证项 | 预期结果 |
|--------|---------|
| 时区优化 | ✅ 日志显示"使用数据库中的时区"，不再频繁查询 API |
| "Insights First" | ✅ 日志显示"从数据库查询活跃广告ID"，不再调用 `/ads` 接口 |
| 并发控制 | ✅ 最多 8 个账户同时执行，日志显示"并发度 = 8" |
| 重试机制 | ✅ 限流时正确重试（延迟 60s、120s），账户有冷却期 |
| 数据同步 | ✅ `ad_snapshots` 表有新数据，`data_date` 正确 |
| API 调用量 | ✅ 调用量减少 50-80%，限流错误显著减少 |

---

## 常见问题排查

### 问题1：仍然看到 `/ads` 接口调用

**检查**：
- 确认 `syncAccountTodayStats` 和 `syncAccountSlidingWindow` 函数中不再调用 `facebookApi.getAds()`
- 确认 `filterActiveAds` 函数直接从数据库查询活跃广告

### 问题2：时区仍然每次查询 API

**检查**：
- 确认 `syncAccountTodayStats` 函数中优先使用数据库中的时区
- 确认时区同步脚本已执行完成

### 问题3：仍然出现大量 429 限流错误

**检查**：
- 确认并发度设置为 8（不是更高）
- 确认 `sleepBasedOnUsage` 函数正常工作
- 检查是否有其他任务同时运行（导致总并发度超过限制）

### 问题4：重试机制不工作

**检查**：
- 确认 `isRetryableError` 函数正确识别限流错误
- 确认重试延迟时间正确（60s、120s）
- 确认账户冷却期正常工作（120s）

---

## 下一步

如果所有验证都通过，可以：
1. ✅ 继续验证统一心跳同步（`unifiedHeartbeatSync`）
2. ✅ 验证双窗口归档逻辑
3. ✅ 验证滑动窗口回补（last_3d / last_7d / last_14d）

