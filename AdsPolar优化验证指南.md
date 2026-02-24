# AdsPolar 优化验证指南

## 🎯 需要验证的优化

### 1. 反向索引优化（Rule-Centric）
- **目标**：规则指定了 `accountId` 时，只在该账户上执行
- **验证**：手动触发规则执行，观察是否只执行1个账户

### 2. 事件驱动优化（Event-Driven）
- **目标**：数据同步完成后立即触发规则执行
- **验证**：执行数据同步，观察是否在同步时立即触发规则

---

## ✅ 验证步骤

### 验证 1：反向索引优化

#### 步骤 1：检查规则配置

```sql
-- 查看规则是否指定了 accountId
SELECT id, rule_name, account_id, enabled, is_simulation 
FROM rules 
WHERE enabled = 1;
```

**预期结果**：
- 应该能看到规则指定了 `account_id`（例如：`act_4252903478277839`）

---

#### 步骤 2：手动触发规则执行（强制模式）

```javascript
// 在 Node.js REPL 中执行
import('./server/services/cronService.js').then(async (m) => {
  console.log('=== 验证反向索引优化（强制模式）===')
  await m.manualExecute(true)  // force = true
})
```

**预期日志**：
```
📊 规则分析: 1 条规则，1 个指定账户，1 个活跃账户需要执行
📋 目标账户: 1 个  ✅（应该是1个，而不是36个）

✅ [act_xxx] 获取锁成功，开始执行规则...
   📋 [act_xxx] 找到 1 条可执行规则
   👥 [act_xxx] 规则按用户分组: 1 个用户
   🔄 [act_xxx] 开始执行用户 1 的 1 条规则
```

**验证要点**：
- ✅ `📋 目标账户: 1 个`（而不是36个）
- ✅ 只有1个账户获取锁并执行规则
- ✅ 其他35个账户不会被触碰

---

### 验证 2：事件驱动优化

#### 步骤 1：手动触发数据同步

```javascript
// 在 Node.js REPL 中执行
import('./server/services/ingestorService.js').then(async (m) => {
  console.log('=== 验证事件驱动优化 ===')
  await m.unifiedHeartbeatSync()
})
```

**预期日志**：
```
[账户 A] 时区: Asia/Shanghai, 本地时间: 2026-01-27 16:00:00
  同步范围: today (daysBack=0)
  ✅ [账户 A] 有数据更新: 100 条
  🔄 [账户 A] 数据同步完成，立即触发规则执行（AdsPolar 事件驱动）✅
  
✅ [账户 A] 获取锁成功，开始执行规则...
   📋 [账户 A] 找到 1 条可执行规则
   👥 [账户 A] 规则按用户分组: 1 个用户
   🔄 [账户 A] 开始执行用户 1 的 1 条规则
```

**验证要点**：
- ✅ 数据同步完成后，立即看到 `🔄 [账户 A] 数据同步完成，立即触发规则执行（AdsPolar 事件驱动）`
- ✅ 规则执行在数据同步后立即开始（不需要等待所有账户同步完成）
- ✅ 规则执行不阻塞数据同步流程

---

### 验证 3：定时任务（自动触发）

#### 步骤 1：等待定时任务执行（15分钟）

或者手动触发统一心跳：

```javascript
// 在 Node.js REPL 中执行
import('./server/services/cronService.js').then(async (m) => {
  console.log('=== 验证定时任务（自动触发）===')
  await m.manualUnifiedHeartbeat()
})
```

**预期日志**：
```
==================================================
✅ 数据同步完成（规则执行已在同步时触发，AdsPolar 事件驱动模式）
📋 有数据更新的账户: X 个
==================================================
```

**验证要点**：
- ✅ 不再看到批量触发规则执行的日志
- ✅ 规则执行已在数据同步时通过事件驱动模式触发
- ✅ 不会重复执行规则

---

### 验证 4：性能对比

#### 步骤 1：对比执行时间

**优化前**：
- 执行账户数：36个
- 执行时间：~5分钟+
- 超时账户：26个

**优化后**：
- 执行账户数：1个（如果规则指定了账户）
- 执行时间：~5分钟（但分散在15分钟内）
- 超时账户：0个

**验证方法**：
```javascript
// 记录开始时间
const startTime = Date.now()

// 执行规则
import('./server/services/cronService.js').then(async (m) => {
  await m.manualExecute(true)
  const duration = Date.now() - startTime
  console.log(`⏱️  总耗时: ${duration}ms`)
})
```

**预期结果**：
- ✅ 执行时间大幅减少（从5分钟+减少到几秒，因为只执行1个账户）
- ✅ 没有超时问题

---

## 📊 验证清单

### ✅ 反向索引优化

- [ ] 规则指定了 `accountId` 时，只在该账户上执行
- [ ] `📋 目标账户: 1 个`（而不是36个）
- [ ] 只有1个账户获取锁并执行规则
- [ ] 其他35个账户不会被触碰

### ✅ 事件驱动优化

- [ ] 数据同步完成后，立即看到 `🔄 [账户 A] 数据同步完成，立即触发规则执行（AdsPolar 事件驱动）`
- [ ] 规则执行在数据同步后立即开始
- [ ] 规则执行不阻塞数据同步流程
- [ ] 定时任务中不再批量触发规则执行

### ✅ 性能提升

- [ ] 执行账户数从36个减少到1个
- [ ] 执行时间大幅减少
- [ ] 没有超时问题

---

## 🔍 详细验证脚本

### 完整验证脚本

```javascript
// 在 Node.js REPL 中执行
(async () => {
  console.log('='.repeat(50))
  console.log('🔍 AdsPolar 优化验证')
  console.log('='.repeat(50))
  
  // 1. 验证反向索引优化
  console.log('\n📋 验证 1: 反向索引优化')
  const cronService = await import('./server/services/cronService.js')
  await cronService.manualExecute(true)
  
  // 2. 验证事件驱动优化
  console.log('\n📋 验证 2: 事件驱动优化')
  const ingestorService = await import('./server/services/ingestorService.js')
  await ingestorService.unifiedHeartbeatSync()
  
  console.log('\n✅ 验证完成')
})()
```

---

## ⚠️ 常见问题

### 问题 1：仍然看到36个账户执行

**可能原因**：
- 规则没有指定 `accountId`（`account_id` 为 NULL）
- 或者有多个规则，其中一些没有指定 `accountId`

**解决方法**：
```sql
-- 检查规则是否指定了 accountId
SELECT id, rule_name, account_id 
FROM rules 
WHERE enabled = 1;

-- 如果 account_id 为 NULL，规则会在所有账户上执行
-- 如果 account_id 不为 NULL，规则只在该账户上执行
```

---

### 问题 2：没有看到事件驱动日志

**可能原因**：
- 数据同步没有实际更新（`dataUpdated = false`）
- 或者事件驱动代码没有执行

**解决方法**：
```sql
-- 检查最近的数据更新
SELECT account_id, COUNT(*) as count, MAX(synced_at) as last_sync
FROM ad_snapshots
WHERE synced_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
GROUP BY account_id
ORDER BY last_sync DESC;
```

---

### 问题 3：规则执行仍然很慢

**可能原因**：
- 规则评估逻辑本身很慢（查询数据库、计算等）
- 或者数据库查询没有优化

**解决方法**：
- 检查规则评估的数据库查询
- 添加索引优化查询性能

---

## 📝 验证结果记录

### 验证时间：__________

### 反向索引优化

- [ ] ✅ 通过：只执行1个账户
- [ ] ❌ 失败：仍然执行36个账户

**日志截图**：
```
[粘贴日志]
```

---

### 事件驱动优化

- [ ] ✅ 通过：数据同步后立即触发规则
- [ ] ❌ 失败：没有看到事件驱动日志

**日志截图**：
```
[粘贴日志]
```

---

### 性能提升

- [ ] ✅ 通过：执行时间大幅减少
- [ ] ❌ 失败：执行时间没有明显改善

**性能数据**：
- 优化前：__________
- 优化后：__________

---

## 🎯 总结

### 验证优先级

1. **优先级 1**：反向索引优化（最重要）
   - 验证是否只执行1个账户（而不是36个）

2. **优先级 2**：事件驱动优化
   - 验证是否在数据同步时立即触发规则

3. **优先级 3**：性能提升
   - 验证执行时间和超时问题

---

**创建时间**：2026-01-27  
**验证版本**：AdsPolar Pipeline Architecture v1.2
