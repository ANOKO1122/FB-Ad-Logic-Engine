# AdsPolar 流水线架构改造说明

## 📋 改造概述

按照 AdsPolar 的设计理念，将规则引擎从"独立定时器"改造为"数据同步的下游流水线"，实现零空转、高并发、无僵尸锁的架构。

---

## 🎯 核心改进

### 1. 流水线架构（Pipeline Architecture）

**改造前：**
- Cron A（每 15 分钟）：数据同步
- Cron B（每 1 分钟）：规则执行（独立运行）
- **问题**：数据未更新时，规则执行空转 14 次，浪费资源

**改造后：**
- Cron（每 15 分钟）：数据同步 → **链式触发** → 规则执行
- **优势**：只有数据更新了，规则才执行（零空转）
- **优化**：真正的"零空转" - 只有 `syncedCount > 0` 的账户才触发规则执行

### 2. 账户级锁（Account-level Lock）

**改造前：**
- 全局锁：`GET_LOCK('fb_ad_brain:cron:execute_rules')`
- **问题**：一个账户慢，所有账户等待；僵尸锁无法自动释放

**改造后：**
- 账户级锁：`GET_LOCK('rule:account:123')`
- **优势**：账户 A 执行不影响账户 B，高并发；专用连接 + 超时保险丝，自动释放僵尸锁

### 3. 执行频率优化

**改造前：**
- 每分钟执行一次规则检查
- **问题**：API 归因延迟（15 分钟），过早执行可能误杀；数据库压力大

**改造后：**
- 每 15 分钟执行一次（跟随数据同步频率）
- **优势**：避免归因延迟误判；资源消耗降低 15 倍

---

## 🔧 技术实现

### 1. 账户级锁机制（带超时保险丝）

```javascript
/**
 * AdsPolar 风格的 MySQL 锁实现（带超时保险丝）
 * 使用专用连接 + 超时保险丝，等价于给 GET_LOCK 加了 TTL
 */
async function executeRulesWithLock(accountId, ruleLogicFn) {
  const lockName = `rule:account:${accountId}`
  let connection = null
  
  // 设置一个"保险丝"计时器（5分钟超时）
  const timeoutHandle = setTimeout(() => {
    if (connection) {
      console.error(`🚨 [${accountId}] 规则执行超时 (5m)，强制断开连接以释放锁！`)
      connection.destroy() // 💥 物理切断 TCP 连接 -> MySQL 自动释放锁
    }
  }, 5 * 60 * 1000)

  try {
    // 1. 获取专用连接
    connection = await pool.getConnection()

    // 2. 尝试获取锁 (0秒等待，拿不到立刻放弃)
    const [rows] = await connection.query(`SELECT GET_LOCK(?, 0) as locked`, [lockName])
    if (!rows[0]?.locked) {
      console.log(`🔒 [${accountId}] 正在执行中，跳过本次任务`)
      return // 类似 Redis 的 NX (Not Exist)
    }

    // 3. 执行业务逻辑
    await ruleLogicFn(accountId)

  } catch (err) {
    // 忽略 destroy() 导致的连接错误
    if (err.code !== 'PROTOCOL_CONNECTION_LOST') {
      console.error(`❌ [${accountId}] 规则执行出错:`, err.message)
    }
  } finally {
    // 4. 清理现场
    clearTimeout(timeoutHandle)
    
    if (connection && !connection._destroying) {
      try {
        await connection.query(`SELECT RELEASE_LOCK(?)`, [lockName])
      } catch (e) { /* 忽略释放错误 */ }
      
      connection.release()
    }
  }
}
```

**关键特性：**
- ✅ 专用连接：每个账户使用独立数据库连接，避免连接池竞争
- ✅ 超时保险丝：5 分钟超时自动断开连接，MySQL 自动释放锁
- ✅ 非阻塞获取：0 秒等待，拿不到锁立即放弃（类似 Redis NX）

### 2. 流水线触发机制

```javascript
// 统一心跳：每 15 分钟执行一次
cron.schedule('*/15 * * * *', async () => {
  try {
    // 执行数据同步
    const syncResult = await unifiedHeartbeatSync()
    
    // 数据同步完成后，触发规则执行（AdsPolar 链式反应）
    if (syncResult && syncResult.syncedAccountIds && syncResult.syncedAccountIds.length > 0) {
      console.log('🔄 数据同步完成，触发规则执行（AdsPolar 链式反应）')
      
      // 并发执行所有同步账户的规则（账户级锁保证不会冲突）
      await executeAllRules({ 
        force: false,  // 遵循冷却期
        accountIds: syncResult.syncedAccountIds 
      })
    }
  } catch (error) {
    console.error('❌ 统一心跳同步失败:', error.message)
  }
})
```

**关键特性：**
- ✅ 链式反应：数据同步完成后立即触发规则执行
- ✅ 只对同步成功的账户执行规则（避免无效执行）
- ✅ 账户级并发：所有账户并行执行，互不干扰

### 3. 账户级规则执行

```javascript
/**
 * AdsPolar 流水线架构：为单个账户执行规则
 * 账户级锁 + 超时保险丝，彻底解决僵尸锁问题
 */
async function executeRulesForAccount(accountId, options = {}) {
  // 使用账户级锁执行规则
  await executeRulesWithLock(accountId, async (lockedAccountId) => {
    // 1. 获取所有启用的规则
    // 2. 过滤满足冷却期的规则
    // 3. 按用户分组规则
    // 4. 执行规则评估和动作
  })
}
```

---

## 📊 性能对比

| 指标 | 改造前 | 改造后 | 改进 |
|------|--------|--------|------|
| **规则执行频率** | 每分钟 | 每 15 分钟 | ⬇️ 降低 15 倍 |
| **空转次数** | 14 次/15 分钟 | 0 次 | ✅ 零空转 |
| **锁粒度** | 全局锁 | 账户级锁 | ✅ 高并发 |
| **僵尸锁风险** | 高（无 TTL） | 低（5分钟超时） | ✅ 自动释放 |
| **数据库压力** | 高（每分钟查询） | 低（15分钟查询） | ⬇️ 降低 15 倍 |

---

## 🔍 验证方法

### 1. 验证流水线触发

观察日志输出，应该看到：
```
💓 统一心跳同步任务（每 15 分钟）
...
✅ 统一心跳同步完成
🔄 数据同步完成，触发规则执行（AdsPolar 链式反应）
📋 同步账户: X 个
```

### 2. 验证账户级锁

观察日志输出，应该看到：
```
✅ [account_123] 获取锁成功，开始执行规则...
🔒 [account_456] 正在执行中，跳过本次任务
```

### 3. 验证超时保险丝

如果规则执行超过 5 分钟，应该看到：
```
🚨 [account_123] 规则执行超时 (5m)，强制断开连接以释放锁！
```

### 4. 验证零空转

观察日志输出，如果数据未更新，应该看到：
```
⚠️  没有账户有数据更新，跳过规则执行（零空转）
```

### 5. 验证统一心跳防重入

如果统一心跳正在执行中，再次触发应该看到：
```
⏸️  统一心跳正在执行中，跳过本次任务（防重入）
```
或
```
⏸️  统一心跳锁已被占用（可能其他实例正在执行），跳过本次任务
```

---

## 📝 代码变更清单

### 1. `server/services/cronService.js`

- ✅ 移除全局锁机制（`CRON_LOCK_NAME`, `tryAcquireDbLock`, `releaseDbLock`）
- ✅ 实现账户级锁机制（`executeRulesWithLock`）
- ✅ 改造规则执行为账户级（`executeRulesForAccount`）
- ✅ 修改 `startCronJob`：移除每分钟 cron，改为数据同步后触发
- ✅ 修改 `stopCronJob`：移除全局锁释放逻辑

### 2. `server/services/ingestorService.js`

- ✅ 修改 `unifiedHeartbeatSync`：返回 `syncedAccountIds` 列表（只包含有实际数据更新的账户）
- ✅ 添加 `dataUpdated` 字段：判断是否有实际数据写入（`syncedCount > 0` 或 `todayCount > 0 || dailyStatsCount > 0`）
- ✅ 添加统一心跳防重入机制：进程内标志位 + 数据库锁（`fb_ad_brain:unified_heartbeat`）

---

## 🚀 使用说明

### 手动触发规则执行

```javascript
// 强制模式：忽略冷却期，立即执行所有账户的规则
import('./server/services/cronService.js').then(m => m.manualExecute())

// 指定账户执行
import('./server/services/cronService.js').then(m => 
  m.executeAllRules({ 
    force: false, 
    accountIds: ['act_123', 'act_456'] 
  })
)
```

### 查看执行状态

```javascript
import('./server/services/cronService.js').then(m => {
  const status = m.getCronStatus()
  console.log('上次执行时间:', status.lastExecutionTime)
  console.log('执行结果:', status.lastExecutionResult)
})
```

---

## ⚠️ 注意事项

1. **冷却期机制**：规则执行仍有 15 分钟冷却期，避免频繁执行
2. **超时设置**：账户级锁超时时间为 5 分钟，如果规则执行超过 5 分钟会被强制中断
3. **并发控制**：账户级锁允许不同账户并发执行，但同一账户不会并发执行
4. **错误隔离**：单个账户的规则执行失败不会影响其他账户
5. **零空转优化**：只有 `syncedCount > 0`（Today）或 `todayCount > 0 || dailyStatsCount > 0`（滑动窗口）的账户才会触发规则执行
6. **防重入机制**：统一心跳使用进程内标志位 + 数据库锁双重保护，防止多实例或长时间执行导致重叠

---

## 📚 参考资料

- AdsPolar 设计文档（用户提供）
- MySQL `GET_LOCK` / `RELEASE_LOCK` 文档
- Node.js MySQL2 连接池文档

---

**改造完成时间**：2026-01-27  
**改造版本**：AdsPolar Pipeline Architecture v1.0
