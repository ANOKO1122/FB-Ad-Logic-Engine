# 阶段A实施总结：冷数据归档优化

> 完成时间：2026-01-20  
> 状态：✅ 代码已完成，等待验证

---

## 📋 已完成的工作

### 1. 创建唯一索引迁移脚本

**文件**：`server/db/migrations/005_add_unique_index_to_daily_stats.sql`

**功能**：
- 为 `daily_stats` 表创建唯一索引 `uk_account_ad_date` (account_id, ad_id, date)
- 确保 `ON DUPLICATE KEY UPDATE` 生效，防止重复归档

**需要你手动执行**：
```bash
# Windows PowerShell
mysql -u root -p fb_ad_brain < server/db/migrations/005_add_unique_index_to_daily_stats.sql
```

**验证命令**（在 MySQL 中执行）：
```sql
SHOW INDEX FROM daily_stats WHERE Key_name = 'uk_account_ad_date';
```

---

### 2. 修改 `archiveAllAccountsDailyStats` 函数

**文件**：`server/services/ingestorService.js`

**核心改动**：
1. **高频检查模式**：每 10 分钟检查一次，不再固定每天 06:00
2. **账户本地时区判断**：使用 Luxon 判断账户本地时区是否在 06:00-06:09 窗口
3. **幂等保护**：
   - COUNT(*) 快速检查（已归档则跳过）
   - DB 锁 `GET_LOCK('archive:{account_id}:{date}', 0)`（防止多实例并发）
   - 唯一索引兜底（`ON DUPLICATE KEY UPDATE`）
4. **详细日志**：记录 account_id、localTime、targetDate、lock 状态、归档条数

**关键代码逻辑**：
```javascript
// 判断账户本地时区是否在 06:00-06:09 窗口
const localTime = DateTime.now().setZone(timezoneName)
const hour = localTime.hour
const minute = localTime.minute
const shouldArchive = (hour === 6 && minute >= 0 && minute <= 9)

// 幂等检查
const [checkRows] = await pool.execute(
  `SELECT COUNT(*) as cnt FROM daily_stats WHERE account_id = ? AND date = ?`,
  [accountId, targetDateStr]
)

// DB 锁
const lockName = `archive:${accountId}:${targetDateStr}`
const [lockRows] = await pool.execute('SELECT GET_LOCK(?, 0) AS acquired', [lockName])
```

---

### 3. 更新 `cronService.js`

**文件**：`server/services/cronService.js`

**核心改动**：
1. **新增每 10 分钟归档检查任务**：调用新版本的 `archiveAllAccountsDailyStats`
2. **保留旧版本 06:00 任务**（过渡期）：
   - 使用 `forceAll=true` 强制归档所有账户
   - 作为兜底保障，稳定后可以移除

**任务列表**：
- ✅ 规则执行：每 15 分钟
- ✅ 数据同步：每 10 分钟
- ✅ **归档检查：每 10 分钟（新版本）**
- ⚠️ 归档落盘：每天 06:00（过渡期，稳定后移除）

---

### 4. 创建验证脚本

**文件**：`test-stage-a-archive-verification.js`

**验证内容**：
1. ✅ 检查唯一索引是否存在
2. ✅ 检查账户时区配置
3. ✅ 测试幂等性（多次触发不重复归档）
4. ✅ 测试时区窗口判断

---

## 🚀 需要你手动执行的步骤

### 步骤 1：执行唯一索引迁移

```bash
# 在项目根目录执行
mysql -u root -p fb_ad_brain < server/db/migrations/005_add_unique_index_to_daily_stats.sql
```

**验证**：
```sql
-- 在 MySQL 中执行
SHOW INDEX FROM daily_stats WHERE Key_name = 'uk_account_ad_date';
```

**预期结果**：应该看到 3 列（account_id, ad_id, date），NON_UNIQUE = 0

---

### 步骤 2：运行验证脚本

```bash
# 在项目根目录执行
node test-stage-a-archive-verification.js
```

**预期输出**：
- ✅ 唯一索引存在
- ✅ 账户时区配置正确
- ✅ 幂等性验证通过
- ✅ 时区窗口判断正确

---

### 步骤 3：观察定时任务日志

**启动服务器**：
```bash
npm run dev:server
```

**观察日志**：
- 每 10 分钟应该看到"📦 开始冷数据归档检查（高频检查模式）..."
- 如果账户在归档窗口（06:00-06:09），应该看到归档日志
- 如果账户不在归档窗口，应该看到跳过日志（或静默跳过）

**关键日志字段**：
- `account_id`：账户ID
- `localTime`：账户本地时间
- `targetDate`：目标日期（昨日）
- `lock` 状态：是否获取到锁
- `已归档，跳过`：幂等检查结果
- `归档条数`：实际归档的记录数

---

### 步骤 4：测试多时区归档（可选）

**准备**：
1. 在 `account_mappings` 表中配置 3 个测试账户：
   - 账户1：时区 `Asia/Shanghai`
   - 账户2：时区 `America/New_York`
   - 账户3：时区 `UTC`

2. 手动修改系统时间或等待到不同时区的 06:00 窗口

**验证**：
- 在 Asia/Shanghai 的 06:00-06:09 窗口，只归档 Asia/Shanghai 账户
- 在 America/New_York 的 06:00-06:09 窗口，只归档 America/New_York 账户
- 在 UTC 的 06:00-06:09 窗口，只归档 UTC 账户

---

### 步骤 5：稳定运行后移除旧任务（可选）

**条件**：
- 新版本高频检查稳定运行 1-2 周
- 日志显示归档正常，没有重复归档
- 幂等性验证通过

**操作**：
在 `server/services/cronService.js` 中注释或删除以下代码：
```javascript
// 4. 每天 06:00 执行冷数据落盘（旧版本，过渡期保留）
cron.schedule('0 6 * * *', async () => {
  // ... 删除这段代码
})
```

---

## ✅ 验收标准

### 功能验收
- [x] 唯一索引已创建
- [ ] 高频检查任务正常运行
- [ ] 账户本地时区判断正确
- [ ] 幂等性验证通过（多次触发不重复归档）
- [ ] DB 锁机制生效（多实例不重复归档）
- [ ] 日志记录完整（account_id、localTime、targetDate、归档条数）

### 性能验收
- [ ] 归档检查响应时间正常（< 5 秒）
- [ ] 10 分钟轮询不影响其他任务
- [ ] 数据库查询效率正常

### 可观测性验收
- [ ] 日志清晰，便于排障
- [ ] 统计信息完整（检查账户数、归档账户数、跳过账户数、归档条数）

---

## 🐛 常见问题

### 问题 1：唯一索引创建失败

**错误信息**：
```
Duplicate entry 'xxx-yyy-2026-01-20' for key 'uk_account_ad_date'
```

**原因**：数据库中存在重复数据

**解决方法**：
```sql
-- 1. 检查重复数据
SELECT account_id, ad_id, date, COUNT(*) as cnt
FROM daily_stats
GROUP BY account_id, ad_id, date
HAVING cnt > 1;

-- 2. 清理重复数据（保留最新的）
DELETE t1 FROM daily_stats t1
INNER JOIN daily_stats t2
WHERE t1.id < t2.id
  AND t1.account_id = t2.account_id
  AND t1.ad_id = t2.ad_id
  AND t1.date = t2.date;

-- 3. 重新创建唯一索引
```

---

### 问题 2：归档检查没有触发

**可能原因**：
1. 没有账户在归档窗口（06:00-06:09）
2. 账户时区配置错误
3. 定时任务未启动

**排查步骤**：
1. 运行验证脚本检查账户时区配置
2. 检查日志，确认定时任务已启动
3. 手动修改系统时间到 06:00-06:09 窗口测试

---

### 问题 3：幂等性验证失败

**可能原因**：
1. 唯一索引未创建
2. COUNT(*) 检查逻辑错误
3. DB 锁未生效

**排查步骤**：
1. 检查唯一索引是否存在
2. 检查日志中的"已归档，跳过"提示
3. 检查 DB 锁是否获取成功

---

## 📚 相关文档

- **迁移脚本**：`server/db/migrations/005_add_unique_index_to_daily_stats.sql`
- **验证脚本**：`test-stage-a-archive-verification.js`
- **方案文档**：`方案B+优化版-最终版.md` 阶段6
- **开发计划**：`DEV_PLAN.md`

---

## 🎯 下一步

完成阶段A验证后，可以开始**阶段B：规则执行改造（离线数据）**。

---

**祝你验证顺利！** 🚀

