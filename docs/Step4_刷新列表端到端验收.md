# Step 4：刷新列表端到端验收

> **目标**：验证「刷新列表」按钮已正确接入后端，点刷新 → 调用 `POST /api/sync/structure` → 列表从 `structure_ads` 重载。

---

## 一、本次验证内容

| 环节 | 说明 |
|------|------|
| 前端 | RuleManager 选择器旁的「刷新列表」按钮 |
| 调用 | `facebookApi.syncStructure(accountId)` → `POST /api/sync/structure` |
| 后端 | 拉取 FB ads → upsert `structure_ads` → 返回 synced_count |
| 列表 | `refreshScopeItems()` → `GET /api/structure/ads` 查 `structure_ads` |

---

## 二、验收步骤（约 3 分钟）

1. **启动服务**：`npm run dev:server`（或 `dev`）
2. **登录**：浏览器打开前端，登录后进入规则管理
3. **选账户**：选择任一广告账户，等待选择器列表加载
4. **点刷新**：点击「刷新列表」按钮
   - 预期：按钮短暂显示「加载中...」，随后列表重载
   - 异常：429 冷却中 / 409 锁占用 → 弹窗提示
5. **网络验证**（可选）：F12 → Network，筛选 XHR
   - 点刷新时应看到：`POST /api/sync/structure` 200
   - 随后：`GET /api/structure/ads?account_id=act_xxx&...` 200

---

## 三、最小自动化测试

结构同步接口已有单测（`structureResolveSync.test.js` 中的 sync 用例）。  
刷新列表为前端调用链，端到端建议手动验收。

---

## 四、常见问题

| 现象 | 可能原因 | 处理 |
|------|----------|------|
| 429 冷却中 | 2 分钟内重复点击 | 等待 2 分钟后再试 |
| 409 锁占用 | 该账户正在同步 | 稍后重试 |
| 列表无变化 | 该账户 structure_ads 已是最新 | 正常，FB 无新数据 |
| User request limit | FB API 限流 | 等待约 1 小时后再试 |
