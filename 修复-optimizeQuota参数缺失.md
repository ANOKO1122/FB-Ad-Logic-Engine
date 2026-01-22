# 修复：syncAllAccountsSlidingWindow 缺少 optimizeQuota 参数

> **修复时间**：2026-01-21  
> **优先级**：高（会导致运行时错误）  
> **状态**：✅ 已完成

---

## 🐛 问题描述

### 问题现象
- 在 `syncAllAccountsSlidingWindow` 函数内部（第 758 行），调用了 `syncAccountSlidingWindow` 并传递了 `optimizeQuota` 参数
- 但函数签名（第 702 行）没有声明 `optimizeQuota` 参数
- 导致运行时错误：`ReferenceError: optimizeQuota is not defined`

### 影响范围
- **严重性**：高
- **影响功能**：每 30 分钟执行的滑动窗口同步任务会崩溃
- **影响数据**：归因延迟修复功能无法正常工作，可能导致数据不完整

---

## ✅ 修复方案

### 修复内容
1. **修改函数签名**：为 `syncAllAccountsSlidingWindow` 添加 `optimizeQuota` 参数（默认 `false`）
2. **更新 JSDoc 注释**：添加参数说明

### 修改文件
- `server/services/ingestorService.js`（第 702 行）

### 修改前后对比

**修改前：**
```javascript
export async function syncAllAccountsSlidingWindow(daysBack = 7) {
  // ...
  const result = await syncAccountSlidingWindow(accountId, ownerId, timezoneName, daysBack, optimizeQuota)
  // ❌ optimizeQuota 未定义
}
```

**修改后：**
```javascript
export async function syncAllAccountsSlidingWindow(daysBack = 7, optimizeQuota = false) {
  // ...
  const result = await syncAccountSlidingWindow(accountId, ownerId, timezoneName, daysBack, optimizeQuota)
  // ✅ optimizeQuota 已定义，默认 false
}
```

---

## 🔍 验证步骤

### 1. 代码检查
- ✅ 函数签名已添加 `optimizeQuota` 参数
- ✅ JSDoc 注释已更新
- ✅ 函数内部正确使用参数
- ✅ 无 linter 错误

### 2. 调用点检查
- ✅ `cronService.js:259` 调用 `syncAllAccountsSlidingWindow()` 无需修改（使用默认值）
- ✅ 向后兼容：现有调用不受影响

### 3. 运行时验证（建议执行）
```bash
# 1. 启动服务器
npm run dev:server

# 2. 观察定时任务日志（每 30 分钟执行一次）
# 应该看到：
# "🔄 开始同步所有账户的滑动窗口数据（修复归因延迟）..."
# 没有 "ReferenceError: optimizeQuota is not defined" 错误

# 3. 手动触发测试（可选）
# 在 cronService.js 中添加临时测试代码，或创建测试脚本
```

---

## 📝 后续建议

### 可选优化：开启配额优化
如果需要开启配额优化（只拉取近 N 天有数据的广告），可以修改 `cronService.js`：

```javascript
// 当前（默认关闭优化）
await syncAllAccountsSlidingWindow()

// 开启优化（可选）
await syncAllAccountsSlidingWindow(7, true)
```

**注意**：
- 默认策略是关闭优化（`optimizeQuota = false`），避免过度筛选
- 建议先观察系统运行情况，再决定是否开启
- 如果广告量增大或配额紧张，可以考虑开启

---

## 🎯 相关文件

- **修复文件**：`server/services/ingestorService.js`
- **调用文件**：`server/services/cronService.js`
- **相关函数**：`syncAccountSlidingWindow`（已支持 `optimizeQuota` 参数）

---

## ✅ 修复完成

- ✅ 函数签名已修复
- ✅ JSDoc 注释已更新
- ✅ 向后兼容性已保证
- ✅ 无 linter 错误

**下一步**：建议观察系统运行 24-48 小时，确认定时任务正常执行。

