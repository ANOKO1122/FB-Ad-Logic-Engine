# AdsPolar 流水线架构验证清单

## 📋 验证概述

系统已成功启动 AdsPolar 流水线架构，需要验证以下核心功能：

---

## ✅ 验证项目清单

### 1. 流水线触发机制（链式反应）

**验证目标**：数据同步完成后，自动触发规则执行

**验证方法**：
1. 等待下一次统一心跳执行（每 15 分钟）或手动触发：
   ```javascript
   // 在 Node.js REPL 或后端控制台执行
   import('./server/services/cronService.js').then(m => m.manualUnifiedHeartbeat())
   ```

2. 观察日志输出，应该看到：
   ```
   💓 统一心跳同步任务（每 15 分钟）
   ...
   ✅ 统一心跳同步完成
   🔄 数据同步完成，触发规则执行（AdsPolar 链式反应）
   📋 有数据更新的账户: X 个
   ```

**预期结果**：
- ✅ 数据同步完成后，立即看到规则执行日志
- ✅ 没有独立的每分钟规则执行 cron（已移除）

---

### 2. 真正的"零空转"（数据变化检测）

**验证目标**：只有真正有数据更新的账户才触发规则执行

**验证方法**：
1. 观察统一心跳执行后的日志输出

2. **场景 A：有数据更新**
   - 应该看到：
     ```
     📋 有数据更新的账户: X 个
     🔄 数据同步完成，触发规则执行（AdsPolar 链式反应）
     ```

3. **场景 B：无数据更新**
   - 应该看到：
     ```
     ⚠️  没有账户有数据更新，跳过规则执行（零空转）
     ```

**预期结果**：
- ✅ 如果所有账户都没有新数据（`syncedCount = 0`），不会触发规则执行
- ✅ 只有 `syncedCount > 0` 或 `todayCount > 0 || dailyStatsCount > 0` 的账户才会触发规则

---

### 3. 统一心跳防重入机制

**验证目标**：防止多实例或长时间执行导致心跳任务重叠

**验证方法**：
1. **方法 A：快速连续触发两次心跳**
   ```javascript
   // 在 Node.js REPL 中快速执行两次
   import('./server/services/ingestorService.js').then(m => {
     m.unifiedHeartbeatSync().then(() => {
       console.log('第一次心跳完成')
       // 立即触发第二次
       m.unifiedHeartbeatSync().then(() => console.log('第二次心跳完成'))
     })
   })
   ```

2. **方法 B：等待心跳执行中，再次触发**
   - 如果心跳正在执行（>15分钟），应该看到：
     ```
     ⏸️  统一心跳正在执行中，跳过本次任务（防重入）
     ```
     或
     ```
     ⏸️  统一心跳锁已被占用（可能其他实例正在执行），跳过本次任务
     ```

**预期结果**：
- ✅ 如果心跳正在执行，第二次触发会被跳过
- ✅ 返回 `skipped: true` 和 `skipReason`

---

### 4. 账户级锁机制

**验证目标**：不同账户可以并发执行规则，同一账户不会并发执行

**验证方法**：
1. 手动触发规则执行（指定多个账户）：
   ```javascript
   import('./server/services/cronService.js').then(m => 
     m.executeAllRules({ 
       force: true,  // 强制模式，忽略冷却期
       accountIds: ['act_123', 'act_456', 'act_789']  // 替换为实际账户ID
     })
   )
   ```

2. 观察日志输出，应该看到：
   ```
   ✅ [act_123] 获取锁成功，开始执行规则...
   ✅ [act_456] 获取锁成功，开始执行规则...
   ✅ [act_789] 获取锁成功，开始执行规则...
   ```

3. **验证同一账户不会并发**：
   - 快速连续触发同一账户的规则执行
   - 应该看到：
     ```
     ✅ [act_123] 获取锁成功，开始执行规则...
     🔒 [act_123] 正在执行中，跳过本次任务
     ```

**预期结果**：
- ✅ 不同账户可以并发执行（高并发）
- ✅ 同一账户不会并发执行（锁保护）

---

### 5. 超时保险丝机制

**验证目标**：如果规则执行超过 5 分钟，自动断开连接释放锁

**验证方法**：
1. **模拟长时间执行**（需要修改代码添加延迟）：
   ```javascript
   // 在 executeRulesForAccount 中添加测试延迟
   // await new Promise(resolve => setTimeout(resolve, 6 * 60 * 1000)) // 6分钟
   ```

2. 观察日志输出，应该看到：
   ```
   🚨 [act_123] 规则执行超时 (5m)，强制断开连接以释放锁！
   ```

**预期结果**：
- ✅ 如果规则执行超过 5 分钟，自动断开连接
- ✅ MySQL 自动释放锁（连接断开时）

**注意**：此测试需要修改代码，建议在生产环境观察真实场景。

---

### 6. 冷却期机制

**验证目标**：规则执行有 15 分钟冷却期，避免频繁执行

**验证方法**：
1. 第一次执行规则：
   ```javascript
   import('./server/services/cronService.js').then(m => m.manualExecute())
   ```

2. 立即再次执行（应该被冷却期过滤）：
   ```javascript
   import('./server/services/cronService.js').then(m => m.manualExecute())
   ```

3. 观察日志输出：
   - 第一次执行：应该看到规则执行日志
   - 第二次执行：应该看到规则被跳过（冷却期内）

**预期结果**：
- ✅ 15 分钟内不会重复执行同一规则
- ✅ 强制模式（`force: true`）可以忽略冷却期

---

## 🧪 快速验证脚本

### 脚本 1：验证流水线触发

```javascript
// 在 Node.js REPL 中执行
import('./server/services/cronService.js').then(async (m) => {
  console.log('开始验证流水线触发...')
  const result = await m.manualUnifiedHeartbeat()
  console.log('统一心跳结果:', result)
  
  if (result.syncedAccountIds && result.syncedAccountIds.length > 0) {
    console.log(`✅ 有 ${result.syncedAccountIds.length} 个账户有数据更新`)
    console.log('账户列表:', result.syncedAccountIds)
  } else {
    console.log('⚠️  没有账户有数据更新（零空转）')
  }
})
```

### 脚本 2：验证账户级锁

```javascript
// 在 Node.js REPL 中执行
import('./server/services/cronService.js').then(async (m) => {
  console.log('开始验证账户级锁...')
  
  // 获取所有活跃账户
  const { default: pool } = await import('./server/db/connection.js')
  const [accounts] = await pool.query(
    `SELECT DISTINCT fb_account_id FROM account_mappings WHERE is_active = 1 LIMIT 3`
  )
  
  const accountIds = accounts.map(a => a.fb_account_id)
  console.log('测试账户:', accountIds)
  
  // 并发执行规则
  await m.executeAllRules({ 
    force: true, 
    accountIds 
  })
  
  console.log('✅ 账户级锁验证完成')
})
```

### 脚本 3：验证防重入机制

```javascript
// 在 Node.js REPL 中执行
import('./server/services/ingestorService.js').then(async (m) => {
  console.log('开始验证防重入机制...')
  
  // 快速连续触发两次
  const promise1 = m.unifiedHeartbeatSync()
  const promise2 = m.unifiedHeartbeatSync()  // 应该被跳过
  
  const [result1, result2] = await Promise.all([promise1, promise2])
  
  console.log('第一次心跳:', result1.skipped ? '被跳过' : '执行成功')
  console.log('第二次心跳:', result2.skipped ? '被跳过' : '执行成功')
  
  if (result2.skipped) {
    console.log('✅ 防重入机制正常工作')
  } else {
    console.log('⚠️  防重入机制可能未生效')
  }
})
```

---

## 📊 验证结果记录表

| 验证项目 | 状态 | 验证时间 | 备注 |
|---------|------|---------|------|
| 1. 流水线触发机制 | ⬜ 待验证 | - | - |
| 2. 真正的"零空转" | ⬜ 待验证 | - | - |
| 3. 统一心跳防重入 | ⬜ 待验证 | - | - |
| 4. 账户级锁机制 | ⬜ 待验证 | - | - |
| 5. 超时保险丝机制 | ⬜ 待验证 | - | 需要长时间执行场景 |
| 6. 冷却期机制 | ⬜ 待验证 | - | - |

---

## 🚀 推荐验证顺序

1. **第一步**：验证流水线触发机制（脚本 1）
   - 确认数据同步完成后自动触发规则执行

2. **第二步**：验证真正的"零空转"（观察日志）
   - 确认只有数据更新才触发规则

3. **第三步**：验证账户级锁机制（脚本 2）
   - 确认不同账户可以并发执行

4. **第四步**：验证防重入机制（脚本 3）
   - 确认心跳任务不会重叠

5. **第五步**：验证冷却期机制
   - 确认规则不会频繁执行

6. **第六步**：长期观察超时保险丝
   - 在生产环境中观察真实场景

---

## ⚠️ 注意事项

1. **验证环境**：建议在测试环境或非生产时间验证
2. **账户ID**：验证时请使用实际的账户ID替换示例中的占位符
3. **日志观察**：所有验证都需要观察后端控制台日志输出
4. **时间等待**：某些验证需要等待 15 分钟（统一心跳周期）
5. **数据库锁**：验证账户级锁时，可以查询 MySQL 锁状态：
   ```sql
   SELECT * FROM performance_schema.metadata_locks 
   WHERE OBJECT_NAME LIKE 'rule:account:%';
   ```

---

**创建时间**：2026-01-27  
**验证版本**：AdsPolar Pipeline Architecture v1.0
